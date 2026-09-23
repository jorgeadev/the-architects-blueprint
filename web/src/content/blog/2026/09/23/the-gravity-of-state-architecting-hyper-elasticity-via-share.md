---
title: "The Gravity of State: Architecting Hyper-Elasticity via Shared Logs and the Polaris Paradigm Shift"
shortTitle: "Polaris Paradigm: Architecting Hyper-Elastic State via Shared Logs"
date: 2026-09-23
image: "/images/2026/09/23/the-gravity-of-state-architecting-hyper-elasticity-via-share.svg"
---

In the early days of distributed systems, we were taught a fundamental lie: that compute and storage must live together to be fast. The "Data Locality" mantra of the Hadoop era dictated that moving code to data was the only way to scale. But as cloud-native architectures matured, we realized that data locality was actually a golden handcuff. It tied our ability to scale compute to the physical limitations of the disks attached to it.

Then came the Great Decoupling.

Today, we are witnessing the second act of this architectural revolution. We have moved beyond simple disaggregation into the era of **Hyper-Elasticity**. This is a world where compute can spin up in milliseconds, storage is virtually infinite, and the "Shared-Log" model provides a unified source of truth across disparate engines.

At the center of this storm are two titans: **Snowflake**, the pioneer of the disaggregated data warehouse, and **Databricks**, which recently threw a massive wrench into the machinery with the release of **Polaris**.

This isn't just about "storing data in the cloud." It’s about how we manage state in a world where the storage layer is a "dumb" object store and the compute layer is a fleet of transient, stateless executors. Let’s dive into the guts of how these systems actually work.

---

## The Architectural Bottleneck: The "Siloed State" Problem

Before we look at the solutions, we have to understand the enemy. In traditional MPP (Massively Parallel Processing) databases, each node owned a slice of the data. If you wanted to double your compute power, you had to re-partition your entire dataset—a process that took hours or days, during which the system was often degraded or offline.

The shift to S3, Azure Blob Storage, and GCS changed the game. These are not just "folders in the sky"; they are high-throughput, highly durable, but **high-latency** block stores. To build a high-performance database on top of them, you can't treat them like a local SSD. You have to treat them as a **Shared-Log**.

### What is a Shared-Log Architecture?

In a shared-log model, the database doesn't "overwrite" files. It appends to a log. Every insert, update, and delete is an entry in a metadata log that points to immutable data files (usually Parquet or Snowflake’s proprietary FDN format).

This architecture provides three critical properties:

1.  **Immutability:** Once a data file is written, it never changes. This eliminates the need for complex distributed locking on the storage layer.
2.  **Snapshot Isolation:** By reading a specific point in the log, every query sees a consistent view of the database without blocking writers.
3.  **Zero-Copy Operations:** Want to clone a multi-petabyte database? You don't copy the data; you just copy the pointers in the log.

---

## Snowflake’s Secret Sauce: The Global Metadata Layer

Snowflake’s rise to dominance wasn't just about its "Virtual Warehouses"; it was about its **Global Metadata Layer**.

In Snowflake’s architecture, there are three distinct tiers:

1.  **Centralized Storage:** The "Bottomless" S3 bucket containing micro-partitions.
2.  **Multi-Cluster Compute:** Stateless Virtual Warehouses that pull data from S3 and cache it on local SSDs.
3.  **Cloud Services:** The "Brain" of the operation.

### Deep Dive: Micro-Partitioning and Pruning

Snowflake doesn't use traditional indexes (B-Trees). Instead, it uses **Micro-Partitions**. Every table is automatically divided into contiguous units of storage (50MB to 500MB uncompressed).

The Cloud Services layer stores metadata for every single micro-partition, including:

- The Min/Max values of every column.
- The number of distinct values.
- The "bloom filters" for rapid lookups.

When you run a query like `SELECT * FROM orders WHERE order_date = '2023-10-01'`, the compute engine doesn't scan S3. It asks the Metadata Layer: _"Which files contain this date?"_ The Metadata Layer returns a list of specific S3 URIs. This is **Pruning**, and it’s the reason Snowflake can query petabytes in seconds.

### The Transactional Log as a Service

Snowflake implements a proprietary version of Multi-Version Concurrency Control (MVCC). Every transaction is assigned a timestamp. The "Log" is actually a set of FoundationDB clusters (Snowflake’s internal metadata store) that manage the mapping of table versions to micro-partition sets.

When a `DELETE` happens, Snowflake doesn't remove the file. It records in the log that `File_A` is no longer part of the "Current Version" and `File_B` (the new version) is. This is what enables **Time Travel**. You can literally query the log at a specific timestamp, and the system reconstructs the state of the world at that moment.

---

## The Databricks Pivot: From Lakehouse to Polaris

While Snowflake built a "walled garden" (albeit a very high-performance one), Databricks took a different path. They started with Spark and evolved into the **Lakehouse**.

The Lakehouse philosophy is: _Keep your data in open formats (Parquet) and use an open transaction layer (Delta Lake/Iceberg)._

However, there was a glaring problem: **The Catalog Lock-in.**

Even if your data is in Parquet, the "Shared Log" (the metadata that says which Parquet files make up a table) was often trapped inside a specific vendor's catalog (like Unity Catalog or Snowflake's internal metadata). If you wanted to query a Delta table with a Snowflake engine, or an Iceberg table with a Trino engine, you ran into "Metadata Friction."

### Enter Polaris: The Universal Catalog

The hype surrounding **Databricks Polaris** isn't just marketing fluff; it’s a technical solution to the "Multivendor Shared-Log" problem.

Polaris is an open-source implementation of the **Apache Iceberg REST Catalog API**. It acts as a central, vendor-neutral "Brain" that manages the shared log for your entire data ecosystem.

#### How Polaris Works Under the Hood

When a compute engine (Spark, Flink, Trino, or even Snowflake) wants to read a table managed by Polaris, the flow looks like this:

1.  **The Handshake:** The engine sends a GET request to the Polaris REST endpoint: `GET /v1/namespaces/sales/tables/orders`.
2.  **Metadata Location:** Polaris doesn't return data. It returns a JSON response containing the **Metadata File Location** (a `.metadata.json` file in S3).
3.  **Snapshot Discovery:** The engine reads that JSON file. This file is the "Shared Log." It contains a list of "Manifests," which in turn list the "Data Files."
4.  **Credential Vending:** This is the brilliant part. Polaris provides **short-lived, scoped-down credentials** to the compute engine. The engine can _only_ read the specific S3 objects needed for that table.

```json
// Example of the Iceberg Metadata returned via Polaris/REST
{
    "format-version": 2,
    "table-uuid": "eb838722-02ee-11ed-b939-0242ac120002",
    "location": "s3://my-bucket/orders/",
    "last-updated-ms": 1658320000000,
    "snapshots": [
        {
            "snapshot-id": 1,
            "manifest-list": "s3://my-bucket/orders/metadata/snap-1.avro",
            "summary": { "operation": "append" }
        }
    ],
    "current-snapshot-id": 1
}
```

By standardizing this "Shared Log" access, Polaris allows different engines to have a consistent view of the state. You can have Databricks writing to a table and Snowflake reading from it _simultaneously_ without the data ever being out of sync.

---

## Hyper-Elasticity: The Engineering Challenges of Scale

Moving from "Elastic" to "Hyper-Elastic" requires solving two massive engineering hurdles: **Metadata Scalability** and **Compute Warm-up**.

### 1. The Metadata Wall

In a disaggregated model, the metadata layer is the new bottleneck. If you have a table with 10 million micro-partitions, the JSON file describing them becomes massive.

- **Snowflake’s Solution:** They use a hierarchical metadata structure. They don't just store "files"; they group files into "statistically similar clusters." Their metadata service is essentially a massive, distributed Key-Value store (built on FoundationDB) that can scale horizontally.
- **Iceberg/Polaris Solution:** Iceberg uses a "Manifest List" -> "Manifest" -> "Data File" hierarchy. This allows engines to perform "Metadata Pruning." An engine can read a tiny manifest list and skip 90% of the metadata files, preventing the "Metadata Wall" from crashing the driver node.

### 2. The Cold Cache Problem

In a shared-log architecture, the compute nodes are stateless. This is great for elasticity but terrible for performance. If a new Virtual Warehouse spins up, its local SSD is empty. Every read has to go to S3, which has a latency of ~100-200ms compared to <1ms for local NVMe.

To achieve **Hyper-Elasticity**, both systems use aggressive caching strategies:

- **Lazy Caching:** As data is pulled from S3, it’s written to the local SSD. Subsequent queries on the same node are "warm."
- **Consistent Hashing:** Snowflake ensures that specific micro-partitions are routed to the same compute nodes whenever possible. If you query "Orders" twice, the request goes to the same "Worker Node" that already has those files cached.
- **Pre-fetching:** Modern engines analyze query plans to start streaming data from S3 _before_ the previous processing stage is even finished.

---

## Comparison: Snowflake's Managed Experience vs. Polaris's Open Ecosystem

| Feature              | Snowflake (Proprietary Shared-Log)                 | Databricks Polaris (Open Shared-Log)                        |
| :------------------- | :------------------------------------------------- | :---------------------------------------------------------- |
| **State Management** | Centralized, proprietary Cloud Services.           | Decentralized, Apache Iceberg REST API.                     |
| **Interoperability** | Primarily via "Iceberg Tables" (recent addition).  | Native interoperability with any Iceberg-compatible engine. |
| **Concurrency**      | Managed via a global lock service in FoundationDB. | Optimistic Concurrency Control (OCC) via the Catalog.       |
| **Governance**       | RBAC managed within Snowflake.                     | OIDC/OAuth integrated with the Polaris service.             |
| **Storage Format**   | FDN (Proprietary) or Iceberg.                      | Iceberg (Open Standard).                                    |

---

## Why the Industry is Shifting Toward "Polaris-Style" Interoperability

The tech world is currently obsessed with Polaris for one simple reason: **Vendor Leverage.**

For years, moving from Snowflake to Databricks (or vice-versa) meant a massive data migration project. By adopting a Shared-Log model based on an open standard like Iceberg and a neutral catalog like Polaris, the "State" of your data is no longer owned by the vendor. It’s owned by you, in your S3 bucket, in a format anyone can read.

This creates a "Compute Auction" environment. If Snowflake is too expensive for a specific batch job, you can point a spot-instance Spark cluster at the Polaris catalog and run the job for 1/10th the cost, without moving a single byte of data.

---

## Engineering Curiosities: The "Small File" Problem

One cannot talk about shared-log architectures without mentioning the "Small File" nightmare. In a system where every write creates a new immutable file, frequent small inserts (like streaming data from Kafka) result in millions of 1KB files.

This kills performance because S3's overhead for opening a file is the same regardless of its size.

- **Snowflake's background processes** (which you don't see or pay for directly) are constantly "compacting" these micro-partitions in the background. They take five 1MB files and rewrite them into one 5MB file, updating the Shared-Log metadata atomically.
- **Databricks/Iceberg** requires an "Optimize" or "Compaction" command (often automated via Auto-Optimize).

This background compaction is the "garbage collection" of the modern data stack. Without it, hyper-elasticity eventually leads to architectural collapse.

---

## The Path Forward: Stateless Everything

We are moving toward a future where the database is no longer a "thing" you install, but a collection of loosely coupled services.

1.  **The Storage Layer:** S3/GCS (The Data).
2.  **The Shared-Log/Catalog:** Polaris/Unity/Snowflake (The Truth).
3.  **The Compute Layer:** Spark/Snowflake/Trino/DuckDB (The Muscle).

The brilliance of the Shared-Log and Disaggregated Storage model is that it treats data as **Gravity**. Data has mass; it's hard to move. By decoupling the "Log" (the metadata) from the "Data" (the files) and the "Compute" (the logic), we’ve finally figured out how to let the muscle move fast without being crushed by the weight of the gravity.

Whether you choose the polished, integrated experience of Snowflake or the open, flexible architecture of Polaris, the underlying engineering principle is the same: **In the cloud, state is the enemy of scale. Solve the state problem via a shared, immutable log, and hyper-elasticity follows.**
