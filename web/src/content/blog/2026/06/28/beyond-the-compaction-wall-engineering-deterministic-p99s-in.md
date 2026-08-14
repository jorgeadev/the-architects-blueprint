---
title: "Beyond the Compaction Wall: Engineering Deterministic P99s in Petabyte-Scale LSM Systems"
shortTitle: "Deterministic P99 Latency in Petabyte-Scale LSM Systems"
date: 2026-06-28
image: "/images/2026/06/28/beyond-the-compaction-wall-engineering-deterministic-p99s-in.jpg"
---

It’s 3:00 AM. Your distributed database cluster is humming along, processing two million writes per second. Suddenly, the latency dashboard for your P99.9 reads—usually a crisp 15ms—spikes to 4 seconds. Your on-call engineer is staring at a wall of "Compaction IO" alerts. The database isn't down, but for your users, it might as well be. This is the **LSM-Tree Stall**, the silent killer of predictable performance in large-scale distributed systems.

When you are operating at the **petabyte scale**, the traditional "write-optimized" benefits of Log-Structured Merge-Trees (LSM-trees) often collide head-on with the requirement for **deterministic query execution**. In a world of microservices and strict SLAs, "fast on average" is no longer good enough. We need "fast always."

In this deep dive, we’re going to tear down the mechanics of LSM-trees and explore the high-level design patterns that modern engineering powerhouses use to achieve deterministic performance in the face of massive data ingestion and background maintenance.

---

## The LSM Paradox: Why Scalability Kills Determinism

To understand the solution, we have to respect the problem. The LSM-tree architecture—famously utilized by RocksDB, Cassandra, ScyllaDB, and TiKV—is a masterpiece of write-optimization. By treating all writes as sequential appends to an in-memory **Memtable** and subsequently flushing them as immutable **SSTables** (Sorted String Tables) to disk, we bypass the random-write bottleneck of B-Trees.

However, this creates a **fragmented read path**. To find a single key, you might have to check:

1. The Memtable.
2. Several levels of SSTables (L0, L1, ..., Ln).
3. Bloom filters for each of those levels.

As data grows to the petabyte scale, the background process that cleans up this mess—**Compaction**—becomes a monstrous resource hog. Compaction is the act of merging multiple SSTables, de-duplicating keys, and removing deleted entries (tombstones). At scale, compaction creates **write amplification** (writing the same data multiple times) and **read amplification** (searching too many files).

**The Hype Factor:** In recent years, there has been a massive industry shift toward "Cloud-Native LSMs" (think Snowflake’s micro-partitions or Databricks’ Delta Lake). The hype suggests that object storage (S3/GCS) solves all our problems. The reality? High-latency object stores make the LSM read-path even _more_ non-deterministic. If your compaction logic isn't "storage-aware," your P99s will fluctuate with every S3 request.

---

## Pattern 1: Tiered Compaction with "SSTable Pinning"

In a standard Leveled Compaction strategy, data moves from L0 to L1, then L2, and so on. Each level is 10x larger than the previous. While this keeps the number of files low, a single merge at L5 can involve hundreds of gigabytes of data, saturating disk I/O and CPU.

To achieve **determinism**, we move toward a **Tiered-Leveled Hybrid with Pinning**.

### The Mechanism

Instead of blindly merging files based on size, we implement **Compaction Guardrails**. We "pin" certain high-access SSTables in the upper levels (L0/L1) to fast NVMe storage, while allowing lower levels to migrate to slower, cheaper "Cold" storage (S3).

By using **Size-Tiered Compaction** for L0 (to handle bursts) and **Leveled Compaction** for L1+ (to keep reads fast), we can predict exactly how many "touches" a query will require.

```rust
// Conceptual: Compaction Priority Scoring
fn calculate_compaction_score(level: &Level) -> f64 {
    let size_ratio = level.current_size as f64 / level.target_size as f64;
    let overlap_factor = level.calculate_key_overlap();

    // We weigh the score to prevent "Giant Merges" during peak traffic hours
    if is_peak_traffic_window() {
        size_ratio * 0.5 + overlap_factor * 0.2
    } else {
        size_ratio * 1.5 + overlap_factor * 1.0
    }
}
```

By making the compaction engine **traffic-aware**, we prevent it from initiating a massive L6 merge right when the morning traffic surge hits. This is the first step toward determinism: **scheduling the chaos.**

---

## Pattern 2: The "Tombstone Excision" Protocol

One of the greatest enemies of deterministic query execution in LSM-trees is the **Tombstone**. In an LSM-tree, you don't delete data; you write a "marker" saying it's deleted.

At the petabyte scale, especially in systems with high churn (like session management or IoT sensor data), you can end up with "Tombstone Heavy" SSTables. A range scan that should return 100 results might actually have to skip over 1,000,000 tombstones. This leads to **unpredictable scan latencies**.

### The Solution: Range Deletion Tombstones and Compaction Filters

Instead of individual markers, we use **Range Deletions**. More importantly, we implement **Compaction Filters** that aggressively prioritize the merging of SSTables with a high density of tombstones.

**Engineering Insight:** At Uber or Netflix scale, they often use a "Time-to-Live (TTL) Aware" compaction. If data is known to expire in 30 days, the LSM levels are partitioned by time. This allows the system to simply _drop_ entire SSTable files rather than merging them—reducing write amplification to nearly zero for expired data.

---

## Pattern 3: ZNS (Zoned Namespaces) and Hardware-Software Co-Design

If you are running at petabyte scale, you are likely running on NVMe SSDs. Traditional SSDs use a **Flash Translation Layer (FTL)** that does its own internal "garbage collection."

When your LSM-tree is doing compaction (Software GC) and your SSD is doing FTL merging (Hardware GC) at the same time, you get **I/O jitter**. Your 1ms read suddenly takes 100ms because the hardware is busy moving blocks.

### The Design Pattern: ZNS-Aware LSMs

Zoned Namespaces (ZNS) is the "hot" tech in high-end storage right now. It allows the database to write data directly to specific "zones" on the SSD, bypassing the FTL’s garbage collection.

1. **Mapping Levels to Zones:** We map LSM levels directly to SSD zones. L0 goes to Zone A, L1 to Zone B.
2. **Sequential Harmony:** Since LSMs write SSTables sequentially, they are a perfect match for ZNS.
3. **Zero Jitter:** Because the SSD is no longer "surprising" the OS with internal garbage collection, query execution becomes mathematically deterministic based on the software's I/O schedule.

By aligning the **log-structured nature of the software** with the **log-structured nature of the hardware**, we eliminate the "hidden" latencies of the storage stack.

---

## Pattern 4: Predictive Bloom Filter Sharding

At the petabyte scale, even your Bloom Filters—the probabilistic data structures that tell you if a key _might_ exist in a file—become a problem. A Bloom filter for a 1PB dataset can exceed several hundred gigabytes. You can't keep that in RAM on every node.

If a query has to fetch a Bloom filter from disk just to see if it needs to fetch the _actual_ data from disk, your determinism is gone.

### The Pattern: Two-Phase Bloom Sharding

We divide the Bloom filter into a **Multi-Level Index**:

- **Layer 1 (The Block Filter):** A tiny, ultra-sparse filter kept in RAM that covers large ranges of keys.
- **Layer 2 (The SSTable Filter):** A dense filter stored at the head of each SSTable.

**The "Deterministic" Twist:** We use **Prefix-Hash Sharding**. By ensuring that all keys with the same prefix (e.g., `user_id`) are routed to the same shard and the same SSTable group, we can cache the Bloom filters for the most active prefixes with nearly 100% hit rates.

When a query comes in for `user_123`, the system knows exactly which node, which SSTable, and which Bloom filter block to hit. There is no "searching"—only "retrieving."

---

## Pattern 5: Compute-Storage Disaggregation with "Deterministic Caching"

In modern distributed architectures, we often separate compute (EC2/K8s) from storage (S3/EBS). The problem? The network is non-deterministic.

### The Design Pattern: The "Local-First" Read-Through Cache

To maintain petabyte-scale determinism, we use a **Shared-Nothing Compute Layer** with a **Shared-Everything Storage Layer**, but we introduce a **Deterministic Cache Layer** in the middle.

Instead of a standard LRU (Least Recently Used) cache, which is inherently jittery, we use **Segmented Caching**:

1. **L0/L1 SSTables** are permanently mirrored to local NVMe on the compute nodes.
2. **Index and Filter blocks** are pinned in RAM.
3. **L2-L6 data** is fetched via asynchronous pre-fetching.

When a query is planned, the **Query Optimizer** checks the locality of the data. If the data is in the "Remote" tier (L3+), the query engine doesn't just "wait" (blocking thread). It uses a **Wait-Free Execution Model** where it yields the CPU, issues a range-request to S3, and only re-enters the execution queue when the data is locally staged.

This prevents a slow S3 read from blocking the entire pipeline of fast NVMe reads, maintaining the "deterministic throughput" of the system.

---

## Handling the Hype: Is "Serverless" LSM a Myth?

There’s a lot of noise about "Serverless Databases" that handle petabytes with "zero configuration." While these are great for developer velocity, they often struggle with the **Deterministic Query Execution** problem we’re discussing.

Most serverless offerings use a "one-size-fits-all" compaction policy. At the petabyte scale, "one-size-fits-all" usually means "tail latencies will be terrible for someone." If you are building high-performance infrastructure, the move is toward **Policy-Driven LSMs**—where you can define different compaction and caching strategies for different tables within the same engine.

- **Transactional Tables:** Use Leveled Compaction for 1ms point lookups.
- **Analytics/Log Tables:** Use Tiered Compaction for high-throughput ingestion.
- **Archive Tables:** Use heavy compression and move directly to the "Object Storage" tier.

---

## Infrastructure Implementation: The "Compaction Scheduler" Service

In a distributed petabyte-scale system, you shouldn't let nodes decide when to compact. That leads to "Compaction Storms," where multiple nodes start heavy I/O at the same time, crushing the network.

### The Centralized Scheduler Pattern

We pull the compaction logic out of the storage engine and move it into a **Distributed Orchestrator**.

- **Telemetry:** Each storage node reports its "Dirty Data" ratio and I/O pressure.
- **Scheduling:** The orchestrator grants "Compaction Tokens." A node can only perform a heavy merge if it holds a token.
- **Load Balancing:** The orchestrator ensures that if Node A is compacting, its replicas (Node B and C) are kept "quiet" to handle the read traffic.

This is how systems like **ScyllaDB** or **BigTable** manage to maintain flat P99s. They ensure that at any given time, the "Read Quorum" is always hitting nodes that aren't currently under compaction stress.

---

## The Engineering Curiosity: "Query-Aware" SSTables

What if the SSTable itself knew how it was going to be queried?

We’ve seen experimental implementations where, during the compaction process, the engine analyzes the **Query Logs**. If it notices that `Column A` and `Column C` are frequently queried together in a range, it will re-order the physical layout of the data within the SSTable block to ensure they reside on the same disk page.

This **Physical Data Reification** turns a random I/O pattern into a sequential one. At the petabyte scale, reducing the number of I/O operations by even 10% can save hundreds of thousands of dollars in cloud egress and storage costs, while simultaneously tightening the latency distribution.

---

## Scaling the Unscalable

Building a system that handles a few terabytes is a challenge. Building one that handles **petabytes with deterministic 10ms latencies** is an art form. It requires moving beyond the basic textbook definitions of LSM-trees and into the realm of hardware-software co-design, distributed orchestration, and traffic-aware scheduling.

To recap the patterns for achieving this:

- **Hybrid Compaction:** Use different strategies for different data ages and sizes.
- **ZNS Awareness:** Align software writes with hardware zones to eliminate FTL jitter.
- **Tombstone Management:** Use range deletions and prioritize "death-heavy" SSTables for merging.
- **Centralized Coordination:** Don't let nodes compact in a vacuum; orchestrate I/O across the cluster.
- **Wait-Free Execution:** Design the query engine to handle the latency delta between local NVMe and remote Object Storage without blocking.

When you treat your storage engine not as a black box, but as a programmable I/O pipeline, the "Compaction Wall" disappears. You stop fighting the LSM-tree and start choreographing it.

The next time your P99s spike at 3:00 AM, don't just add more nodes. Look at your compaction scores, check your tombstone density, and ask yourself: **Is my architecture deterministic, or am I just getting lucky?**
