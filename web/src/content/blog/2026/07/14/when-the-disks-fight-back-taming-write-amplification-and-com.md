---
title: "When the Disks Fight Back: Taming Write Amplification and Compaction Latency in Multi-Petabyte LSM-Trees"
shortTitle: "Taming Write Amplification and Latency in Multi-Petabyte LSM-Trees"
date: 2026-07-14
image: "/images/2026/07/14/when-the-disks-fight-back-taming-write-amplification-and-com.svg"
---

It’s 3:00 AM. Your on-call dashboard is glowing red. The P99 latency for your primary storage cluster—a multi-petabyte behemoth handling billions of events—has spiked from 5ms to 500ms. You check the ingress; traffic is steady. You check the network; it's clean. Then you see it: the **Write-Ahead Log (WAL)** is stalling, and the background compaction threads are pinning every CPU core to 100%.

Your database isn't failing because of external load. It’s failing because it’s trying to "clean" itself to death.

In the world of massive-scale distributed systems, **Log-Structured Merge-Trees (LSM-trees)** are the industry standard for write-heavy workloads. From RocksDB and Cassandra to ScyllaDB and TiKV, the LSM-tree powers the backends of Netflix, Uber, and Meta. But at the multi-petabyte scale, the very architecture that makes LSM-trees fast for writes introduces a predatory tax: **Write Amplification (WA)** and **Compaction Latency**.

If you are running on high-density NVMe SSDs, these aren't just academic metrics. They are the difference between a performant system and a hardware-replacement bill in the millions. Today, we’re going deep into the belly of the beast to explore how we optimize LSM-trees for the modern era of petabyte-scale flash storage.

---

## The RUM Conjecture and the Price of Performance

Before we dive into the "how," we need to understand the "why." In database theory, we live by the **RUM Conjecture** (Read, Update, Memory). It states that you can only optimize for two of these at the expense of the third.

LSM-trees are optimized for **Updates** and **Memory** (specifically, sequential write performance). Unlike B-Trees, which perform in-place updates and cause random I/O (the silent killer of HDDs and the nemesis of SSD Flash Translation Layers), LSM-trees turn updates into append-only operations.

### The Lifecycle of a Write

1.  **Memtable:** The write hits an in-memory buffer.
2.  **WAL:** Simultaneously, it's appended to a disk-based log for durability.
3.  **Flush:** Once the Memtable is full, it's frozen and flushed to disk as a sorted **SSTable (Sorted String Table)** at **Level 0**.
4.  **Compaction:** This is where the magic (and the pain) happens. Background threads merge SSTables from Level $N$ into Level $N+1$, de-duplicating keys and removing deleted entries.

The problem? To keep reads fast, we must keep the data sorted. To keep the data sorted, we must constantly re-read and re-write data during compaction. If you write 1MB of user data, and the system ends up writing 20MB over the lifetime of that data as it moves through levels, you have a **Write Amplification Factor (WAF) of 20**.

At a petabyte scale, a WAF of 20 means your SSDs are dying 20 times faster than necessary, and your bus is constantly saturated with "maintenance" traffic.

---

## The Silent Killer: SSD FTL and Garbage Collection

When we talk about multi-petabyte arrays, we aren't just talking about software; we’re talking about the physical reality of NAND flash.

SSDs cannot overwrite data. They must erase a "block" before writing to a "page" within it. This is handled by the **Flash Translation Layer (FTL)** through a process called **Garbage Collection (GC)**.

When your LSM-tree performs a compaction, it’s generating massive amounts of sequential I/O. However, if the LSM-tree's compaction strategy isn't aligned with the SSD's internal GC, you get **Double Amplification**. The LSM-tree amplifies the write, and then the SSD FTL amplifies it _again_ to move data around during block erasures.

This results in **latency spikes** that are impossible to tune via software alone—unless you change how the LSM-tree talks to the disk.

---

## Strategy 1: Tiered vs. Leveled Compaction (Choosing Your Poison)

The most fundamental lever we have is the compaction strategy. Most engineering teams default to **Leveled Compaction** (the RocksDB default), but at petabyte scale, this is often a mistake.

### Leveled Compaction (The Read-Optimizer)

In leveled compaction, each level ($L_1, L_2, \dots$) is 10x larger than the previous one. Each level (except $L_0$) contains non-overlapping SSTables.

- **Pros:** Low Read Amplification. You only check one SSTable per level.
- **Cons:** Massive Write Amplification. Every time a file moves from $L_i$ to $L_{i+1}$, it might be re-written 10 times because it has to be merged with all overlapping data in the target level.

### Tiered Compaction (The Write-Optimizer)

Commonly used in ScyllaDB and Cassandra (Size-Tiered), this strategy simply groups SSTables of similar sizes and merges them into a larger SSTable.

- **Pros:** Lower Write Amplification. Data is merged much less frequently.
- **Cons:** Terrible Read Amplification. Since SSTables overlap in their key ranges, a single read might have to check dozens of files across the tiers.

### The Hybrid Solution: Leveling at the Bottom

For multi-petabyte clusters, the "sweet spot" is often a **Hybrid Compaction Strategy**. We use **Tiered Compaction for $L_0$ and $L_1$** to absorb massive write bursts, and then transition to **Leveled Compaction for deeper levels** where data is colder. This caps the WAF while keeping the P99 read latency predictable.

```cpp
// Example: RocksDB Hybrid Configuration Snippet
rocksdb::Options options;
options.compaction_style = rocksdb::kCompactionStyleLevel;
options.level0_file_num_compaction_trigger = 4;
options.target_file_size_base = 64 * 1024 * 1024; // 64MB SSTables
// Use Universal (Tiered) for the top levels to reduce initial WAF
options.options_overrider = [](rocksdb::ColumnFamilyOptions* cf_opts) {
    cf_opts->compaction_style = rocksdb::kCompactionStyleUniversal;
};
```

---

## Strategy 2: Key-Value Separation (The WiscKey Revolution)

If you’re dealing with values larger than 1KB (images, JSON blobs, Protobufs), the standard LSM-tree is fundamentally inefficient. Why move a 100KB value through seven levels of compaction if only the 16-byte key is needed for sorting?

This is the insight behind **WiscKey** (implemented in libraries like **Titan** for RocksDB or **BadgerDB**).

### How it works:

1.  **Key-Value Separation:** You store the keys in a standard LSM-tree, but you store the actual values in a separate, append-only **vLog (Value Log)**.
2.  **LSM Entry:** The LSM-tree now stores the Key and a _pointer_ (offset + length) to the value in the vLog.
3.  **Compaction:** When the LSM-tree compacts, it only moves the keys and pointers. The massive values stay put in the vLog.

**The result?** Write amplification drops from $20\times$ or $30\times$ to nearly $1\times$ for the values. At petabyte scale, this is a game-changer. You save petabytes of disk endurance and massive amounts of CPU cycles that would have been spent re-shuffling values.

**The Trade-off:** Range scans become slower because you have to perform random I/O to fetch values from the vLog. However, on modern NVMe drives with high IOPS, the penalty is often negligible compared to the massive gains in write throughput.

---

## Strategy 3: Hardware-Software Co-Design with ZNS (Zoned Namespaces)

This is the cutting edge. If you are building for the next five years of infrastructure, you need to talk about **ZNS**.

In a traditional SSD, the FTL hides the NAND's complexity. With **Zoned Namespaces (ZNS) SSDs**, the drive exposes the raw NAND zones (usually several hundred MBs each) directly to the host. These zones must be written sequentially and erased as a unit.

Does that sound familiar? It should. **LSM-trees are naturally ZNS-compatible.**

By modifying the LSM-tree storage engine (like the `RocksDB-ZNS` project) to align SSTable files with physical NAND zones:

1.  **Zero Software GC:** You eliminate the SSD’s internal Garbage Collection entirely.
2.  **Deterministic Latency:** No more "background GC" spikes from the SSD controller.
3.  **Over-provisioning:** You can use 100% of the drive’s capacity. Standard SSDs hide 10-20% of their flash to handle GC; ZNS doesn't need to.

When you're managing 10PB, that 20% "hidden" capacity represents **2 petabytes of "free" storage** you just unlocked by being smarter about your I/O alignment.

---

## Strategy 4: Intelligent Compaction Pacing and Rate Limiting

The most common cause of latency spikes isn't the total amount of compaction—it's the _burstiness_ of it.

When the Memtable flushes too fast, the LSM-tree triggers "emergency" compactions to prevent $L_0$ from overflowing (which would stop all writes). This creates a "thundering herd" effect on the I/O subsystem.

### Implementing a Compaction Scheduler

Instead of letting the database engine decide when to compact with total abandon, high-scale engineering teams implement **Compaction Pacing**.

- **Token Bucket Rate Limiting:** Assign a global I/O quota to background compaction threads. If the user write rate is 500MB/s and the WAF is 10, the compaction rate must be at least 5GB/s to keep up.
- **Backpressure Mechanisms:** If the "Compaction Debt" (the number of bytes waiting to be compacted) exceeds a threshold, you must actively throttle incoming user writes. It is better to have a slightly slower, consistent write response than a blistering fast one that crashes into a 10-second stall later.

```python
# Conceptual Compaction Pacer
def calculate_compaction_quota(incoming_write_rate, current_waf, debt_ratio):
    base_quota = incoming_write_rate * current_waf
    # If we are falling behind (debt > 1.0), aggressively increase quota
    # to avoid a write stall later.
    if debt_ratio > 1.2:
        return base_quota * 1.5
    return base_quota

# Apply this to the storage engine's background thread pool
storage_engine.set_max_background_io_bytes_per_sec(
    calculate_compaction_quota(current_ingress, system_waf, current_debt)
)
```

---

## The Engineering Curiosity: "The Delete Problem"

Here’s a technical curiosity that often bites engineers at scale: **Tombstones.**

In an LSM-tree, a "delete" is actually a "write." You write a marker (a tombstone) saying the key is deleted. The actual data isn't removed until that tombstone compacts all the way to the bottom level and meets the original data.

If you have a workload that deletes millions of keys, you can end up with a "Tombstone Storm." Your read performance degrades because the Bloom filters say the key _might_ exist, and the engine has to scan multiple SSTables only to find a tombstone.

**The Fix: Tombstone-Aware Compaction.**
Advanced LSM implementations track the density of tombstones in each SSTable. If an SSTable is 30% tombstones, the scheduler prioritizes it for compaction, regardless of its size or age, to "garbage collect" the space and restore read performance.

---

## Scaling to Multi-Petabyte: Sharding and Federation

No single LSM-tree instance should manage a petabyte of data. The blast radius is too large, and the compaction overhead becomes quadratic.

At this scale, the architecture must move to **Micro-SSTables and Virtual Sharding**.

1.  **Physical Sharding:** Split the data into 256MB or 1GB shards (like RocksDB Partitions).
2.  **Resource Isolation:** Assign specific CPU cores and NVMe namespaces to groups of shards.
3.  **Parallel Compaction:** By having smaller, independent LSM-trees, you can run compactions in parallel across different NVMe drives, ensuring that a "compaction storm" on Shard A doesn't block the WAL of Shard B.

---

## The Bottom Line

Optimizing LSM-trees for multi-petabyte SSD arrays is a transition from "using a library" to "architecting a hardware-software symbiosis."

If you are seeing latency spikes or premature drive failure, the path forward is clear:

1.  **Analyze your WAF:** If it's over 20, your compaction strategy is likely wrong.
2.  **Audit your Value sizes:** If they are >1KB, look into Key-Value separation (Titan/Badger).
3.  **Look at the Hardware:** Align your storage engine with the physical realities of NVMe. ZNS is no longer a research project; it’s the future of the data center.
4.  **Pace your I/O:** Consistency is better than bursty speed.

The LSM-tree is one of the most elegant data structures in computer science, but at petabyte scale, it requires a steady hand and a deep understanding of the silicon beneath it. Don't let your database fight your disks. Align them, and your P99s will thank you.

---

**Are you dealing with compaction debt or WAF issues in your clusters? Let’s talk in the comments. We’re particularly interested in hearing from teams experimenting with ZNS in production.**
