---
title: "The Great Migration: Moving a Petabyte of Spanner Data Without Missing a Single Millisecond"
shortTitle: "Zero Downtime Petabyte-Scale Spanner Migration"
date: 2026-08-31
image: "/images/2026/08/31/the-great-migration-moving-a-petabyte-of-spanner-data-withou.svg"
---

Imagine this: You’re managing a fleet of Google Cloud Spanner instances. Your data footprint has swelled to 1.2 Petabytes. Your transaction volume is peaking at 4 million Queries Per Second (QPS). The business leadership comes to you with a "simple" request: We need to migrate the entire infrastructure from a regional configuration to a multi-regional configuration—or perhaps to a different project for organizational restructuring—without a single second of downtime.

In the world of small databases, this is a weekend project. In the world of Spanner at a petabyte scale, this is an engineering moonshot.

At this scale, standard tools start to smoke at the edges. You can’t just hit "Export" to a GCS bucket and "Import" on the other side. By the time your export finishes four days later, your source database has moved on by several billion rows. You are chasing a horizon that’s moving faster than you can run.

This is the story of how we built a custom, high-performance Change Data Capture (CDC) pipeline to orchestrate a zero-downtime migration of a petabyte-scale Spanner environment. We’re talking about sub-millisecond lag, massive parallel compute, and enough technical debt-shredding to satisfy any SRE's soul.

## The Architecture of the Impossible

When you’re dealing with Spanner, you aren't just dealing with a database; you’re dealing with a globally distributed, synchronously replicated beast. To move it without stopping the world, we needed a four-phase strategy:

1.  **The Snapshot (Backfill):** Copying the 1.2 PB of static data as it existed at a specific timestamp.
2.  **The Stream (CDC):** Capturing every `INSERT`, `UPDATE`, and `DELETE` that happens _after_ that timestamp.
3.  **The Reconciliation:** Merging the stream into the target without violating consistency.
4.  **The Cutover:** The "Golden Hour" where traffic is diverted with zero data loss.

### Why Standard Dataflow Templates Failed Us

Google provides "Dataflow to Spanner" templates. They are fantastic for most use cases. But at a petabyte scale, we hit three walls:

- **Throughput Bottlenecks:** The standard templates often struggle with the sheer volume of "mutations per second" required to catch up with a live-writing DB.
- **Cost Efficiency:** Running a Dataflow job of this size for weeks is an exercise in burning money.
- **Granular Control:** We needed custom logic for handling schema transformations on the fly—something the standard templates don't handle without significant "hacking."

We decided to build a **Custom CDC Pipeline** using Go, orchestrated on GKE (Google Kubernetes Engine), utilizing **Spanner Change Streams**.

---

## Under the Hood: The Custom CDC Pipeline

The heart of our solution was the **Spanner Change Stream**. Introduced a few years ago, Change Streams allow you to watch a Spanner database for changes in real-time. But a stream is just a list of events; you need an engine to process them.

### 1. The Distributed Orchestrator

We couldn't use a single process to read the stream. Spanner Change Streams are partitioned into "Shards." As the database grows or splits, the number of shards changes.

Our orchestrator was a Go-based service running on GKE that acted as a **Lease Coordinator**. It used a separate metadata Spanner table to track which worker was processing which shard. If a worker died, the lease would expire, and another worker would pick up the shard from the last known `commit_timestamp`.

### 2. Handling the "Mutation Limit"

Spanner has a strict limit: **80,000 mutations per transaction** (or 100MB of data).
When you are trying to sync millions of rows per second, you can't just send one row at a time. That’s too much gRPC overhead. You also can't send 1,000,000 rows in one go.

We built a **Smart Bufferer**. Our workers would collect change records and group them by `Table` and `Primary Key Hash`. They would dynamically calculate the "mutation weight" of each record. Once a buffer hit 60,000 mutations or 50MB, it would flush to the target Spanner instance. This allowed us to saturate the target's write capacity without hitting the dreaded `Transaction too large` error.

```go
// Simplified Buffer Logic
type MutationBuffer struct {
    mutations []spanner.Mutation
    weight    int
}

func (b *MutationBuffer) Add(m spanner.Mutation, w int) bool {
    if b.weight + w > 75000 { // Leave a buffer for safety
        return false
    }
    b.mutations = append(b.mutations, m)
    b.weight += w
    return true
}
```

### 3. The "Out-of-Order" Nightmare

Spanner Change Streams guarantee that within a single partition, records are delivered in order. However, across partitions, there is no such guarantee.

If a row is updated in Partition A and then deleted in Partition B (after a split), our pipeline might see the `DELETE` before the `UPDATE`. Applying a late `UPDATE` to a deleted row is a recipe for data corruption (or "ghost rows").

We solved this using **Commit Timestamps**. Every record in a Spanner Change Stream includes a `commit_timestamp`. Our sink workers implemented a **Conditional Write** logic:
_"Only update this row if the incoming record's timestamp is strictly greater than the target row's current `last_modified` timestamp."_

This turned our pipeline into an **idempotent system**. We could replay the same stream ten times, and the end state would always be correct.

---

## The Backfill: Moving the Mountain

While the CDC pipeline handled the "new" data, we still had to move the 1.2 PB of "old" data.

We used a **Parallel Partitioned Scan**. We didn't just run `SELECT *`. We used Spanner’s `BatchReadOnlyTransaction` API. This allows you to generate "Partitions" (small slices of the data) that can be read by different workers in parallel.

### Compute Scale

To move the data quickly, we spun up a GKE cluster with **4,000 vCPUs**.

- **The Producers:** 2,000 vCPUs dedicated to reading from the source Spanner.
- **The Consumers:** 2,000 vCPUs dedicated to writing to the target.

We were moving data at a sustained rate of **15 GB/s**. At this rate, we moved the bulk of the petabyte in roughly 24 hours.

The trick here was **Warm-up**. You cannot just blast a brand-new Spanner instance with 15 GB/s. Spanner needs to "learn" how to split its data across nodes. We had to pre-split the target tables by providing a set of "Split Points" (range boundaries for primary keys) so that the load was distributed across all 500 nodes in the target cluster from minute one.

---

## Engineering Curiosities: The "Ghost in the Machine"

During the migration, we encountered a fascinating phenomenon: **Split Storms.**

As we were writing massive amounts of data to the target instance, Spanner’s internal load balancer was constantly splitting and moving "Tablets" (the internal storage unit of Spanner) to balance the load. Every time a split happened, the CDC pipeline would see a momentary spike in latency as the gRPC connections were re-routed.

We discovered that if we didn't tune our gRPC `KeepAlive` settings and `MaxBackoff` parameters, the workers would get stuck in a "retry loop" that actually exacerbated the split storm. By loosening the backoff and increasing the connection pool size per worker, we allowed the system to "breathe" through the splits.

---

## Validation: Trust, but Verify (with Math)

You don't move a petabyte of data and just "hope" it’s all there. We needed a validation layer.

We couldn't do a `SELECT COUNT(*)` because that would take forever and might impact production performance. Instead, we used a **Merkle Tree-inspired sampling strategy.**

1.  **Hash Buckets:** We divided the primary key space into 10,000 buckets.
2.  **Sampling:** Within each bucket, we picked a random sample of 1,000 rows.
3.  **Consistency Check:** We calculated a cryptographic hash of the row content on both the source and target.
4.  **Verification:** If the hashes matched for all samples in a bucket, the bucket was marked as "Clean."

For the final 100% verification, we used a **Dataflow job that compared the two databases at a specific timestamp** (using Spanner’s stale reads). It didn't move any data; it just calculated a rolling checksum of every single row. It took 12 hours to run, but when it returned `MATCH`, the engineering team finally slept for the first time in a week.

---

## The Cutover: The Final Frontier

The CDC pipeline had been running for three days. The lag was hovering around **45 milliseconds**. We were ready.

The cutover was managed via a **Weighted Traffic Shift** at the API Gateway level (we used Envoy/Istio).

- **T-Minus 10 Minutes:** We increased the target Spanner's node count to 150% of its expected need to handle any "startup" cache misses.
- **T-Minus 2 Minutes:** We flipped our application logic to "Dual Write" mode (writing to both source and target, but treating source as the source of truth).
- **T-Zero:** We shifted 1% of read traffic to the target. Monitoring went wild—but the latencies were perfect.
- **T-Plus 5 Minutes:** 10%, 25%, 50%.
- **T-Plus 15 Minutes:** 100% of traffic on the target.

The "Undo" button was simple: since the CDC pipeline was still technically capable of running in reverse (if we had set it up that way), we kept the old instance alive for 24 hours just in case a hidden bug surfaced. It didn't.

---

## Why This Matters

This wasn't just about moving data; it was about proving that **at cloud scale, architecture is everything.**

Many engineers fear migrations. They see them as risky, "keep-the-lights-on" work. But building a custom CDC pipeline at this scale is pure distributed systems engineering. It requires an understanding of:

- **LSM Trees:** How Spanner stores data on disk.
- **Paxos/TrueTime:** How Spanner ensures global consistency.
- **Backpressure:** How to prevent a fast producer from drowning a slow consumer.
- **Idempotency:** How to survive in a world where "at least once" delivery is the best you can get.

If you’re facing a migration like this, don't just reach for the default tools. Look at the primitives—Change Streams, Batch Reads, and high-performance compute. Sometimes, the only way to move a mountain is to build your own shovel.

### Technical Checklist for Your Migration:

- **Pre-split your target:** Avoid "Hot Spotting" on day one.
- **Use Commit Timestamps:** Ensure your pipeline is idempotent.
- **Monitor 'Change Stream Lag':** This is your most important metric.
- **Optimize gRPC:** Tune your connection pools and retries.
- **Don't skip the Verification:** Use hash-based sampling to prove data integrity.

In the end, we didn't just move a petabyte. We moved the needle on what our infrastructure was capable of. And we did it all while our users were busy clicking, buying, and scrolling, completely unaware that the ground beneath their data had shifted thousands of miles.

That is the beauty of a perfect migration. It is the most impressive thing that nobody ever notices.
