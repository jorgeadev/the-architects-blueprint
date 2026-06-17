---
title: "# The Last Millisecond: Building Terabit-Scale Load Balancers with eBPF and XDP"
shortTitle: "Terabit-Scale Load Balancing with eBPF and XDP"
date: 2026-06-17
image: "/images/2026/06/17/the-last-millisecond-building-terabit-scale-load-balancers-w.jpg"
---

You have **10 million packets per second** screaming toward your infrastructure. Each one carries a user’s request—a payment, a video stream, a critical API call. Your load balancer has roughly **67 nanoseconds** to decide: _forward, drop, or modify_. Miss that window, and your NIC buffer overflows. Packets vanish. Users rage. Engineers get paged at 3 AM.

This is the reality of modern cloud-scale networking. And for years, we’ve been fighting it with a dirty secret: **we copy packets**.

Every time a packet hits the kernel’s network stack, it gets copied from NIC memory to kernel memory, then to user-space buffers. When you’re moving 1 Tbps of traffic, those copies become a tax measured in microseconds—eternity at line rate. A single memory copy at 100 Gbps can add **hundreds of nanoseconds** of latency. At 400 Gbps? You lose.

So how do you build a load balancer that handles **terabit-class traffic** without drowning in copies? You stop copying. You use **eBPF** and **XDP** to hijack the fastest path in the kernel. You build a **zero-copy data plane** that lives in the NIC driver, runs at line rate, and never touches the kernel stack unless absolutely necessary.

Welcome to the bleeding edge. Let’s build it.

---

## The Crisis: Why Traditional Load Balancers Hit the Wall

Before we dive into zero-copy, let’s understand why the world’s biggest infrastructure shops (Cloudflare, Netflix, Uber, Meta) abandoned traditional approaches like **HAProxy**, **nginx**, or hardware load balancers.

### The Kernel Tax

Every packet entering a typical Linux server:

1. Hits the **NIC** → DMA transfer to **Rx ring buffer** (first copy)
2. **IRQ** fires → kernel **hardirq** handler → copies to `sk_buff` structure (second copy)
3. **Softirq** → **Netfilter** chains → **iptables/nftables** checks (third copy)
4. **TCP stack** → reassembles, checksums, timestamps (fourth copy)
5. **Socket buffer** → `recvfrom()` system call → **user-space** (fifth copy)

**Result**: A single packet crossing a 32-core server at 10 Gbps can consume **2.5 microseconds** just in copies. At 100 Gbps, that’s 25 microseconds per packet. Your load balancer becomes a bottleneck before it even _looks_ at the flow.

### The State Explosion

Traditional load balancers keep connection state in user-space: flow tables, session stickiness, health checks. At 100 million concurrent connections, a hash table of 64-byte entries eats **6.4 GB of RAM**. Worse, every new connection requires a system call, a hash computation, and a memory allocation. The kernel’s TLB and cache lines get thrashed like a bad day at DEF CON.

### The Hardware Trap

Hardware load balancers (F5s, A10s, etc.) solve the speed problem but introduce **vendor lock-in**, **insane cost**, and **static programmability**. Try adding a custom DDoS filter or a new encapsulation protocol to an ASIC-based box. You’ll wait 18 months for a firmware update. Meanwhile, your SaaS product needs to launch _next week_.

Enter **eBPF** and **XDP**: the software-defined data plane that moves at hardware speed.

---

## Zero-Copy in Motion: How eBPF and XDP Rewrite the Rules

### What is XDP (eXpress Data Path)?

XDP is a programmable **kernel bypass**—but not in the way DPDK or RDMA do it. Instead of kicking the kernel out entirely, XDP inserts a **hook** at the earliest possible point in the packet processing pipeline: **right after the NIC DMA transfer, before a single `sk_buff` is allocated**.

Here’s the magic:

- **No memory copies**. The packet stays in the **NIC ring buffer** memory (DMA region). XDP programs run directly on that raw memory.
- **No kernel stack overhead**. No TCP handshake, no socket lookup, no `syscall`.
- **Line rate processing**. XDP runs in the **driver context** (or even in hardware, via **XDP hardware offload**). At 100 Gbps, you can process **148 million packets per second** on a single core if the program is simple enough.

### The Core Architecture

Let’s visualize the difference:

```
Traditional stack:
NIC → DMA → sk_buff alloc → Netfilter → TCP → socket → user-space

XDP zero-copy stack:
NIC → DMA → XDP hook (raw memory) → XDP verdict: DROP, PASS, TX, REDIRECT
          ↑           ↑
   No copy    No kernel
```

An XDP program runs **before** the kernel even knows a packet exists. It receives a `struct xdp_md` containing pointers to the raw packet data (in the DMA region), the ingress interface, and the RX queue. It returns one of five verdicts:

- **XDP_DROP**: Silently discard the packet. No stack, no log, no overhead. Ideal for DDoS filtering.
- **XDP_PASS**: Let it proceed to the normal kernel stack. Useful for host-local traffic.
- **XDP_TX**: Transmit the packet back out _the same interface_. For hairpinning or forwarding.
- **XDP_REDIRECT**: Send the packet to a **different NIC** or **another CPU** via `bpf_redirect_map()`. This is the core of terabit-scale load balancing.
- **XDP_ABORTED**: Bug. Kernel panic. Don’t use this in production.

### eBPF as the Control Plane

XDP programs are written as **eBPF bytecode**—a RISC-like instruction set that runs in a **safe, verifiable** kernel sandbox. The verifier checks for:

- Bounded loops (no infinite loops)
- No direct memory access outside packet boundaries
- Limited instruction count (originally 4096, now up to 1M via `BPF_F_LOAD_TIME` with **bounded tail calls**)

eBPF maps allow the program to read/write **shared data structures** (hash maps, arrays, per-CPU counters) without locking. The control plane (a user-space daemon) populates these maps with:

- Backend IP: port mappings
- Health check status (alive/dead)
- Flow state tables
- Rate limit configurations

The XDP program **never makes system calls**. It reads maps, inspects packets, and returns a verdict—all in **nanoseconds**.

---

## Building the Terabit-Scale Data Plane

Let’s walk through a real-world implementation: **A zero-copy, stateless load balancer** that handles 1 Tbps across 10x 100 Gbps NICs.

### Step 1: The Ingestion Pipeline

We’ll use `AF_XDP` sockets—a **zero-copy** alternative to `AF_PACKET` that lets user-space directly read/write the NIC ring buffer without copies.

```c
// Pseudo-code: XDP program that load-balances via IP header hashing

struct bpf_elf_map backend_map = {
    .type = BPF_MAP_TYPE_DEVMAP_HASH,
    .key_size = sizeof(u32),       // flow hash
    .value_size = sizeof(int),     // target NIC index
    .max_elem = 1000000,
};

SEC("xdp")
int lb_program(struct xdp_md *ctx) {
    void *data = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    // Parse Ethernet/IP headers
    struct ethhdr *eth = data;
    if (eth + 1 > data_end) return XDP_DROP;

    struct iphdr *ip = data + sizeof(*eth);
    if (ip + 1 > data_end) return XDP_DROP;

    // 4-tuple hash for flow affinity
    u32 hash = ip->saddr ^ ip->daddr ^ ip->protocol;
    hash ^= (hash >> 16) ^ (hash >> 8);

    // Lookup target NIC in DEVMAP
    int *ifindex = bpf_map_lookup_elem(&backend_map, &hash);
    if (!ifindex) return XDP_DROP; // no backend? drop

    // Redirect without copying
    return bpf_redirect_map(&backend_map, hash, 0);
}
```

**Critical details:**

- We use `bpf_redirect_map()` with `BPF_MAP_TYPE_DEVMAP_HASH`. This redirects the packet to a **different NIC’s egress queue**—zero copy, zero kernel involvement.
- The hash is computed **once** per flow. All subsequent packets with the same hash go to the same backend. **No per-connection state** in the data plane.
- The DEVMAP stores **target NIC indices** (NIC2, NIC3, etc.) not IP addresses. This avoids an ARP lookup—we’re redirecting **at the NIC level**.

### Step 2: Handling Backend Failures

You can’t have a static hash in production. Backends die. Traffic spikes. You need **consistent hashing** with **bounded load redistribution**.

We use **Rendezvous hashing** (a.k.a. highest random weight) implemented in eBPF:

```c
// For each backend, compute a hash of (flow_key + backend_id)
// Weight by power of 2 to avoid modulo bias
u32 best_weight = 0;
int best_backend = -1;
for (i = 0; i < num_backends; i++) {
    // Use bpf_map_lookup to get backend's current load/weight
    u32 hash = jhash(&flow_key, 4, backends[i].seed);
    u32 weight = (hash * backends[i].capacity) >> 16;
    if (weight > best_weight) {
        best_weight = weight;
        best_backend = i;
    }
}
```

**Performance note**: This loop has an upper bound (100 backends). The eBPF verifier will allow it because the loop count is known at compile time (unrolled).

**But wait**: What if we have 10,000 backends? We can’t unroll 10,000 iterations—the program would exceed instruction limits. Solution: **bpf_tail_call()**.

```c
// Chunk the backend list into 100-backend groups
for (group = 0; group < NUM_GROUPS; group++) {
    bpf_tail_call(ctx, &backend_group_progs, group);
}
```

Each tail call jumps to another eBPF program that processes 100 backends. The kernel stores the return address, so after the 5th call, the final program returns `XDP_REDIRECT` and the entire chain unwinds. **No stack overflow, no exceeding instruction limits.**

### Step 3: DDoS Mitigation at Line Rate

An XDP program can **rate-limit per source IP** using `BPF_MAP_TYPE_LRU_HASH`:

```c
struct bpf_elf_map rate_map = {
    .type = BPF_MAP_TYPE_LRU_HASH,
    .key_size = sizeof(u32), // source IP
    .value_size = sizeof(u64), // packet count + timestamp
    .max_elem = 1000000,
};

SEC("xdp")
int ddos_filter(struct xdp_md *ctx) {
    u32 src_ip = ...; // parse from packet
    u64 *entry = bpf_map_lookup_elem(&rate_map, &src_ip);

    u64 now = bpf_ktime_get_ns();
    u64 rate_pps = (entry) ? calc_pps(entry, now) : 0;

    if (rate_pps > RATE_LIMIT) return XDP_DROP; // DDoS suspect

    // Update rate counter with atomic operation
    if (entry) {
        __sync_fetch_and_add(entry, 1);
    } else {
        u64 init = 1;
        bpf_map_update_elem(&rate_map, &src_ip, &init, BPF_NOEXIST);
    }
    return XDP_PASS;
}
```

**Key insight**: This filter runs **before** the packet hits any other processing. A SYN flood from 1 million IPs? Each packet takes ~50 nanoseconds to drop. Your NIC sees the traffic, but the kernel never does. The CPU stays idle.

---

## Real-World Deployment: The Unseen Complexity

### NUMA Affinity and Cache Locality

At terabit speeds, **cache misses kill performance**. Each NIC RX queue must be pinned to a specific core, and that core must be on the same **NUMA node** as the NIC. Otherwise, the CPU must access memory across the QPI/UPI bus—adding 100-200 ns of latency per packet.

Deployment config:

```
# Example: Pin RX queue 0 to core 0 on NUMA node 0
ethtool -L eth0 combined 16       # 16 RX queues
ethtool -X eth0 equal 16          # RSS hash distribution
```

Then, in the eBPF program, use `bpf_get_smp_processor_id()` to determine which CPU we’re on and redirect packets to a per-CPU backend pool. **No cross-NUMA memory access** in the hot path.

### The Page Fault Bomb

Traditional load balancers allocate flow state on the heap. At 10 million new flows per second, each allocation triggers a page fault. The kernel’s memory management becomes a serialization bottleneck.

**Solution**: Pre-allocate huge pages (1 GB, 2 MB) for eBPF maps. Use `BPF_MAP_TYPE_PERCPU_ARRAY` for per-CPU counters—no locking, no cache line bouncing.

```c
struct bpf_elf_map per_cpu_stats = {
    .type = BPF_MAP_TYPE_PERCPU_ARRAY,
    .key_size = sizeof(u32),
    .value_size = sizeof(struct flow_stats),
    .max_elem = 1024,
};
```

With `PERCPU_ARRAY`, each core writes to its own memory region. The control plane aggregates counters by reading from all CPUs once per second. **No atomic operations in the data plane.**

### The Hidden Cost of Context Switching

Even with XDP, you can’t avoid the fact that **eBPF programs run in interrupt context**. If your program exceeds the `~4,000` instruction limit (or the newer `1,000,000` with tail calls), the verifier rejects it. But more subtly: if your program uses `bpf_map_lookup_elem()` and the map is in **slow memory** (like a hash map with 1M entries), the cache miss rate explodes.

**Benchmark reality**:

- Simple XDP DROP program: **4-5 ns** per packet (cache resident)
- Hash lookup with 1M entries: **80-120 ns** per packet (L3 miss)
- `bpf_redirect_map()` to DEVMAP: **50-100 ns** per packet (needs to access egress queue)

At 10 million packets per second that’s **1-2 microseconds** of CPU time per packet. On a 64-core machine, that’s **6.4 billion cycles** per second—well within budget for a modern 2.5 GHz server (160 billion cycles/second total).

**The catch**: You need to **amortize map lookups**. Group packets by flow and process them in batches. Use `bpf_perf_event_output` to send batches to user-space for complex decisions, while the XDP program does simple fast-path routing.

---

## When Zero-Copy Isn’t Enough: The Control Plane Revolution

The data plane is blazing fast, but the control plane (what Cloudflare calls the **“global load balancer”**) needs to handle:

- Health checks (TCP connects to backends every 1 second)
- Weight adjustments (when a backend’s CPU spikes)
- Flow migration (moving long-lived connections from dying backends)

Here’s where we use **eBPF’s `BPF_MAP_TYPE_SOCKHASH`** and **`BPF_MAP_TYPE_STREAM_PARSER`** to **offload control plane logic into the kernel**.

### Health Checks Without Context Switches

Traditional health checks require a user-space process to `connect()` to each backend every second—hundreds of thousands of system calls per second. Instead, use `BPF_PROG_TYPE_SOCK_OPS`:

```c
// Attach to connect() calls from the health checker
SEC("sockops")
int health_check_prog(struct bpf_sock_ops *skops) {
    // At tcp_connect completion, update backend status
    if (skops->op == BPF_SOCK_OPS_TCP_CONNECT_CB) {
        u32 dst_ip = skops->local_ip4; // or remote
        bpf_map_update_elem(&health_map, &dst_ip, STATUS_ALIVE, BPF_NOEXIST);
    }
    if (skops->op == BPF_SOCK_OPS_ACTIVE_ESTABLISHED_CB) {
        // Connection succeeded, update status
        u32 dst_ip = skops->remote_ip4;
        u8 status = STATUS_ALIVE;
        bpf_map_update_elem(&health_map, &dst_ip, &status, BPF_EXIST);
    }
    return 0;
}
```

Now, the health checker doesn’t wait for a reply. The eBPF program intercepts the `connect()` syscall itself and updates the map **before the handshake completes**. The data plane reads `health_map` in its XDP program—if a backend is dead, it’s removed from the hash ring instantly.

### Flow Migration with Stateful eBPF

Long-lived TCP connections (SSH, WebSockets) can’t be broken when a backend dies. You need to **migrate the flow’s state** to a new backend—without breaking TCP sequencing.

Solution: Use **`BPF_MAP_TYPE_XSKMAP`** with `AF_XDP` sockets to intercept the TCP stream at the load balancer, rewrite sequence numbers, and forward to the new backend.

```c
struct bpf_elf_map conn_state = {
    .type = BPF_MAP_TYPE_HASH,
    .key_size = sizeof(struct flow_key),
    .value_size = sizeof(struct migrated_conn),
    .max_elem = 50000000, // 50M concurrent migrations
};

SEC("xdp")
int migration_program(struct xdp_md *ctx) {
    struct flow_key key = ...; // extract 5-tuple
    struct migrated_conn *conn = bpf_map_lookup_elem(&conn_state, &key);

    if (conn) {
        // Rewrite TCP sequence/ack to sync with new backend
        struct tcphdr *tcp = ...; // parse
        tcp->seq -= conn->old_seq_offset;
        tcp->ack_seq -= conn->old_ack_offset;

        // Recompute checksum (incremental update)
        // Redirect to new backend's NIC
        return bpf_redirect_map(&backend_map, conn->new_backend_id, 0);
    }
    // Normal flow
    return bpf_redirect_map(&backend_map, hash(key), 0);
}
```

**This is the secret sauce of Cloudflare’s Unimog**: a stateful data plane that operates at line rate by storing migration metadata in eBPF maps. The kernel handles TCP checksums and window scaling—the XDP program just rewrites headers.

---

## The Hardware Frontier: XDP Offloading

The dream? Run XDP programs **directly on the NIC’s processor**. Modern NICs (Mellanox ConnectX-6, Broadcom NetXtreme-E, Intel E810) support **XDP hardware offload** via eBPF.

- **Pros**: Line rate at 400 Gbps. Zero CPU overhead. No kernel interaction at all.
- **Cons**: Limited instruction count (~256). No map support. Only simple stateless filters.

**Reality**: Cloudflare uses hardware offload for **DDoS signature matching** (drop SYN floods by pattern), while the full load balancer runs on the host CPU with software XDP. The host CPU is fast enough for 100 Gbps—hardware offload is for the 800 Gbps aggregate at Edge nodes.

---

## The Monsters Under the Bed: Debugging Zero-Copy

When your data plane runs in kernel interrupt context, debugging is a nightmare. A single buggy eBPF program can take down the entire NIC.

**Tooling that saves lives**:

- `bpftool prog list`: List loaded programs
- `bpftool map dump`: Dump map contents without affecting performance
- `perf top -e cycles:pp`: Profile eBPF programs in real-time
- **XDP dump**: `bpftool net list` shows which interfaces have XDP attached
- **BCC** `xdp_dropcnt.py`: Count drops per verdict

**Critical safety mechanism**: **`BPF_PROG_TYPE_XDP_FRAGS`** (Linux 5.10+) allows the program to indicate that it can handle fragmented packets. Without it, the kernel linearizes the packet (copy!) before your program runs. **Forget to set this flag, and your zero-copy data plane becomes a copy-copy data plane.**

---

## The Bottom Line: Should You Do This?

Let’s level with each other. Building a zero-copy eBPF load balancer is like building a Formula 1 engine in your garage: technically feasible, immensely satisfying, and almost certainly overkill for 99% of workloads.

**Do this if**:

- You need **>100 Gbps** throughput from commodity servers
- Your latency budget is **<10 microseconds** (including wire time)
- You have a dedicated team of kernel/network engineers
- You’re operating at Cloudflare/Netflix scale (100+ Gbps per server)

**Don’t do this if**:

- You’re running 1 Gbps links (kernel stack works fine)
- You don’t have `bpftool` installed at the OS level
- Your production servers run kernel < 4.19 (no XDP support)
- You need to deploy in a multi-tenant environment without kernel-level isolation

### The Future

As eBPF evolves, the boundary between data plane and control plane blurs. We’re already seeing:

- **eBPF-based service meshes** (Cilium, Istio with ebpf)
- **XDP for Kubernetes load balancing** (kube-proxy replacement)
- **Hardware-software co-design** where XDP programs are compiled to FPGA gateware

The next frontier? **Terabit-scale load balancing with zero-copy QUIC termination**. XDP programs that manipulate TLS 1.3 handshakes at line rate. **That** will be the day.

---

_The load balancer is the single point of failure that must never fail. Zero-copy data planes with eBPF give us the speed of ASICs with the flexibility of software. It’s not easy. But when you’re processing 10 million packets per second and the NIC never complains, you know you’ve won._

**Now go delete your iptables rules. You won’t need them anymore.**

---

**Further reading:**

- [Cilium: eBPF and XDP Reference Guide](https://docs.cilium.io/en/latest/bpf/)
- [Cloudflare: Unimog - The load balancer that makes everything fast](https://blog.cloudflare.com/unimog-load-balancer/)
- [Netflix: How Netflix leverages eBPF for packet processing](https://netflixtechblog.com/)
- [The eBPF Verifier: A Formal Analysis](https://www.kernel.org/doc/html/latest/bpf/verifier.html)
