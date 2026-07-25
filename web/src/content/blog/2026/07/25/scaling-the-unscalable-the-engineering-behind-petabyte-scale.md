---
title: "Scaling the Unscalable: The Engineering Behind Petabyte-Scale LSM Trees in Apache Hudi"
shortTitle: "Engineering Petabyte-Scale LSM Trees in Apache Hudi"
date: 2026-07-25
image: "/images/2026/07/25/scaling-the-unscalable-the-engineering-behind-petabyte-scale.svg"
---

Imagine it’s 3 AM. You’re an on-call engineer for a global fintech platform. Every second, millions of transactions, clicks, and state changes are pouring into your data lake. Your task? Ensure that this data is not only stored but is **queryable in near real-time** with ACID guarantees.

Historically, this was a nightmare. You had two choices:

1.  **The Batch Path:** Rewrite massive chunks of your data lake every few hours (Copy-on-Write), which is like repainting an entire skyscraper because one window got a smudge.
2.  **The Stream Path:** Keep everything in row-based logging formats, making your analytical queries so slow they’re practically useless.

This tension is where **Write Amplification (WA)** goes to thrive. In a world where data grows exponentially, WA is the silent killer of infrastructure budgets. When you update a single row in a 1GB Parquet file and the system rewrites the entire 1GB file to commit that change, you aren't just being inefficient—you’re failing to scale.

Enter **Apache Hudi** and its implementation of **Log-Structured Merge (LSM) Tree** principles on top of distributed cloud storage. By reimagining how we manage file groups and handle incremental updates, Hudi has fundamentally changed the economics of petabyte-scale data engineering.

## The Anatomy of the Problem: Why Data Lakes Break at Scale

To understand Hudi’s brilliance, we first have to understand the "Write Amplification" monster. Traditional data lakes built on Hive or simple Parquet structures are essentially "immutable-ish." To update data, you read a file, merge the change in memory, and write a new version of that file.

If your update rate is high—say, 5% of your records change every hour—a Copy-on-Write (COW) architecture will force you to rewrite nearly your entire data lake constantly. At a petabyte scale, this results in:

- **IOPS Exhaustion:** Your S3/GCS/ADLS request limits get hammered.
- **Compute Waste:** You spend 90% of your Spark/Flink cycles just moving existing data around.
- **Latency Spikes:** Queries have to wait for massive write commits to finish.

This is exactly why **Log-Structured Merge Trees**, a concept popularized by NoSQL databases like RocksDB and Cassandra, were brought into the Lakehouse. But applying LSM to a data lake is an entirely different beast. You aren't merging 64MB MemTables; you’re merging multi-gigabyte columnar files across a distributed network with high latency.

---

## The Hudi LSM Implementation: Merge-on-Read (MOR)

Hudi solves the write amplification problem through its **Merge-on-Read (MOR)** table type. In an MOR table, data is stored in two distinct formats:

1.  **Base Files:** Highly optimized, columnar Parquet files (the "SSTables" of the Lakehouse).
2.  **Delta Log Files:** Row-based Avro files that capture changes (inserts, updates, deletes) since the last base file was created.

When a write happens, Hudi doesn't touch the base file. It simply appends the change to a log file. This reduces Write Amplification to near-zero for the ingestion path. However, this introduces a "Read Amplification" challenge—to see the latest state, a reader must merge the base file and the log files on the fly.

This is where the **engineering of File Groups** becomes critical.

### The Logic of File Groups and File Slices

Hudi organizes a table into **File Groups**. Each File Group is identified by a unique UUID and contains a series of **File Slices**.

- A **File Slice** consists of a single base file and all its associated delta logs.
- As new data flows in, Hudi uses a **Location Index** (like a Bloom Filter, Simple Index, or the new Metadata-based Record Level Index) to map an incoming record key to a specific File Group.

By partitioning data this way, Hudi ensures that updates are surgically targeted. If you have 10,000 Parquet files, but an update only affects 5 of them, Hudi only appends logs to those 5 specific File Groups.

---

## Mitigating Write Amplification via Compaction Strategies

The log files can’t grow forever. Eventually, the cost of merging them during a query (Read Amplification) outweighs the benefits of fast writes. This is where **Compaction**—the heart of Hudi’s LSM engine—comes into play.

Compaction is the process of merging a base file and its delta logs to produce a new, "clean" base file (a new File Slice). Hudi’s engineering team has developed sophisticated strategies to make this "heavy lifting" efficient enough for petabyte scales.

### 1. The Scheduling vs. Execution Split

One of the most powerful features of Hudi’s compaction is the decoupling of **scheduling** and **execution**.

- **The Scheduler:** Runs as part of the ingestion pipeline. It looks at the "heaviness" of the log files (based on size or number of commits) and creates a **Compaction Plan**. This plan is a serialized metadata object stored in the Hudi Timeline.
- **The Executor:** Can run asynchronously on a completely different compute cluster. This allows you to have a small, high-frequency Spark streaming job for ingestion and a massive, low-frequency Spark batch job for compaction.

### 2. Multi-Writer Concurrency and Non-Blocking Compaction

In a standard LSM tree, "Compaction Stall" is a major risk—where writes are paused because the system can't keep up with merging. Hudi avoids this through **Non-blocking Compaction**.

Because Hudi uses MVCC (Multi-Version Concurrency Control), ingestion can continue writing to `Log File v2` while a compaction process is reading `Base File v1` and `Log File v1` to create `Base File v2`. There is no global lock. This is essential for 24/7 high-throughput systems like those at Uber or Walmart, where "downtime for maintenance" is not an option.

### 3. Smart Compaction Heuristics

Hudi doesn't just blindly compact everything. It uses pluggable strategies:

- **Unbounded Strategy:** Compacts all partitions (classic batch).
- **BoundedIO Strategy:** Only compacts a certain number of File Groups to stay within a specific time or compute budget.
- **Log File Size/Number Strategy:** Only compacts File Groups where the log files have exceeded a certain threshold (e.g., "The log is now 20% the size of the base file").

```yaml
# Example Hudi Compaction Config for a Petabyte-Scale Table
hoodie.compact.inline: false
hoodie.compact.inline.max.delta.commits: 5
hoodie.compaction.strategy: org.apache.hudi.table.action.compact.strategy.LogFileSizeBasedCompactionStrategy
hoodie.compaction.target.io: 512000 # Limit IO to 500GB per compaction run
```

---

## Deep Dive: The Metadata Table and the Death of "ListFiles"

At petabyte scale, the biggest bottleneck isn't often the data—it's the **cloud storage control plane**. If you have millions of files on S3, running a `ls -R` (ListFiles) command can take minutes and cost thousands of dollars in API requests.

Hudi engineers solved this by introducing the **Internal Metadata Table**. This is essentially a hidden, high-performance Hudi table (using the Column Stats and Bloom Filter indexes) that stores the physical locations of all data files.

By using the Metadata Table, Hudi eliminates the need for expensive file listing. When the Compactor or the Query Engine needs to find data, it queries the Metadata Table (which is stored in Hudi’s own optimized HFile format). This reduces the "time to first byte" significantly and allows Hudi to scale to billions of files without hitting S3 throttling limits.

### Record-Level Indexing: The "Global" LSM Secret

One of the most hyped features in recent Hudi releases (0.13.0+) is the **Record-Level Index**. In traditional data lakes, to find which file contains `user_id: 12345`, you had to either partition by `user_id` or scan everything.

The Record-Level Index is a distributed, sharded index stored within the Metadata Table. It maps every single record key to its File Group ID. When an update comes in, Hudi performs a point-look-up in this index. This turns a "Search" problem into a "Hash Lookup" problem, further reducing the compute required for incremental updates.

---

## Engineering for Scale: Memory Management and the "Spillable Map"

When you’re merging a 1GB Parquet file with 500MB of Avro log files across thousands of File Groups in a Spark executor, **RAM is your enemy**. A common failure mode in lakehouse engineering is the dreaded `OutOfMemoryError` during compaction.

Hudi’s engineering team built a custom data structure called the **ExternalSpillableMap**.
During the merge process:

1.  Hudi loads log records into an in-memory map.
2.  If the map exceeds a configurable memory fraction (e.g., 75% of JVM heap), Hudi **spills** the overflow to the local disk of the Spark executor.
3.  The spilled data is stored in a disk-optimized format that allows for efficient retrieval during the merge with the base file.

This "graceful degradation" is why Hudi can handle massive data skews—where one File Group might have 10x the updates of another—without crashing the entire pipeline.

---

## Why the Hype? The Business Impact of Hudi's LSM Strategy

The tech industry is currently obsessed with "Cost Optimization." During the 2010s, the mantra was "Growth at all costs." In the 2020s, it's "Efficiency at scale."

Hudi’s incremental architecture fits this perfectly. By mitigating Write Amplification, companies like **Uber** (who pioneered Hudi) have reported:

- **60% reduction in compute costs** compared to traditional COW methods.
- **90% reduction in data latency**, moving from daily batches to 5-minute incremental updates.
- **Lower Storage Overhead:** Because Hudi manages versions and cleaning (vacuuming) automatically, storage doesn't balloon out of control.

The "hype" isn't just about speed; it's about making the **Real-Time Lakehouse** economically viable.

---

## Infrastructure Considerations: Compute Scale

If you're running Hudi at the petabyte scale, your infrastructure stack usually looks like this:

- **Storage:** S3/GCS with a hierarchical namespace or optimized prefixing (to avoid S3's 3500 PUT/5500 GET per prefix limits).
- **Compute:** Spark or Flink on Kubernetes (EKS/GKE).
- **The "Secret Weapon":** Using **Graviton (ARM)** instances. Because Hudi’s compaction and indexing are compute-intensive, the price-performance ratio of ARM processors significantly lowers the TCO (Total Cost of Ownership).

### Sample Spark Execution Pattern

```scala
// Highly optimized Hudi Write Client setup
val hudiOptions = Map(
  "hoodie.datasource.write.table.type" -> "MERGE_ON_READ",
  "hoodie.datasource.write.operation" -> "upsert",
  "hoodie.datasource.write.payload.class" -> "org.apache.hudi.common.model.OverwriteWithLatestAvroPayload",
  "hoodie.metadata.enable" -> "true",
  "hoodie.metadata.index.async" -> "true",
  "hoodie.index.type" -> "RECORD_INDEX",
  "hoodie.parquet.small.file.limit" -> "104857600", // 100MB
  "hoodie.copyonwrite.record.size.estimate" -> "1024"
)

df.write.format("hudi")
  .options(hudiOptions)
  .mode(Append)
  .save(basePath)
```

In this setup, the `hoodie.parquet.small.file.limit` is a critical engineering lever. It tells Hudi to "stuff" new records into existing small files rather than creating new ones, which is a proactive way to prevent **File Fragmentation**—the other silent killer of data lake performance.

---

## The Engineering Frontier: Clustering vs. Compaction

While we've focused on compaction, petabyte-scale engineering requires one more trick: **Clustering**.

Compaction fixes the "Log vs. Base" problem, but it doesn't fix the "Data Layout" problem. Over time, your data becomes fragmented across files based on arrival time. If your queries usually filter by `timestamp` and `region_id`, but your data is scattered, you’re performing full table scans.

Hudi’s **Asynchronous Clustering** re-organizes the data on disk without blocking writes. It can perform **Z-Ordering** or **Hilbert Curves** to co-locate related data in the same files.

- **Compaction** mitigates _Write_ Amplification.
- **Clustering** mitigates _Read_ Amplification.

Together, they form a "Double-Whammy" against inefficiency.

---

## Final Thoughts: The Future is Incremental

The engineering behind Apache Hudi’s LSM implementation proves that the trade-off between "Fresh Data" and "Fast Queries" is a false dichotomy. By bringing the rigorous log-structured approaches of high-performance databases to the distributed, chaotic world of cloud object storage, we can now build systems that are both massive and agile.

We are moving away from the era of "Re-everything"—re-calculating, re-writing, re-indexing. The future of data engineering is **incremental**. Whether you are handling financial transactions, IoT sensor streams, or LLM training logs, the principles of file group management and intelligent compaction are the bedrock of the modern data stack.

If you’re still battling the Write Amplification monster, it might be time to stop repainting your skyscraper and start building a better window-management system. The petabyte scale isn't scary because of the volume; it’s scary because of the inefficiencies that volume reveals. Solve the inefficiency, and the scale takes care of itself.
