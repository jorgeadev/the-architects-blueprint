---
title: "The Log That Wouldn’t Die: Why Tiered Storage & Segment Merging Are Reshaping Cloud-Native Brokers"
shortTitle: "Tiered Storage and Segment Merging: Reshaping Cloud-Native Brokers"
date: 2026-07-30
image: "/images/2026/07/30/the-log-that-wouldn-t-die-why-tiered-storage-segment-merging.svg"
---

**You’ve got a firehose of events—10 million writes per second—and your Kafka cluster is about to melt down.** Your storage is a screaming hot mess of rigid SSDs, your segment files are turning into a fragmented disaster, and your retention policy is either “impossible” or “bankrupt.”

If you’ve lived this nightmare, you’re not alone. For years, the shared-log architecture (think Kafka, Pulsar, Redpanda, Pravega) was the gold standard for event streaming. But the industry hit a wall: **the cost-performance curve of cloud storage forced us to rethink everything.**

Today, we’re witnessing a quiet revolution—**tiered storage** and **segment merging** are turning message brokers from brittle, single-tier monstrosities into elastic, cost-savvy clouds-in-miniature. This isn’t just a feature list update. This is a fundamental re-architecture of how we think about durability, latency, and operational complexity at scale.

Let’s get into the weeds. This is the engineering that matters.

---

## 🧱 The Shared-Log Primitives: A Quick Refresher

Before we talk evolution, let’s set the baseline. A shared-log architecture is not a monolith. It’s a distributed log—a durable, append-only sequence of records. Brokers are the nodes that manage these logs. The core primitives:

- **Partitions / Segments**: The log is split into contiguous chunks (e.g., 1 GB each). This enables parallelism and bounded recovery.
- **Leaders & Followers**: One broker owns the partition leadership; it handles reads/writes. Followers replicate for durability.
- **Offset-based consumption**: Consumers track their position (offset) and read sequentially. Sequential reads are _fast_ on HDDs and _blazing_ on SSDs.

The classic challenge: **all data lives on local SSDs of broker nodes**. That means your cluster’s storage capacity = `number_of_brokers * disk_per_broker`. Scaling up? Add more brokers. Scaling out? Add more brokers. You’re stuck paying for both compute and storage together—the classic **vertical coupling** that plagues stateful systems.

---

## 📉 The Cloud-Native Tipping Point (When Local SSDs Become a Liability)

Enter the cloud: object stores like S3, GCS, or Azure Blob are **$0.023/GB/month** for standard tiers vs. **$1.00/GB/month** for provisioned SSDs on a premium EC2 instance. The arithmetic screams at you:

- **100 TB of data on local SSDs** → ~$100,000/month just for raw storage.
- **Same data on S3** → ~$2,300/month + retrieval costs.

The hype around “tiered storage” in the last two years isn’t just vendor marketing. It’s a direct response to the **economic reality of cloud-scale event streaming**. The system that could solve this—hybrid storage—would win the hearts (and wallets) of every Infra team running PBs of logs.

But there’s a catch: object stores are **slow**. Latency for a single GET is 10-50ms vs. 0.1ms for a local NVMe. How do you give a consumer sub-millisecond tail latency on data that lives in a glacial archive?

You don’t. You **tier** it. And you **merge** it smartly.

---

## 🔧 The Architecture of a Tiered Shared Log

Let’s crack open the implementation. The core idea is simple: **separate the hot path (ingest/consume) from the cold path (retention/history)** . Practically, this means:

### 1. **Local Tier (Hot, Fast, Ephemeral)**

- On each broker, an NVMe SSD or RAM-backed segment storage.
- Acts as the write-ahead log (WAL) and the last-N-hours of data.
- **Target latency**: <1ms for reads/writes.
- **Retention**: hours to days (configurable).

### 2. **Object Store Tier (Cold, Cheap, Durable)**

- S3, GCS, or Azure Blob for long-term archival.
- Data is stored as immutable objects—typically after segment files are “sealed” (fully written, no new records).
- **Target latency**: 10-50ms per read, but acceptable because consumers rarely need _instant_ access to old data.
- **Retention**: weeks to years.

### 3. **Metadata Layer (The Glue)**

- A mapping from `(topic, partition, offset)` to `(object_key, byte_range)`.
- Often stored in a local key-value store (RocksDB, etc.) on the broker or in a dedicated metadata service (e.g., Apache BookKeeper for Pulsar, or the broker’s internal metadata for Redpanda).

---

## 🧩 Segment Merging: Why It’s Not Just “Append and Forget”

Here’s where it gets spicy. When you seal a local segment and upload it to S3, you’re creating an object. But your log is append-only: new data flows in every second. Over time, you end up with **thousands of tiny, partially filled objects** in S3. Each object has a name like `topic1-partition0-0000001234.log`. That’s fine for small clusters, but at petabytes, the cost of _listing_ objects and the overhead of _querying_ thousands of small files becomes prohibitive.

Enter **segment merging**—a background, batch operation that:

- **Reads multiple small, contiguous segments** from the object store.
- **Concatenates them** into a single, larger segment object (e.g., 1 GB → 100 GB for offloaded data).
- **Updates the metadata** so consumers see a single logical segment.
- **Deletes the tiny originals** (or marks them for garbage collection).

### Why This Matters Technically:

- **Reduced API costs**: S3 charges per `GET`/`PUT`/`LIST` request. Fewer, larger objects = significantly lower request costs.
- **Better read throughput**: Sequential scanning a 1 GB file is much faster (due to streaming reads) than opening and seeking through 100 tiny files.
- **Index optimization**: Merged segments allow for a single, contiguous byte-offset index rather than a sparse, fragmented one.

The merge scheduler itself is a fascinating piece of engineering. It must:

- **Deadlock avoid**: Don’t merge a segment that is currently being read by a consumer.
- **Compaction budget**: Bound the I/O impact on the broker (e.g., at most 20% of node bandwidth).
- **Consistency guarantee**: The read path must see a consistent view of merged segments (typically using a versioned metadata store like ZooKeeper, etcd, or the broker’s internal consensus).

---

## 🚀 Case Studies: How the Giants Implement This

Let’s look at three implementations that represent the frontier.

### **Apache Kafka 3.x with Tiered Storage (KIP-405)**

- **Approach**: New `RemoteStorageManager` interface. Kafka sends sealed segments to S3/GCS as objects. The local log is a sliding window; older data is evicted.
- **Segment merging**: Still nascent. Default behavior retains the one-segment-per-object pattern. Large clusters have reported significant S3 listing overheads due to millions of tiny objects. The community is exploring _log segment compaction_ (merging of duplicate key updates) but the full merging story remains incomplete.
- **Tradeoff**: Great for existing Kafka users, but the per-partition-per-segment overhead is non-trivial. The read path still requires fetching from remote, which can be a bottleneck for consumer lag recovery.

### **Apache Pulsar (with Apache BookKeeper + Tiered Storage)**

- **Approach**: Pulsar has always separated compute (broker) from storage (BookKeeper). Tiered storage adds a third layer—object store. BookKeeper entries are uploaded to S3 as a single “ledger” (a bookie of data).
- **Segment merging**: Pulsar does _not_ merge segments in the traditional sense. Instead, it uses a **log-unloading** strategy: when the local BookKeeper cache fills, it offloads entire entry logs (contiguous blocks) to S3. The read path uses a **two-level index**: first in BookKeeper’s metadata, then a range scan on the remote object. This avoids small-object explosion but requires careful index management.
- **Why it’s interesting**: Pulsar’s approach is arguably the cleanest for _infinite retention_ because it keeps the cost of reading old data logarithmic in the log size (via ledger-level indexes).

### **Redpanda (The New Kid on the Block, C++ / SMR)**

- **Approach**: Redpanda uses a **raft-based** consensus for local writes, then a separate **cloud storage tier** (S3) for archival. Their design is: every segment is “batch committed” locally (to local SSD) and then asynchronously uploaded to S3.
- **Segment merging**: Here’s where Redpanda shines. They implement _segment merging as a first-class background operation_ on the broker. They use a **compaction-style operation** (similar to RocksDB’s Level Compaction) to combine many small remote segments into one large one. They also support _data deduplication_ during merge: if two records have the same key, only the latest one is retained in the merged segment.
- **Technical nuance**: Redpanda avoids the metadata bottleneck by storing the remote segment index _inside the same object_ as the data (a metadata footer). This reduces the need for a separate metadata database.
- **Why it’s hot**: The performance is insane. They claim 10ms read tail latency for S3 data when the object is cached in the local disk cache (LRU). The merge scheduler uses **backpressure-aware I/O**: if the node is under write stress, merging pauses automatically.

---

## ⛓️ The Engineering Curiosities & Pain Points

This is where the rubber meets the road. Tiered storage sounds easy—just upload to S3, right?—but the devil is in the details.

### **1. Consistency at the Read Edge**

When a consumer asks for offset 1,234,567, the broker must decide: is it in local SSD, in a cached remote object, or in a cold S3 object? If it’s in a merged object, the byte offset might have changed. **Atomic metadata updates** are non-trivial. Most implementations use a **versioned log metadata segment** that is itself stored in the object store (e.g., a manifest file) and replicated via the broker’s consensus group.

### **2. The Caching Duality**

You can’t read every old record from S3. Brokers need a **read-through local cache** (e.g., LRU or LFU) of the most frequently fetched remote segments. But what happens when a consumer wants to read from partition 0 starting at offset 0? That’s a sequential scan of the entire history. Without caching, it’s going to be **painfully slow** (10-50ms per remote segment fetch). The clever fix: **prefetching** based on consumer offset progression. If a consumer is moving forward at 10 MB/s, the broker starts fetching the next 3 remote segments proactively.

### **3. Garbage Collection Hell**

After you merge five tiny objects into one big object, you need to delete the tiny originals. But what if a consumer is still reading one of them? The classic solution is **reference counting in the metadata layer**: an object is deleted only when all readers are past its end offset. Tracking this at high throughput (millions of consumer offsets) requires a **concurrent, write-optimized index** (e.g., a Cuckoo filter or a B-tree with epoch-based reclamation).

### **4. Network Bandwidth vs. Storage Cost**

Tiered storage shifts the bottleneck from disk I/O to network I/O. Each broker can upload at, say, 1 Gbps, but you have 10 brokers. That’s 10 Gbps total upload bandwidth. If you’re generating 8 Gbps of writes, your upload queue grows indefinitely. The broker must **rate-limit uploads** and **prioritize** local segment sealing. The common approach: **dedicated upload threads** with a token-bucket throttle.

---

## 🧠 The Future: Predictive Merging and Self-Tuning Storage

We’re not done. The next frontier is **predictive segment merging**. Instead of merging based on a fixed size threshold (e.g., merge when segment count > 50), the broker uses **ML or statistical models** to predict which segments will be accessed together. For example:

- **Time-based access patterns**: Most consumers read the last 24 hours. Segments older than that are rarely accessed together, so they can be merged aggressively.
- **Consumer lag correlation**: If two partitions are consumed at the same rate, their segments might be merged into a single object for better prefetching.

Also, watch for **erasure-coded tiered storage** (like LRC in Microsoft’s Azure Storage). Instead of 3x replication in S3, you write 8+4 parity fragments. This reduces storage costs by 30-40% but adds decoding overhead during reads. Implementations like **Pravega** already use erasure coding for the hot tier; expect the cold tier to follow.

---

## 🔥 The Operational Reality: What Running Tiered Storage Feels Like

Here’s the honest truth: tiered storage is not a silver bullet. You trade one set of problems for another.

**Before tiered storage**:

- Pain: Disk fills up, you add a broker.
- Pain: Rebalancing partitions takes hours.
- Horror: Brokers with slow disks cause cluster-wide lag.

**After tiered storage**:

- Pain: S3 request costs can spike if your merge strategy is wrong.
- Pain: Read latency for historical data can be 100ms+ if your local cache is cold.
- Horror: If your metadata database becomes inconsistent, entire partitions become unreachable.

But the **elasticity** is transformative. You can now run a cluster with, say, 10 brokers and 100 TB of retention. Without tiered storage, you’d need 50 brokers. That’s a 5x cost reduction in compute, plus lower operational overhead. The trade-off is worth it for any team operating at PB scale.

---

## 🎯 The Takeaway: If You’re Building (or Choosing) a Cloud-Native Broker

Tiered storage and segment merging are not optional anymore. They are the defining architectural features of a production-ready, cost-conscious event streaming platform. When evaluating a solution, ask these hard questions:

1. **What is the merge granularity?** Do you merge into fixed-size objects (like 1 GB) or unbounded? Unbounded segments can hit S3 object size limits (5 TB).
2. **How is the metadata stored?** Is it distributed (etcd, ZooKeeper) or local (RocksDB)? If the metadata is lost, can you rebuild it from the object store alone?
3. **What is the merge impact on read latency?** Does the broker pause reads during a merge operation? (Spoiler: good implementations don’t.)
4. **Can you control merging via configuration?** For example, merging only after 24 hours of inactivity on a partition. This is crucial for bursty workloads.

The future is not about storing everything fast. It’s about storing everything **appropriately**—hot, warm, cold—and moving data between tiers **seamlessly**. The shared log is evolving. It’s no longer a single-stream-of-consciousness; it’s a layered, adaptive, cost-aware storage engine that happens to also be a message broker.

Now go build something that streams forever—without going bankrupt.

---

_Got questions about your own tiered storage design? Hit me up in the comments. I’ll be here, staring at broker logs, trying to figure out why my merge scheduler just decided to compact a segment that was still being read by a consumer stuck at offset 0. It happens._ 😅
