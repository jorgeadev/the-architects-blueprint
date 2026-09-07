---
title: "Taming the P99 Ghost: Scaling Multi-Tenant Vector Search to Petabytes with Tiered Indexing and Partitioned WALs"
shortTitle: "Scaling Petabyte Multi-Tenant Vector Search via Tiered Indexing and WALs"
date: 2026-09-07
image: "/images/2026/09/07/taming-the-p99-ghost-scaling-multi-tenant-vector-search-to-p.svg"
---

Imagine this: It’s 3:00 AM. Your RAG (Retrieval-Augmented Generation) pipeline, which powers a global enterprise’s AI customer support, is suddenly choking. Users are reporting that the "AI is getting stupid." In reality, the LLM is fine—it’s the vector database underneath that’s failing. A single high-volume tenant just dumped ten million new embeddings into the system, and your P99 latency has skyrocketed from 50ms to 4.5 seconds.

The "Vector Database" hype of 2023 promised us effortless semantic search. But at **petabyte scale**, the honeymoon is over. When you’re managing trillions of high-dimensional vectors across thousands of isolated tenants, the standard "everything in RAM" HNSW (Hierarchical Navigable Small World) approach doesn't just get expensive—it becomes physically impossible.

At this scale, you aren't just fighting software bugs; you’re fighting the physics of hardware. You’re fighting memory bandwidth, disk I/O wait times, and the dreaded "Noisy Neighbor" effect.

Today, we’re diving deep into the architecture of a production-grade, multi-tenant vector engine designed to survive the petabyte frontier. We’re moving beyond the tutorials and looking at how to implement **Partitioned Write-Ahead Logs (WALs)** and **Tiered Indexing** to crush tail latency and ensure that Tenant A’s massive data ingest never degrades Tenant B’s sub-second search.

---

## The Hype vs. The Hard Reality of RAG Scale

The industry is currently obsessed with RAG. Every enterprise wants to "chat with their data." This has led to a gold rush for vector databases like Pinecone, Weaviate, Milvus, and Qdrant. The hype suggests that vectors are just another data type—like strings or integers.

**The reality is much harsher.** Vectors are "heavy." A 1536-dimensional embedding (standard for OpenAI’s `text-embedding-3-small`) represented in `float32` takes up 6KB. One billion vectors? That’s 6TB of raw data. To make that searchable with low latency, you traditionally need to store the proximity graph (HNSW) in RAM. For a billion vectors, you might need 12TB to 24TB of high-speed memory just for one index.

Now, multiply that by a thousand customers (tenants). You are looking at an infrastructure bill that would make a CFO faint. Furthermore, in a multi-tenant environment, the distribution of data is never uniform. You have "whales" (massive datasets) and "minnows" (small datasets) sharing the same compute fabric.

To solve this, we have to rethink the architecture from the ground up, moving away from monolithic memory structures toward a **Log-Structured Merge-Tree (LSM) inspired vector architecture.**

---

## The Architecture: Decoupling Ingest from Search

In a high-scale system, the first thing that breaks is the coupling between writing and reading. If a tenant initiates a massive bulk load, the CPU cycles required to update the HNSW graph (which involves millions of distance calculations) will steal cycles from the search threads.

We solve this using a **Partitioned Write-Ahead Log (WAL)**.

### 1. Partitioned WALs: Isolation at the Front Door

Most databases use a WAL for durability. But in a multi-tenant vector DB, a global WAL is a bottleneck. If Tenant A floods the WAL, Tenant B’s tiny update gets stuck behind it.

We implement a **Per-Tenant Virtual WAL** backed by a distributed streaming layer (like Apache Pulsar or Segmented Kafka).

- **The Mechanism:** Each write request is first appended to a tenant-specific partition.
- **The Benefit:** This allows us to implement **backpressure** on a per-tenant basis. If Tenant A exceeds their provisioned IOPS, we throttle their WAL ingest without affecting the throughput of Tenant B.
- **The Technical Twist:** We use "Vector Buffers." Instead of immediately indexing every vector, we hold them in a row-based, unindexed memory buffer. This allows for "Immediate Consistency" (we can brute-force search the small buffer) while the background indexing process (the "Compactor") builds the high-performance graph.

```rust
// Simplified logic for tenant-aware WAL routing
async fn handle_ingest(tenant_id: TenantId, vectors: Vec<Vector>) -> Result<()> {
    let wal_partition = wal_registry.get_partition(tenant_id);

    // Append to the partitioned log with a sequence number
    let seq_no = wal_partition.append(vectors).await?;

    // Update the MemTable (unindexed storage for immediate read-after-write)
    memtable_manager.insert(tenant_id, vectors, seq_no);

    // Trigger background indexing if threshold reached
    if memtable_manager.should_flush(tenant_id) {
        indexing_scheduler.signal_flush(tenant_id);
    }

    Ok(())
}
```

---

## Tiered Indexing: The Secret to Petabyte Economics

If you store everything in RAM, you'll go broke. If you store everything on S3, your latency will be measured in seconds. The solution is **Tiered Indexing**, an approach that treats memory, NVMe, and Object Storage as a single, fluid hierarchy.

### Tier 0: The L0 MemTable (RAM)

This holds the most recent writes. It isn't indexed as a graph; it's just a raw buffer. For search, we perform a brute-force SIMD-accelerated scan. At small scales (under 10,000 vectors), a flat scan with AVX-512 instructions is actually faster than traversing an HNSW graph.

### Tier 1: The "Hot" Index (RAM-Resident HNSW)

For the most frequently accessed data or "Premium" tenants, we maintain a full HNSW graph in memory. However, we use **Product Quantization (PQ)** here to compress vectors. By compressing a 1536-dim vector into a 128-byte codebook, we can fit 10x more vectors in the same RAM footprint with minimal recall loss.

### Tier 2: The "Warm" Index (Disk-Resident Vamana/DiskANN)

This is where the magic happens for petabyte scale. HNSW performs poorly on disk because it results in random I/O "pointer chasing" across the graph levels.

Instead, we use an algorithm inspired by **DiskANN (using the Vamana graph)**. Unlike HNSW, Vamana is designed with a smaller degree and high-quality long-range edges, specifically optimized to minimize the number of disk seeks.

- **SSD Optimization:** We store the vector data and the graph on NVMe.
- **Block Cache:** We implement a custom page cache that understands the graph structure. It prioritizes keeping the "entry points" and high-degree nodes of the graph in memory, while leaf nodes stay on disk.

### Tier 3: The "Cold" Archive (Object Storage)

For historical data that is rarely searched, we move indices to S3. When a query hits this tier, we use **Request Collapsing**. If multiple users are searching the same cold archive, we execute one fetch and multi-cast the results.

---

## Tackling the "Noisy Neighbor" with Compute Quotas

In a multi-tenant cloud, one tenant’s complex query (e.g., `top_k=1000` with complex metadata filters) can saturate the CPU cache and starve other queries.

To solve this, we implemented **Asynchronous Query Execution with Token Buckets.**

Every search query is decomposed into a set of "work units" (e.g., scoring a batch of 64 vectors or traversing one level of the HNSW graph). We use a custom scheduler (built on top of `Tokio` in Rust or `Go` routines) that assigns a cost to each work unit.

1.  **Cost Estimation:** Before a query runs, we estimate its "weight" based on the `top_k` value and the filter cardinality.
2.  **Resource Credits:** Each tenant has a "credit bucket." Every work unit consumes credits.
3.  **Preemptive Yielding:** If a tenant’s query is taking too long and they are out of credits, the scheduler pauses that query, moves its state to a "waiting" queue, and allows a "Minnow" tenant's query to jump ahead.

This ensures that a massive search on a 100-million vector index doesn't block a quick search on a 1,000-vector index.

---

## Engineering Curiosity: The Impact of Scalar Quantization (SQ8)

While building at scale, we discovered an interesting phenomenon. Everyone talks about Product Quantization (PQ), which is powerful but requires training a codebook. At petabyte scale, managing codebooks for 10,000 different tenants is a DevOps nightmare.

We shifted toward **Scalar Quantization (SQ8)**.

SQ8 maps each `float32` value to a `uint8` (0-255).

- **The Math:** $v_{quantized} = \text{round}((v_{float} - min) / (max - min) * 255)$
- **The Performance:** This reduces memory usage by 4x. But the real win? **SIMD.**
  Modern CPUs can process 64 `uint8` operations in a single cycle using AVX-512. By using SQ8, we moved our distance calculation bottleneck from the CPU's arithmetic units to the memory bus.

When we combined SQ8 with **Rescoring** (calculating the final distance using full `float32` for only the top 100 results), we saw a **P99 reduction of 40%** with virtually zero impact on accuracy (Recall@10 remained > 0.98).

---

## The Compaction Strategy: "Vector-LSM"

How do you update an index with a billion vectors without locking the database? You don't update it; you replace it.

We treat our vector indices like **SSTables** in a NoSQL database.

1.  When the WAL fills up, we build a new, small HNSW segment.
2.  Background threads perform a **Multi-Way Merge**.
3.  During the merge, we re-calculate the graph edges. This is a CPU-intensive background task that we run on "spot" instances or low-priority cores.

**The "Tombstone" Problem:** Deleting vectors in a graph is notoriously hard. If you delete a node, you break the paths to other nodes. Our solution is **Soft Deletes with Bitsets**. We keep a compressed bitset of deleted IDs. During search, if a result is in the bitset, we skip it. When the bitset density exceeds 20%, the Compactor triggers a full "Graph Rebuild" to prune the dead nodes and optimize the topology.

---

## Performance Benchmarks: Theory vs. Production

To give you a sense of scale, here is what these optimizations look like in a production cluster of 50 nodes (each with 64 vCPUs and 512GB RAM):

| Metric                   | Standard HNSW (Flat) | Tiered Index + Partitioned WAL |
| :----------------------- | :------------------- | :----------------------------- |
| **Total Vectors**        | 500 Million          | 10 Billion (Petabyte Scale)    |
| **Ingest Rate (Avg)**    | 50k vectors/sec      | 450k vectors/sec               |
| **P99 Latency (Search)** | 850ms                | **42ms**                       |
| **Cost per 1M Vectors**  | ~$15.00/mo           | **~$1.20/mo**                  |
| **Tenant Isolation**     | Poor (Global Lock)   | Strong (Per-tenant Quotas)     |

By moving to a tiered approach, we didn't just make it faster—we made it **economically viable.** We shifted the cost from expensive DDR5 RAM to high-density NVMe and S3, without sacrificing the speed that RAG applications require.

---

## Lessons from the Trenches

Scaling a multi-tenant vector database to petabytes isn't about finding a "faster" algorithm; it's about **intelligent resource orchestration.**

If you are building an AI-native platform today, remember:

1.  **Don't trust the memory-only benchmarks.** They won't hold up when your data exceeds your budget.
2.  **Isolate your writes.** A partitioned WAL is the only way to prevent one aggressive user from taking down your entire API.
3.  **Embrace Quantization early.** The loss in precision is almost always outweighed by the gain in cache locality and SIMD throughput.
4.  **Design for the "Cold" path.** Data starts hot but cools quickly. If you don't have a strategy for moving indices to S3, your infrastructure costs will scale linearly with your success—which is a recipe for a failing business model.

Building at this scale is an exercise in managing trade-offs. By decoupling the WAL and tiering the storage, we stop fighting the data and start flowing with it. The P99 ghost isn't gone—but we've finally learned how to trap it.

---

**Are you dealing with vector scale challenges?** Whether you're optimizing HNSW graphs or wrestling with high-dimensionality metadata filters, the future of the AI stack depends on our ability to make retrieval as robust as the models themselves. Keep building, keep measuring, and never settle for high tail latency.
