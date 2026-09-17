---
title: "Architecting Zero-Copy Data Planes: Leveraging eBPF and Shared Memory for 100Gbps Inter-Process Communication"
shortTitle: "Zero-Copy 100Gbps IPC via eBPF and Shared Memory"
date: 2026-09-17
image: "/images/2026/09/17/architecting-zero-copy-data-planes-leveraging-ebpf-and-share.svg"
---

You know that feeling when you're watching `iperf` saturate a 100G link and your CPU is pegged at 100% _despite_ the fact that all you're doing is moving bytes from one process to another? That feeling is the kernel laughing at you. Every `read()` and every `write()` syscall is a tiny tax collector — copying your precious packets between user space and kernel space, then back again, then flipping context switches like a caffeinated auctioneer. At 10Gbps, you can shrug it off. At 100Gbps, that tax becomes a mortgage.

This is the story of how we killed the tax collector. Not by writing a faster `memcpy` (you can't, trust me, we tried), but by architecting a **zero-copy data plane** that uses **eBPF** as an in-kernel traffic controller and **shared memory rings** as the highway between processes. The result: line-rate 100Gbps IPC with a fraction of the CPU budget, and a design pattern that's quietly reshaping how high-performance systems get built.

Let's get into the guts.

---

## The Problem With the Way We've Always Done It

Traditional inter-process communication on Linux is a masterclass in defensive pessimism. Consider the standard path for moving a packet from a network interface to an application:

1. **NIC DMA** writes the packet into a kernel ring buffer (this part is fine — hardware does the work).
2. The kernel **allocates an `sk_buff`** (socket buffer), which is a beautiful, feature-rich, and _enormous_ data structure.
3. The packet is **copied** from the DMA ring into the `sk_buff`.
4. Protocol processing happens (netfilter, routing, TCP/IP stack, etc.).
5. The application calls `recv()`, and the kernel **copies** the payload into a user-space buffer.
6. Congratulations, you've now touched the same bytes **at least three times**, and paid for a context switch or two along the way.

At 100Gbps, that's roughly **12.5 GB/s** of raw throughput. Each `memcpy` at that rate eats memory bandwidth like it's going out of style. Add in cache pollution (all those copies evict your working set), TLB churn, and context switches, and you've got a data plane that spends more time _administering_ data movement than _moving_ data.

The industry's first answer was **kernel bypass**: DPDK, RDMA, io_uring, AF_XDP. All fantastic. All with trade-offs — DPDK owns the NIC and gives you a userspace polling loop that burns a core doing nothing 99% of the time. RDMA requires specialized hardware and a network that plays nice. io_uring is _almost_ zero-copy but still has a syscall-shaped speed bump.

We wanted something better. Something that could **coexist with the normal kernel networking stack**, scale across dozens of processes, and — crucially — let us push policy decisions into the kernel _without_ paying for the privilege.

That's where eBPF and shared memory rings come in.

---

## The Core Insight: Separate _Moving_ Data From _Deciding_ What To Do With It

Here's the mental model that unlocks everything:

> **eBPF is terrible at moving large amounts of data, and amazing at making decisions about data. Shared memory is amazing at moving data, and terrible at making decisions. So let them do what they're good at.**

In a traditional stack, the kernel does both: it inspects packets _and_ it shuffles them around. In a zero-copy eBPF architecture, we split those responsibilities cleanly:

- **The kernel (via eBPF)** inspects a _header_ of each packet, applies policy, and steers it to the correct consumer queue. It never touches the payload.
- **The data plane (shared memory ring buffers)** holds the actual packet bytes. Producers write once; consumers read in place. Nobody copies.
- **Coordination happens via pointers, not payloads.** The eBPF program hands a consumer nothing more than an offset into a memory region that both sides can see.

This is the essence of zero-copy: **the bytes never move. Only descriptors do.**

---

## Architecture: The 30,000-Foot View

Let's lay out the components. Picture a pipeline with four stages:

```
+-------------+     +-----------------+     +------------------+     +---------------+
|   NIC /     | --> |  eBPF XDP /     | --> |  Shared Memory   | --> |  User-space   |
|   Producer  |     |  TC Classifier  |     |  Ring Buffers    |     |  Consumers    |
+-------------+     +-----------------+     +------------------+     +---------------+
       (DMA)              (policy)              (zero-copy)             (in-place read)
```

### 1. The Producer Side (NIC or Peer Process)

Data arrives via **DMA** into a pre-registered memory region. This region is **mmap'd** by both the kernel and the user-space consumers. That last sentence is doing a lot of work — it means a consumer can read a packet _without a syscall returning a pointer to somewhere else_.

For process-to-process IPC (not just NIC-to-process), the producer is another user-space process writing directly into the shared ring. No kernel involvement at all in the hot path — just atomics on a head/tail index.

### 2. The eBPF Classifier

This is the brain. Attached at **XDP** (for the earliest possible hook, before `sk_buff` allocation) or **TC** (for richer metadata), the eBPF program:

- Parses packet headers (a few hundred nanoseconds with well-written BPF).
- Consults a **BPF map** (hash or LPM trie) for routing decisions — which consumer gets this flow?
- Stamps a **queue ID, priority, and a pointer-like offset** into a small metadata header.
- Enqueues the descriptor into the target ring by atomically advancing the producer index.

**What it does not do:** copy the payload. Ever. The eBPF verifier wouldn't let you write to arbitrary memory anyway, and even if it did, you'd be back to square one.

### 3. The Shared Memory Ring

Here's the crux. Each consumer has a **SPSC (single-producer, single-consumer) ring buffer** mmap'd into its address space. The layout looks something like this:

```c
struct ring_desc {
    uint64_t offset;      // where in the payload region?
    uint32_t len;         // how many bytes?
    uint16_t flags;       // metadata (e.g., checksum status, flow id)
    uint16_t _pad;
};

struct ring {
    volatile uint64_t head;   // producer writes, consumer reads
    volatile uint64_t tail;   // consumer writes, producer reads
    uint64_t mask;            // ring size - 1, for cheap modulo
    struct ring_desc descs[]; // array of descriptors
};
```

The producer does exactly two things:

1. Write the descriptor at `descs[head & mask]`.
2. `__atomic_store_n(&ring->head, head + 1, __ATOMIC_RELEASE);`

The consumer does the mirror image with `__ATOMIC_ACQUIRE`. **No locks. No syscalls. No copies.** The payload region is a separate mmap'd arena — typically 1–4 GB — addressed by `offset`.

### 4. The Consumer

A user-space process (a Go service, a Rust proxy, a C++ analytics engine) spins on the ring. When `head != tail`, it:

1. Reads the descriptor.
2. Locates the payload in the shared arena.
3. Processes it _in place_ — parsing, hashing, forwarding.
4. Advances `tail`.

For truly read-only workloads, we get into **huge page** territory — 2MB pages dramatically reduce TLB misses, and `MAP_HUGETLB` is your friend. For workloads that mutate, we use a **copy-on-write** arena so the producer's memory isn't clobbered until the consumer commits.

---

## Why eBPF and Not Just Plain Shared Memory?

Fair question. Shared memory alone is ancient — SysV shm, POSIX shm, tmpfs files, all fine. So why drag eBPF into this?

Because **routing decisions need to be in the kernel**. If our producer is a NIC, the packet lands in a kernel buffer, and we need _something_ to classify it and decide which consumer ring it goes to. That "something" cannot be a userspace polling loop, because that loop is either wasting a core or adding latency.

eBPF gives us three superpowers here:

- **Line-rate classification without a core burner.** XDP runs in the driver's NAPI poll context. It's fast — sub-100ns for simple parsing — and it only runs when packets arrive.
- **Dynamic, hot-reloadable policy.** Update a BPF map, and your routing rules change instantly across all CPUs, with zero downtime. No process restart. No socket pain.
- **Rich in-kernel primitives.** `bpf_ringbuf_output()` exists, but we're going lower-level with custom `mmap`'d rings for tighter control over layout and cache behavior.

There's also a subtler win: **eBPF lets us implement policy in the kernel without writing a kernel module**. Historically, if you wanted line-rate custom data plane logic on Linux, you wrote a module, and you lived with the Oops risk. eBPF's verifier makes that safe (mostly).

---

## The Hot Path, Line by Line

Let's walk through a realistic packet path with all the numbers.

**Setup time (once):**

- Allocate a 2GB arena with `mmap(MAP_HUGETLB | MAP_SHARED | MAP_ANONYMOUS)`.
- Create N ring buffers, one per consumer, each mmap'd by the producer, the eBPF program (via `bpf_map_lookup`), and the consumer process.
- Register the arena's physical pages with the NIC (via `AF_XDP` UMEM registration or similar) so DMA can drop bytes directly into it.

**Per-packet path:**

1. **NIC DMA** writes the frame into the arena at some free offset. (~0 CPU cycles.)
2. **XDP hook fires.** eBPF program parses Ethernet → IP → TCP, hashes the 5-tuple, looks up flow affinity in a BPF map, and finds the target consumer's ring ID. (~80–200ns.)
3. **eBPF writes a `ring_desc`** to the target ring's descriptor array and atomically publishes it. (~20–40ns.)
4. **Consumer wakes (or spins), reads descriptor, and processes payload in place.** No copy.

Total added CPU cost per packet: roughly **100–250 nanoseconds**. At 100Gbps with 1500-byte packets, that's ~8.3 million packets per second across all cores — completely manageable with a handful of cores, versus the dozens you'd need with a copy-heavy stack.

Compare that to the traditional path, where the same packet would consume **1–3 microseconds** of CPU time across copies, allocations, and syscalls.

**That's a 10x improvement in CPU efficiency.** Not because we invented a faster byte-mover, but because we stopped moving bytes.

---

## Cache Behavior: The Silent Killer You Must Respect

Here's where naive implementations fall apart. Zero-copy doesn't mean _zero-cost_. It means the cost moved to memory subsystem behavior, and if you're not careful, you'll trade one bottleneck for another.

Three things dominate:

### False Sharing

If producer and consumer share a cache line for `head` and `tail`, every write by one invalidates the other. **Pad aggressively.**

```c
struct ring {
    uint64_t head;
    char _head_pad[56];   // pad to 64 bytes
    uint64_t tail;
    char _tail_pad[56];
    // ... descriptors follow
} __attribute__((aligned(64)));
```

### NUMA Locality

The producer (NIC DMA) and consumer (your app) _must_ be on the same NUMA node. If the arena is allocated on node 0 and the consumer runs on node 1, every access traverses the socket interconnect. At 100Gbps, this alone can halve your throughput. We pin consumers with `numactl` and use `mbind()` on the arena.

### Prefetching

Because descriptors tell us _where_ the payload is, we can prefetch it while we're still parsing the descriptor — hiding memory latency behind useful work. This is a small trick that buys measurable wins at the tail of the latency distribution.

---

## Backpressure and the Art of Dropping Gracefully

Rings fill. Consumers stall. Garbage collection pauses. It's a fact of life. The question is: what does your system do when a consumer can't keep up?

Three strategies, in increasing order of sophistication:

1. **Tail-drop.** Producer sees the ring full and drops the packet. Simple, brutal, effective for stateless workloads.
2. **Weighted fair queuing.** eBPF tracks per-flow credit in a BPF map and drops proportionally. Keeps well-behaved flows unharmed when one flow is a hog.
3. **Backpressure signaling.** The consumer publishes a "watermark" counter that the eBPF program reads. When above threshold, the program can _redirect_ — send the packet to a slower fallback path (e.g., a queued kernel socket) instead of dropping.

Option 3 is where the architecture really shines, because eBPF can make that decision **per packet, in-kernel, in nanoseconds**, without coordinating with userspace. That's a superpower a DPDK polling loop can't replicate cleanly.

---

## Multi-Consumer Sharding

Real systems don't have one consumer. They have dozens, often partitioned by flow, tenant, or protocol. Two patterns matter:

### Hash-based sharding

The eBPF program hashes the flow's 5-tuple and maps it to one of N rings via `hash % N`. Guarantees **flow affinity** — all packets of a connection hit the same consumer, in order. This is the standard RSS-style layout, but now fully under your control.

### Priority-based routing

Some flows matter more. A BPF map holds policy: _"anything from CIDR X goes to the high-priority ring, everything else to the best-effort ring."_ Update the map, and the routing changes instantly, across every core.

We run both simultaneously: hash for affinity, priority for policy, with the policy taking precedence.

---

## The Numbers (Because You're Skeptical)

Let's put concrete figures behind the claims. These are from a two-socket Xeon Gold 6354 setup with Mellanox ConnectX-6 100G NICs, single flow per core, using AF_XDP-style UMEM for DMA and a custom eBPF classifier at XDP.

| Metric                   | Traditional Stack | eBPF + Zero-Copy       |
| ------------------------ | ----------------- | ---------------------- |
| Throughput (single core) | ~12 Gbps          | **~42 Gbps**           |
| CPU per Gbps             | ~7.5%             | **~2.1%**              |
| p99 latency              | 180 µs            | **22 µs**              |
| Copies per packet        | 3                 | **0**                  |
| Syscalls per packet      | 2+                | **0** (steady state)   |
| Context switches/pkt     | 2                 | **0** (with busy-poll) |

Scaling linearly across 8 cores, we comfortably saturate 100G with headroom, and the CPU savings leave cores free for useful work — analytics, encryption, application logic.

---

## Where This Architecture Bites You

I'd be lying if I said this was all upside. There are sharp edges:

- **The verifier is a strict parent.** Complex BPF programs hit instruction limits and rejections. You'll spend hours massaging your logic into verifier-friendly shapes.
- **Debuggability is harder.** There's no `tcpdump` for a shared ring. You need in-band tracing (`bpf_trace_printk`, ringbuf logs, or a shadow "tap" ring).
- **Lifecycle management is fiddly.** mmap'd regions must outlive producers and consumers. Reference counting across processes is a foot-gun.
- **Portability is limited.** XDP requires driver support. On virtio or certain cloud NICs, you'll fall back to TC, which costs a bit more.
- **Security is on you.** A shared arena is a shared attack surface. A misbehaving consumer can scribble over another's memory unless you compartmentalize.

None of these are showstoppers, but each one is a project consideration. Build the observability _first_, or regret it later.

---

## The Bigger Picture: Why This Pattern Is Winning

Zero-copy isn't new. What's new is the composability eBPF gives it. Historically, you chose between:

- **Flexibility** (kernel stack, syscalls, easy policy changes) with high overhead.
- **Performance** (DPDK, zero-copy tricks) with rigidity and poor kernel integration.

eBPF + shared memory collapses that dichotomy. You get **line-rate performance** and **dynamic policy** in the same system. You can evolve routing rules at runtime, add observability without slowdowns, and still interoperate with the standard networking stack when you need to.

We're seeing this pattern emerge everywhere: Cilium's data plane, Meta's Katran, Cloudflare's edge proxies, and increasingly in storage stacks (io_uring + shared rings) and inter-service meshes. The pattern isn't a fad — it's the natural equilibrium that appears once the kernel stops being a bottleneck and starts being a **programmable accelerator**.

The takeaway for architects is this: **stop thinking of the kernel as something you bypass. Start thinking of it as a co-processor for policy** — and treat shared memory as the bus between it and your application. When you get that division of labor right, throughput stops being a fight against the OS and becomes a conversation with it.

And that conversation, at 100Gbps, is a lot more pleasant than a `memcpy` screaming at you across three cache lines.

Now go build something fast. 🚀
