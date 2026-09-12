---
title: "The Disk That Wasn't There: Engineering Hyperscale Ephemeral Block Storage for Serverless"
shortTitle: "Engineering Hyperscale Ephemeral Block Storage for Serverless"
date: 2026-09-12
image: "/images/2026/09/12/the-disk-that-wasn-t-there-engineering-hyperscale-ephemeral-.svg"
---

Here's a fun paradox to start your morning: the serverless revolution promised us a world without servers. What it quietly delivered instead was a world with _more_ servers than ever — just none that you have to think about. And every single one of those invisible machines, from the moment it boots to the moment it's reaped, is screaming for one thing: **a disk that doesn't exist yet.**

I'm talking about ephemeral block storage — the scratch space bolted onto a function invocation, the root volume behind a container, the `/tmp` that Lambda hands you. It's the plumbing nobody puts on a conference slide, right up until it becomes the reason your p99 latency chart looks like a ski jump. Let's dig into how this stuff actually works at petabyte scale, why the hype around "function-local storage" is both overblown and underappreciated, and what happens when you try to make a temporary disk that is simultaneously **faster than local NVMe and more durable than the hardware it lives on**.

---

## The Weird Contract of Ephemeral Storage

Start with the contract, because ephemeral storage has one of the strangest SLAs in all of computing. It's roughly:

> "This disk will be blazing fast, it will exist for somewhere between 50 milliseconds and 15 minutes, it may vanish without warning, and if you store anything on it that you care about, you deserve what happens to you."

And yet. **Ephemeral storage is load-bearing for the entire serverless economy.** Package extraction, model weight shingling, Spark shuffle spills, build caches, video transcoding scratch, SQLite temp tables, JIT warmup artifacts — an enormous fraction of real workloads do their dirtiest work on scratch disks that are supposed to be disposable.

The interesting engineering problem isn't "how do we store bytes cheaply." It's this: **how do you build a storage layer that behaves like it's local, survives like it's distributed, and costs like it's free?** Those three properties are in open warfare with each other, and every hyperscaler resolves the conflict differently.

---

## Why This Got Hyped (And What the Hype Missed)

Flash back a couple of years. The serverless world was in a tizzy about **cold starts**, and the narrative was simple: functions are slow to start because they have to download your code, unpack it, and warm up a runtime. So the industry did the obvious thing — threw faster storage at the problem. Local NVMe, memory-backed volumes, pre-warmed sandboxes.

Then the second wave hit: **"serverless needs a real disk."** People wanted stateful functions. They wanted to run databases in Lambda. They wanted GPUs attached to ephemeral scratch for inference. And the cloud vendors, smelling blood in the water, started shipping things that blurred the line — mountable file systems for functions, temporary volumes attached to container instances, block storage that lived for exactly as long as your workload did.

Here's what the hype cycle got _right_: ephemeral storage is genuinely the bottleneck for a huge class of workloads.

Here's what it got _wrong_: the assumption that the fix is "just give the VM a bigger local disk." **Local disks don't scale the way serverless scales.** A local NVMe drive is a fixed physical resource welded to a specific host. Serverless fleets are packed and repacked constantly — millions of micro-VMs coming and going per minute across a fleet where the _median_ instance lifetime can be measured in seconds. If every one of those sandboxes demanded a physically dedicated slice of flash, you'd either massively overprovision (expensive) or constantly stall on I/O contention (slow). Neither is acceptable when you're running at the scale of AWS Lambda, Cloudflare Workers, or Google Cloud Run.

So the real architecture isn't "local disk." It's something much stranger.

---

## The Core Trick: Decouple the Block from the Box

The fundamental move in hyperscale ephemeral storage is **separating the block device from the machine serving it**. The sandbox thinks it has a disk. The disk is actually a distributed system wearing a trench coat and a fake mustache.

Here's the rough topology you'll find in most hyperscaler designs, in one form or another:

```
┌─────────────────────────────────────────────────────────┐
│                  Compute Fleet (millions of VMs)         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Sandbox  │  │ Sandbox  │  │ Sandbox  │  │ Sandbox  │ │
│  │  virtio  │  │  virtio  │  │  virtio  │  │  virtio  │ │
│  │  blkdev  │  │  blkdev  │  │  blkdev  │  │  blkdev  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
└───────┼─────────────┼─────────────┼─────────────┼───────┘
        │             │             │             │
        ▼             ▼             ▼             ▼
┌─────────────────────────────────────────────────────────┐
│         Storage Frontend / Block Gateway Layer           │
│   (RDMA, SR-IOV, NVMe-oF, custom protocols)             │
└───────┬─────────────┬─────────────┬─────────────┬───────┘
        │             │             │             │
        ▼             ▼             ▼             ▼
┌─────────────────────────────────────────────────────────┐
│      Distributed Log + Chunk Store + Metadata Plane      │
│   (erasure coded, replicated, tiered across NVMe/SSD)    │
└─────────────────────────────────────────────────────────┘
```

The sandbox sees a block device. Under the hood, writes hit a **distributed log**, get chunked, erasure-coded, and spread across a storage fleet. The whole thing is stitched together by a **metadata plane** that tracks which chunk lives where, how long it's allowed to exist, and who's allowed to read it.

This is where the "ephemeral" label gets philosophically interesting. The data may be _stored_ durably — replicated across three availability zones, checksummed, versioned — while being _guaranteed_ to disappear on a schedule. **Durability and persistence are not the same property.** You can build a system that's incredibly good at not losing your bytes for the next five minutes, and completely ruthless about garbage-collecting them at minute six.

---

## Latency: The Only Number That Matters

Let's get into the numbers, because "fast" is meaningless without them. When we talk about ephemeral block storage for serverless, we're really chasing four latency budgets:

- **Provisioning latency**: time from "sandbox created" to "block device readable." Target: **sub-millisecond** to low single-digit milliseconds. This is often just attaching a virtual device, not allocating physical space.
- **First-byte read latency**: time to read 4KB from a cold block. Target: **tens of microseconds** on the happy path, single-digit milliseconds on the sad path.
- **Sustained throughput**: what you get when you stop being polite. Modern designs push **1–10 GB/s per sandbox** for the fast tier, with aggregate fleet throughput in the **terabits per second** range.
- **Tail latency (p99.9)**: the only latency your users actually feel. Targets vary, but if you're above **10ms p99.9** on a hot path, someone's going to write a very serious internal document.

The dirty secret is that **the network is no longer the bottleneck** — the _coordination_ is. RDMA and custom silicon have made cross-rack round trips genuinely fast. What kills you is everything _around_ the I/O: lock contention in the metadata plane, garbage collection pauses, tenant isolation bookkeeping, and the delightful reality that your fleet is a shared-nothing system where "shared" is a lie told by the scheduler.

If you squint, ephemeral block storage starts to look a lot like **a distributed database with an unusually aggressive TTL**.

---

## The Metadata Plane Is the Real Product

Here's the counterintuitive bit: in hyperscale ephemeral storage, **the bytes are the easy part**. Flash is cheap and getting cheaper. Erasure coding is a solved problem. RDMA is well-understood. What's genuinely hard is the metadata plane — the thing that answers questions like:

- Which physical chunk holds byte range `[1048576, 1052672)` of sandbox `d4e5f6`'s block device?
- Is that chunk still valid, or was the sandbox reaped 40 milliseconds ago?
- If a storage node holding that chunk just died, how fast can we re-replicate?
- If a tenant's sandbox is migrating across the fleet, how do we hand off the block device without a 200ms stall?

At petabyte scale, the metadata plane becomes **the dominant engineering challenge**. You can't fit it in memory on a single node. You can't afford a round trip to a central coordinator on every I/O. So you end up building something that looks suspiciously like:

```
- A hierarchical, sharded metadata namespace
- Per-sandbox leases with hard TTLs (this is the "ephemeral" part)
- An optimistic concurrency model where stale metadata is detected, not prevented
- A background reaper that walks the TTL index and fires off deletes before the sandbox even knows it's dead
```

The reaper is where a lot of the "magic" lives. **Ephemeral storage only works if deletion is cheap and eventual.** If you had to synchronously free every block when a sandbox terminated, you'd bottleneck on the control plane. Instead, you mark the lease expired, let reads fail fast, and reclaim storage lazily. The block device _appears_ to vanish instantly. The bytes take a few seconds to actually die.

This is also why **ephemeral storage is not a security boundary by itself**. If a hostile tenant can read a reallocated chunk before it's been overwritten, you've got a problem. Every serious implementation does one or more of: cryptographic erasure (throw away the key), zeroing on allocation, or physical isolation of the storage pool per trust domain.

---

## Code Snippet: The Shape of a TTL-Aware Block Lease

Here's a toy sketch of what a per-sandbox block lease might look like in a real system. This isn't production code, but it captures the _shape_ of the contract:

```python
class BlockLease:
    """
    A lease describes the lifetime of an ephemeral block device.
    The sandbox holds a reference; the storage fleet holds the truth.
    """
    def __init__(self, sandbox_id, size_bytes, ttl_ms, trust_domain):
        self.sandbox_id   = sandbox_id
        self.size_bytes   = size_bytes
        self.ttl_ms       = ttl_ms          # hard upper bound on lifetime
        self.trust_domain = trust_domain    # determines storage pool
        self.epoch        = None            # bumped on every re-attach
        self.chunk_map    = {}              # lazily populated as writes land

    def on_write(self, offset, length, data):
        # 1. Check lease validity (cheap, in-memory in the frontend)
        if self.is_expired():
            raise LeaseExpired(self.sandbox_id)

        # 2. Append to the distributed log. Chunking + EC happens
        #    below the frontend; the sandbox never sees this.
        chunk_ids = self._chunk_and_encode(offset, length, data)

        # 3. Async-update the metadata plane. Reads can proceed
        #    optimistically against the log tail.
        self._publish_chunk_map(chunk_ids)

    def on_reap(self):
        # Called by the control plane when the sandbox terminates.
        # Note: this does NOT synchronously free bytes. It invalidates
        # the lease and enqueues the chunks for lazy reclamation.
        self.epoch += 1
        Reaper.enqueue(self.trust_domain, self.chunk_map.values())
```

The two things I want you to notice: **the epoch counter** (so stale reads from a reaped sandbox fail fast instead of leaking data) and **the lazy reaper** (so teardown is O(1), not O(bytes)).

---

## Durability at Petabyte Scale: The Part That Sounds Like a Contradiction

Let's talk about the elephant in the room. **How do you promise durability for data that is explicitly designed to be deleted?**

The answer is: you don't promise _persistence_, but you do promise _integrity_. Concretely, the durability properties you actually want are:

- **No torn writes.** If a sandbox writes 4KB and crashes mid-write, it should see either the old 4KB or the new 4KB — never a chimera.
- **No silent corruption.** Every chunk is checksummed end-to-end. Bit rot is not an excuse.
- **Bounded loss on node failure.** If a storage node dies, in-flight ephemeral data may be lost, but _the sandbox should fail deterministically_, not hang.
- **Fast recovery.** Re-replication targets are aggressive — you want to be back to full redundancy in **seconds, not minutes**, because at petabyte scale, "minutes" means tens of thousands of sandboxes affected by a single rack failure.

To hit those, the standard toolkit applies, but with serverless-specific twists:

- **Erasure coding with small stripe widths.** Wide stripes (say, 10+4) are great for cold storage but terrible for a 4KB random write. Serverless workloads are _random and small_, so you bias toward narrower stripes and more replication at the hot tier.
- **Log-structured writes.** Sequential appends to a distributed log, with compaction in the background. This is what makes tiny writes fast without destroying your flash.
- **Tiered storage.** Hot tier on local NVMe, warm tier on networked NVMe-oF, cold tier on object storage. The ephemeral lifetime of the sandbox means you rarely have to move data past the warm tier — but the _system_ has to be able to, because some sandboxes live longer than they should.
- **Failure-domain-aware placement.** Chunks for a single sandbox are spread across racks and AZs so that a single failure doesn't take out the whole device.

Here's the part that trips people up: **ephemeral storage is often more durable in practice than the local disk on your laptop.** That's not a bug in either system — it's just that hyper-distributed storage with erasure coding and automated repair beats a single consumer SSD every day of the week. The "ephemeral" label is about _lifetime_, not _fragility_.

---

## Compute Scale: The Numbers That Should Make You Sit Down

Let's do some napkin math, because petabyte scale is hard to feel until you count the zeros.

Suppose you're running a serverless platform with **5 million concurrent sandboxes**, each with a 4GB ephemeral block device. That's **20 petabytes of provisioned block storage** — before you count metadata, indices, replicas, and EC overhead. If you're using 1.5x replication on the hot tier and 1.4x erasure coding on the warm tier, you're physically storing **north of 28PB** to serve that 20PB.

Now consider churn. If the median sandbox lifetime is **90 seconds**, you're turning over the entire fleet roughly **40 times per hour**. That's not a storage system — that's a **tidal wave of provisioning and reaping** that has to be invisible to the tenants. At that churn rate, the control plane isn't doing "requests per second." It's doing **millions of lease transitions per second**, most of which are no-ops.

This is why every serious implementation obsesses over:

- **Amortized control plane cost.** Provisioning must be O(1) and mostly local. If your provisioning path requires a quorum round trip, you've already lost.
- **Stateless frontends.** The block gateway is cattle, not pets. It can be killed and restarted without losing leases, because leases are just TTLs in a replicated store.
- **Backpressure that actually works.** When the storage fleet hiccups, the serverless platform needs to **shed load at the scheduler**, not at the block device. A stall in storage should look like a scheduling failure, not a latency spike.

---

## The Cascade Problem (Or: How Ephemeral Storage Chooses Its Failures)

Every distributed storage system has a failure mode it's willing to accept. Ephemeral storage at petabyte scale is fascinating because **the failure modes are chosen, not accidental.**

Take a single rack failure. In a traditional storage system, you'd re-replicate lost chunks and continue. In a serverless ephemeral system, you have a choice:

1. **Re-replicate the chunks.** Slow, expensive, and arguably pointless if the sandboxes owning those chunks are about to die anyway.
2. **Fail the affected sandboxes fast.** Cheap, deterministic, and lets the scheduler reschedule them somewhere healthy.
3. **Do nothing and let the leases expire.** Correct eventually, terrible for latency in the meantime.

Most production systems blend all three, weighted by the _age of the lease_. A sandbox that's 2 seconds old is nearly worthless — fail it. A sandbox that's been running for 10 minutes might be doing real work — re-replicate modestly and let it ride.

This is the **ephemeral storage cascade**: a failure propagates not through the storage layer, but through the **scheduler**, which decides which sandboxes get to survive. That's a very different design philosophy from "durable storage at any cost," and it's why serverless storage teams sit in the same org chart as the compute team.

---

## Where This Is All Going

A few trends worth watching, in no particular order:

- **Memory-backed ephemeral volumes.** DRAM is fast, persistent memory exists, and the line between "scratch disk" and "RAM" is getting blurry. Expect more serverless platforms to offer _RAM-speed ephemeral block_ as a first-class tier.
- **RDMA-native block gateways.** The network is not the bottleneck, so stop pretending it is. Custom silicon and RDMA let block devices behave like local devices across racks — this is the enabling tech behind the "no local disk" architecture.
- **DPU-offloaded storage.** SmartNICs and DPUs are quietly taking over the storage data plane. The sandbox's write doesn't touch the host CPU at all — it goes straight from the guest to the storage fabric.
- **Ephemeral storage as a security primitive.** Short-lived leases with cryptographic erasure are becoming a standard part of the confidential-computing playbook. The data's gone before anyone can subpoena it.
- **The convergence of block, file, and object.** For ephemeral workloads, the distinction is increasingly a client-side API detail. Under the hood, it's all a log.

The unglamorous truth is that **serverless is only as good as its scratch space.** The next time you spin up a function and it feels _instant_, remember: somewhere in a data center you'll never visit, a virtual block device was born, lived a full life, died, and was garbage-collected before your first byte came back to the client. That's not a bug. That's the architecture.

**Build accordingly.**
