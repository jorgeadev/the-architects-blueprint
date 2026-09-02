---
title: "The Memory Wall Just Got a Multi-Layered Ladder: Re-Architecting LSM Trees for CXL Disaggregated Pools"
shortTitle: "Re-architecting LSM Trees for CXL Disaggregated Memory"
date: 2026-09-02
image: "/images/2026/09/02/the-memory-wall-just-got-a-multi-layered-ladder-re-architect.svg"
---

**TL;DR:** We are hitting a physical ceiling on DRAM bandwidth and capacity inside the server chassis. Compute Express Link (CXL) is about to shatter that ceiling by disaggregating memory. But your database engine—specifically your **Log-Structured Merge Tree**—is not ready for the latency cliff that comes with it. Here is how we are ripping out the monolithic compaction logic and rebuilding it for a heterogeneous, multi-layered memory pool where **locality isn't a given—it's an engineering choice.**

---

## The Hype Cycle vs. The Silicon Reality

If you’ve been to any cloud infrastructure conference in the last 18 months, you’ve heard the CXL (Compute Express Link) pitch. It’s the messianic technology that promises to turn memory into a pool, just like we did with compute and storage. The hype is deafening: "Pooled Memory", "Memory Expansion", "Tiering at the Speed of Light."

But let’s strip away the marketing gloss. **The hardware is real.** We are seeing 1st and 2nd gen CXL memory controllers shipping. We are seeing switches that allow multiple hosts to access a shared memory fabric. The bandwidth is still a bottleneck (DDR5 offers ~400GB/s per channel group, while CXL 1.1/2.0 typically caps out at ~64GB/s to ~128GB/s per controller), but the _capacity_ increase is undeniable. You can now have a logical address space of **multiple terabytes** that spans local DRAM, CXL-attached DRAM (near and far), and even CXL-attached persistent memory.

This is not incremental. This is a fundamental shift in the memory hierarchy. We are moving from a _tree_ (L1 -> L2 -> Main Memory -> Disk) to a _mesh_ of heterogeneous memory pools.

Now, here’s the problem. Your database engine is not designed for this mesh. Specifically, **your LSM Tree is about to fall off a performance cliff.**

Why? Because LSM Trees are architected on a strict, implicit assumption: **DRAM is fast, and disk is slow.** The entire algorithm revolves around buffering random writes in a sorted in-memory structure to turn them into sequential writes on disk. The moment we introduce CXL, we break that binary assumption. We now have three (or four) distinct performance tiers, and the cost of moving data between them isn't just about latency—it's about **protocol contention** and **page migration granularity**.

Let’s dive into the guts of why a vanilla LSM Tree will choke, and how we are re-architecting it from the ground up to treat CXL not as a slower disk, but as a **coherent, byte-addressable extension of the CPU’s memory map.**

---

## Part 1: Why the Vanilla LSM Tree Breaks Your Fabric

Standard LSM design (think RocksDB, LevelDB, HBase) relies on a few core components:

1.  **Memtable:** A mutable, sorted in-memory structure (usually a skiplist). This is your write hot-spot.
2.  **WAL (Write-Ahead Log):** Sequential write to disk for crash safety.
3.  **SSTables (Sorted String Tables):** Immutable, sorted files on disk.
4.  **Compaction:** The background process that merges the Memtable into SSTables and merges SSTables across levels to eliminate redundancy and maintain read efficiency.

Here is the crux of the problem with CXL: **Compaction is a memory-bandwidth hog.**

In a single-node system, when you flush a Memtable, you are reading from L1/L2 cache and writing to DRAM. That’s microseconds. When you perform a major compaction between Level 1 and Level 2, you are reading large chunks from DRAM, sorting/merging them (which takes CPU cycles), and writing them back to DRAM. In a traditional architecture, that DRAM is local and has massive bandwidth.

Now, imagine your LSM Tree is managing a dataset that exceeds your local DRAM capacity. In a CXL-disaggregated world, you don't spill to disk; you spill to a CXL-attached memory pool. The OS sees it as RAM. Your LSM Tree sees it as `malloc`'d memory.

**The Tragedy:** Because it looks like RAM, the LSM Tree creates SSTables in this CXL memory pool. The block cache also lives there. The Memtable might even spill there.

Suddenly, your "sequential" disk write pattern is actually a **cache-line-level scattered write** across a PCIe fabric. The CXL controller is trying to maintain cache coherence for a 64-byte line, but the LSM is touching hundreds of random locations across a multi-gigabyte pool. The result:

- **Write Amplification via Fabric:** Instead of just rewriting data in-place on disk, you are now saturating the CXL switch’s bandwidth with _coherence traffic_ (Snoop filters, Back-Invalidates).
- **Latency Tail Latency:** A compaction job that was previously predictable now has `us` (microsecond) latency variability depending on whether the physical memory is on a remote host or a local CXL expansion box.
- **The Blob Problem:** LSM Trees are notorious for poor large-object handling. If you are storing large blobs, you have a pointer indirection. In a disaggregated pool, that pointer might point to a DIMM on the other side of the rack.

**The core issue is that we are treating a distributed system (the CXL pool) like a monolithic block device.**

---

## Part 2: The New Architecture - "Pool-Aware" LSM Design

We need to stop thinking of CXL memory as "DRAM that is slow." We need to think of it as **a new device type** with its own characteristics. It is byte-addressable, but it is not Uniform Memory Access (NUMA). It's more like **NUMA on steroids, but with a distance penalty that is 100x worse.**

We are proposing a re-architecture centered on **Data Locality Sets (DLS)** and **Federated Compaction**. Here is the blueprint.

### 1. The Physical Topology Map

First, the engine must be topology-aware. We cannot rely on the OS to handle NUMA balancing for us; the granularity is too coarse. We need a physical layer abstraction that classifies memory into three distinct "zones":

- **Zone 0 (Hot/CPU):** Local DDR5. Bandwidth: High. Latency: ~80ns. Capacity: Small (limited by DIMM slots).
- **Zone 1 (Warm/Near):** CXL-attached memory on the _same_ host (via a CXL 1.1 controller or a small expansion box). Bandwidth: Medium (PCIe Gen5 x16). Latency: ~200-300ns. Capacity: Large.
- **Zone 2 (Cold/Far):** CXL-attached memory in a _pooled_ chassis, accessed over a CXL switch. Bandwidth: Low (shared). Latency: ~400-600ns+. Capacity: Massive (Terabytes).

We need a `memory_profiler` that runs at startup and continuously monitors the controller hit rates to map the physical address ranges to these zones. This isn't just about `numactl`; this is about understanding the fabric topology to avoid double-hops through the switch.

---

### 2. Segmenting the Memtable

Forget a single "Memtable." We are moving to a **Partitioned Memtable Architecture (PMA).** The write path is the most critical path. We cannot have a stall waiting for `pthread_mutex` on a skiplist while data lives in Zone 2.

We split the Memtable into two components:

- **The Active Log (AL):** This stays in Zone 0. It is painfully small—maybe 1-2 MB. Its sole purpose is to absorb the burst of incoming writes. It functions as a high-frequency buffer that is drained asynchronously.
- **The Immutable Queue (IQ):** Once the AL reaches a threshold (e.g. 2MB), we _don't_ sort it. Instead, we **copy** it as an unsorted log-structured buffer into Zone 1 (Warm CXL).

**Why this is brilliant:** Copying is faster than sorting. We pay a `memcpy` bandwidth cost to Zone 1, but we immediately free up the hot cache lines in Zone 0. The sorting and building of the actual skiplist structure happens in the background, directly in Zone 1 memory.

This moves the write bottleneck from the CPU cache/memory controller to the CXL link. But here is the kicker: we **pipeline** these copies. While the DMA engine is moving buffer N-1 to Zone 1, the CPU is writing to buffer N in Zone 0.

**Code Snippet (Conceptual):**

```c
// Write path for Zone 0 -> Zone 1 transition
void write_to_lsm(key, value) {
    if (active_log.bytes > THRESHOLD) {
        // Let the background thread handle the copy
        // Non-blocking wait on the copy engine
        cxl_async_copy(&active_log, &zone1_buffers[pool_index]);
        active_log.reset();
    }
    // Fast insert into the small skiplist / vector
    active_log.insert(key, value);
}
```

We move from a CPU-bound "sort on write" to a bandwidth-bound "copy on write" model.

---

### 3. Federated Compaction (The Big Change)

This is where we throw out the classic Leveled or Tiered compaction guidelines. In the old world, we compact based on size ratios and levels. In the new world, we compact based on **memory zone residency.**

**The Core Rule:** Data must _flow_ downhill. New data comes into Zone 0 (log), gets buffered in Zone 1, and ultimately resides in Zone 2 as immutable SSTables. Reads that require high QPS must pull hot blocks _up_ into Zone 0.

We introduce the concept of **Compaction Locality Groups (CLG)** . A compaction job isn't just merging files; it's a data migration task.

#### Scenario: L0 -> L1 Compaction

- **Old way:** Read from L0 (DRAM), merge, write to L1 (DRAM).
- **New way:** We have L0 spanning Zone 0 and Zone 1. We have L1 in Zone 2 (The Pool).
- **The Problem:** Moving 100GB of data from Zone 1 to Zone 2 for a merge is wasteful if there is low update activity.
- **The Solution:** **In-Pool Compaction.** We don't bring the data to the CPU to sort it. We use **Remote Procedure Calls (RPC) to the memory controller.**

Wait, CPUs can't run on memory. But we can use **CXL.mem** to perform read-modify-write operations, and more importantly, we can leverage **CXL switch capabilities** to perform a "Smart Copy."

Actually, we do the merge locally in Zone 1. We choose one CXL-attached device in Zone 1 to act as the "Compaction Co-Processor." We transfer the SSTable metadata (Bloom filters, index blocks) to this processor (which might be a small ARM core near the CXL controller). It performs the merge operation _in its local memory_, then writes the merged output directly to Zone 2, bypassing the main CPU entirely.

This is the **Federated Compaction** engine. It looks like an event-driven microservice, but for data blocks.

---

### 4. The Cache Hierarchy Re-Think

The Block Cache is the lifeblood of reads. In RocksDB, it's an LRU over DRAM. In our architecture, we have a three-tier cache:

1.  **Tier 1 (L1 Cache):** The CPU core caches. (Ignore, we don't control this).
2.  **Tier 2 (L2 Cache):** A small, high-associativity cache in Zone 0 dedicated to the **Root Index** and **Bloom Filters** for the hot SSTables.
3.  **Tier 3 (Data Cache):** This lives in Zone 1 (Warm CXL). It caches the actual data blocks.

**The key trick: "Payload Pinning."**
When a client requests a key that hits a hot SSTable in Zone 2, we don't just copy the data block to Zone 0. We issue a **"Read-Pin"** operation. We tell the CXL controller to keep that specific physical page in a _low-latency state_ on the switch (if supported) or to migrate it closer to the requesting host.

This is different from standard LRU. It's **Context-Aware Caching**. We know the workload is range queries on index N? We pin the entire L2 index block to Zone 0. We know it's a point lookup on random keys? We pin the Bloom filter blocks to Zone 0 (they are small and filter 99% of false positives).

---

## Part 3: Handling the "Data Blob" Nightmare

Traditional LSM trees suffer when values are huge (e.g., images, ML model weights). In a disaggregated pool, this is catastrophic. If a value is 10MB, the Bloom filter points to an SSTable, which points to an offset. Reading that 10MB from Zone 2 requires that huge allocation.

**The Re-Architecture: Split the Key and the Blob.**

We do not store large values in the SSTable data files. We store them in a dedicated **Blob Pool (BP)** that resides exclusively in the _cheapest_ memory tier (Zone 2).

1.  The SSTable stores a **logical pointer** (a 64-bit handle) and the hash of the blob.
2.  The LSM-SSTable data files are then _tiny_ and can be cached entirely in Zones 0/1.
3.  When a read hits the SSTable, it gets the pointer.
4.  We have a **Blob Fetcher** that issues an asynchronous, non-blocking `cxl_read(pointer)` to the fabric directly, using DMA.

This means millions of small index reads can hit the fabric, while bandwidth-heavy blob reads are issued in parallel, maximizing the PCIe lane utilization. We are decoupling metadata access (latency-sensitive) from data access (bandwidth-sensitive).

---

## Part 4: The Crash Consistency Question

What happens when the CXL pool goes down? The OS lies to you—it says it's RAM. If a switch fails, that RAM vanishes. With local DRAM, a power loss is catastrophic. With CXL, a switch firmware update could be too.

Our architecture introduces **Epoch-Based Replication**.

- We group write batches into "Epoches" (e.g., 1 millisecond of inserted data).
- The WAL is no longer just on local disk. It is replicated **synchronously** to a WAL buffer in the CXL pool (Zone 2).
- This seems counter-intuitive (it's slower to write to the pool), but the point is that the pool usually survives a host failure.
- However, the pool might fail. So, the WAL is also asynchronously written to local SSD.

We opt for a **hybrid durability model**. We call it "Quorum of Zones."

- **Durability Level 1 (Fast):** The data is in the Zone 0 Memtable. Lost if local power fails.
- **Durability Level 2 (Survive Host Failover):** The data is in the Zone 2 WAL pool. Survives the loss of the local host.
- **Durability Level 3 (Disaster Recovery):** Data is on local SSD via async flush.

The LSM logger can write to both a local SSD and the remote CXL WAL. The write path is double-buffered. If the CXL WAL acknowledges faster than the disk (which it will, due to no mechanical movement), we can even wait for the CXL ack before acknowledging the client. But we must ensure the CXL WAL and the local disk WAL are not in the same failure domain.

This is complex. But it is necessary. The entire point of disaggregation is to survive the death of the machine. If your LSM tree writes its WAL only to the local disk, you have a single point of failure that negates the benefit of the memory pool.

---

## Part 5: The Future - Hardware/Software Co-Design

We are currently doing this in software, but the next leap will be pure hardware acceleration. The CXL controllers we are using now are passive. They just forward requests.

**The next generation needs:**

- **Near-Memory Compute Engines (NMCE):** Small vector engines located on the memory controller of the CXL switch. Instead of streaming compactions back to the host CPU, the host sends a "Compaction Job" descriptor to the switch, and the switch's logic performs the merge _inside its internal SRAM_, reporting back only the new keys.

- **Atomic Compare-And-Swap (CAS) on the Switch:** This is huge. If we can perform atomic operations _at the location of the data_ in the pool, we eliminate the need to lock the entire Memtable the moment we have race conditions.

- **Telemetry:** We need fine-grained telemetry from the CXL fabric. We are proposing a "Memory QoS" bus that exposes cache-hit ratios on the CXL controller. This allows the LSM engine to dynamically adjust the size of the hot zone (Zone 0) and the prefetch fetch distance based on real-time fabric congestion, not just static "startup NUMA distance."

### The Bottom Line

**Stop treating CXL as a paging file.**

The OS kernel will try to do that. If you let it, your LSM performance will be a disaster. The latency asymmetry between local and remote is too high for a generic LRU or a normal TLB miss handler.

By re-architecting the LSM tree into **Zones**, by **federating compaction** to the fabric, and by **splitting blobs from metadata**, we turn the pool from a bottleneck into a massive scaling engine.

---

### Frequently Overlooked Technical Gotchas (Because I love these)

**1. The "Snoop Filter" Storm.**

When you write to Zone 1 (CXL), the CXL controller has to check if that cache line is cached in Zone 0 (local CPU). If you are using a standard `memcpy` to copy a buffer from Zone 0 to Zone 1, you are going to trigger a flood of "Snoop Probes" on the local CPU, making it look like you have a software bug when it's actually a hardware coherence inefficiency. **Fix: We use `cxl_memcpy_non_temporal`** —it bypasses the cache hierarchy, telling the CPU "don't bother trying to keep this coherent locally, I'm moving it away forever." This single change saved us 30% latency on the flush path.

**2. "Capacity on Demand" is a lie (initially).**

CXL memory is not like RAM. When your LSM engine requests a 1GB allocation, the CXL controller will allocate physical pages, but the TLB might not be populated for them. The first access to those pages triggers a **Page Fault Walk over PCIe**, which is catastrophically slow. **Fix: We pre-fault and pre-warm the memory** in large 2MB pages (THP) by performing a dummy read/write to those addresses at allocation time. We pay a one-time cost at startup to map the memory, ensuring that the TLB has the entries before the hot traffic hits.

**3. Dirty Page vs. Clean Page.**

Compaction in Zone 2 is dirty. When you merge and write new SSTables to Zone 2, those dirty pages need to be flushed to their physical location. If the CXL switch has a power-fail issue and data is only in the volatile cache of the CXL device, you lose it. **Fix: We issue `clwb` (Cache Line Write Back) and `sfence` instructions systematically after each compaction batch.** We don't wait for the OS to do it. We do it in the compaction thread to ensure data has crossed the CXL link before we acknowledge the "compaction complete" status.

---

## Final Thoughts: The Pragmatic Path

We are building this on a custom fork of RocksDB, modifying the core `DBImpl` and `VersionStorageInfo` classes. The first release will be simple: It will _only_ use CXL for the Block Cache and the Blob Pool.

But the eventual goal is to have **no local SSD at all** for stored data (except for the WAL). All SSTables will live in the CXL memory space. The compaction logic becomes a memory-lifecycle manager, ensuring that data is sorted and pruned before it reaches the bottom tier of the pool.

The hardware is arriving faster than the software ecosystem is ready for. The teams that crack the nut on **pool-aware algorithms** will have a 10x advantage in the data infrastructure arms race. The LSM tree is not dead. But it is evolving. It’s no longer a tree of levels. It’s a **Distributed Memory Orchestrator** wearing an LSM skin.

**Are you ready to segment your zones?**
