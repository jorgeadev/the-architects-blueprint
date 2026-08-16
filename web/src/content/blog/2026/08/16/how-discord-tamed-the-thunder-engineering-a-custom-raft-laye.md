---
title: "How Discord Tamed the Thunder: Engineering a Custom Raft Layer over ScyllaDB for Exabyte-Scale Consensus"
shortTitle: "Discord's Custom Raft Layer for Exabyte-Scale ScyllaDB Consensus"
date: 2026-08-16
image: "/images/2026/08/16/how-discord-tamed-the-thunder-engineering-a-custom-raft-laye.svg"
---

Imagine it’s Sunday night. A massive global e-sports tournament just ended, or perhaps a legendary K-pop group just dropped a surprise teaser. Millions of users flood Discord simultaneously. Messages are flying at a rate that would melt most traditional infrastructures—tens of millions of events per second.

In the early days, Discord might have wobbled. But today, the experience is seamless. You hit "Enter," and your message appears instantly, perfectly ordered, across all your friends' devices. Behind that "instant" feel lies one of the most sophisticated distributed systems architectures in modern engineering.

To achieve this, we had to solve the "impossible" trinity of distributed systems: **Absolute Consistency, Exabyte Scale, and Sub-10ms Tail Latency.** This is the story of how we rebuilt our real-time messaging consensus layer by layering a custom, high-performance Raft implementation directly on top of ScyllaDB.

## The Scaling Wall: Why "Off-the-Shelf" Failed

For years, Discord relied on a mix of Cassandra and massive Redis clusters to manage message metadata and sequencing. As we crossed the threshold of trillions of messages, the cracks began to show.

1.  **The Cassandra "Stutter":** While Cassandra is a workhorse, its JVM-based architecture meant we were constantly fighting garbage collection (GC) pauses. When you’re aiming for sub-10ms p99s, a 200ms GC pause is an eternity.
2.  **The "LWT" Bottleneck:** We tried using Lightweight Transactions (LWT) in Paxos-based systems, but the round-trip overhead for every single message write was too high.
3.  **The Sequencer Dilemma:** To ensure messages appear in the same order for everyone (linearizability), you need a "sequencer." If your sequencer is a single point of failure or a bottleneck, the whole system grinds to a halt.

We didn't just need a faster database; we needed a way to perform distributed consensus—the act of multiple machines agreeing on the state of a message log—without the traditional "consensus tax."

## Why ScyllaDB? The Shard-Per-Core Advantage

Before we could build a consensus layer, we needed a substrate that could handle the raw I/O. We migrated from Cassandra to **ScyllaDB**, a C++ rewrite of Cassandra that utilizes a **shared-nothing, shard-per-core architecture.**

In ScyllaDB, each CPU core owns a specific subset of data and its own memory/network queue. There is no contention between cores. This allowed us to achieve predictable, ultra-low latency. But ScyllaDB alone isn't a consensus engine for application-level sequencing; it's a storage engine.

We decided to do something radical: **Treat ScyllaDB not just as a database, but as the persistent log-store for a custom Raft implementation.**

---

## The Architecture: Raft on the Rocks

Raft is a consensus algorithm designed to be understandable and robust. It typically involves a Leader node that receives commands, appends them to a log, and replicates that log to Follower nodes. Once a majority (quorum) acknowledges the write, the command is "committed."

Standard Raft implementations (like `etcd` or `HashiCorp Raft`) usually store logs on the local disk of the service nodes. At Discord’s scale, managing local disks for thousands of consensus groups is a DevOps nightmare.

**Our breakthrough was decoupling the Raft logic from the storage medium.**

### The "Mantle" Layer

we built a service internally nicknamed **Mantle**. Mantle acts as a thin, highly optimized consensus proxy.

1.  **Stateless Compute:** Mantle nodes do not store the message logs on their local NVMe drives.
2.  **ScyllaDB as the Log:** When a Raft Leader in Mantle receives a message, it writes the log entry to a specialized ScyllaDB table.
3.  **The Protocol:** We optimized the Raft RPCs to minimize the number of round trips between Mantle and ScyllaDB.

### Why this works:

By using ScyllaDB as the backing store for Raft logs, we inherited ScyllaDB's world-class replication, sharding, and availability. If a Mantle node dies, another node can instantly "pick up" the Raft Leadership because the entire state of the log is already persisted in the globally distributed ScyllaDB cluster.

---

## Deep-Dive: The Anatomy of a Sub-10ms Write

To hit a p99 of <10ms at exabyte scale, every microsecond counts. Here is how we optimized the consensus path:

### 1. Zero-Copy Serialization

We moved away from JSON and even standard Protobuf in high-hot-path areas. We utilize **FlatBuffers** for our internal Raft transitions. FlatBuffers allow us to access serialized data without a separate parsing/unpacking step, mapping the data directly into memory. This saved us significant CPU cycles on the Mantle nodes.

### 2. Pipelined AppendEntries

In standard Raft, the leader sends an `AppendEntries` RPC and waits for a response. We implemented **request pipelining**. The Leader can stream multiple log entries to followers (and ScyllaDB) without waiting for the previous one to be acknowledged, provided the sequence remains intact.

```rust
// A simplified look at our Pipelined Write logic
async fn handle_client_request(&self, cmd: Command) -> Result<Index, Error> {
    let index = self.raft_log.reserve_next_index();

    // Start writing to ScyllaDB immediately
    let persistence_future = self.scylla_backend.persist_async(index, &cmd);

    // Simultaneously broadcast to followers
    let replication_future = self.replicator.replicate_async(index, &cmd);

    // Wait for both persistence and quorum replication
    tokio::try_join!(persistence_future, replication_future)?;

    self.state_machine.apply(index, cmd).await
}
```

### 3. The "Shadow" Log Compaction

Raft logs can’t grow forever; they must be "compacted" or snapshotted. Traditionally, this is a heavy I/O operation that causes latency spikes.

We engineered a **Shadow Compaction** strategy. Since our logs are in ScyllaDB, we use ScyllaDB’s Time-To-Live (TTL) and Compaction Strategies (specifically `TimeWindowCompactionStrategy`) to automatically age out old Raft log entries. We don't perform manual snapshots in the application layer; we let the database's natural LSM-tree compaction handle the heavy lifting.

---

## Solving the "Super-Server" Problem

Discord has servers (guilds) with only three friends, and servers with over a million members. This creates a massive "hot partition" problem.

If a million people are in a single Discord server, the Raft Leader for that server's message sequence becomes a massive bottleneck. We solved this through **Dynamic Sharding of Consensus Groups.**

Instead of one Raft group per server, we split large servers into multiple "Consensus Shards."

- **Small Servers:** Shared among a pool of Raft groups to save overhead.
- **Mega Servers:** Dedicated, high-priority Raft groups pinned to specific high-performance ScyllaDB shards.

By using ScyllaDB's `shard_aware` drivers, the Mantle service knows exactly which CPU core on which ScyllaDB node holds the data for a specific Raft group. This allows the Mantle node to route the write directly to the correct core, bypassing the "hop" usually required by load balancers.

---

## The Exabyte Scale Challenge: Partitioning the Universe

When you’re dealing with exabytes of data, your primary enemy is **The Long Tail.** At 99.99% reliability, you still have thousands of requests failing or slowing down every hour.

To maintain our p99s, we implemented **Speculative Execution at the Consensus Layer.**

If a Mantle node sends a log replication request to a follower and doesn't get a response within a very tight window (e.g., 5ms), it doesn't just wait. It proactively initiates a "retry-to-alternate" or checks a secondary ScyllaDB replica. This effectively "clips" the tail latency by ensuring that a single slow disk or network hiccup doesn't stall the entire consensus flow.

### Data Layout in ScyllaDB

Our table schema is designed to prevent "partition bloating":

```sql
CREATE TABLE raft_logs (
    consensus_group_id uuid,
    log_index bigint,
    term int,
    payload blob,
    PRIMARY KEY (consensus_group_id, log_index)
) WITH CLUSTERING ORDER BY (log_index DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'HOURS', 'compaction_window_size': 1};
```

By using `log_index DESC`, the most recent messages (which are the most frequently accessed for consensus) are always at the top of the SSTable data blocks, making them extremely fast to retrieve from ScyllaDB’s row cache.

---

## Why This Matters: The Result

The migration to this Custom Raft + ScyllaDB architecture transformed Discord’s reliability.

- **P99 Latency:** Dropped from a jittery 50ms-150ms range to a rock-solid **7.4ms**.
- **Throughput:** We now handle over **20 million writes per second** across our messaging clusters.
- **Availability:** Because the Raft state is decoupled from the compute nodes, we can perform rolling restarts of our entire Mantle fleet without a single lost message or a perceptible "service unavailable" error.

We’ve moved past the era where "eventual consistency" was the best we could hope for at scale. By leveraging the low-level performance of C++/ScyllaDB and the mathematical rigor of Raft, we’ve built a system that treats every message as a mission-critical transaction, while maintaining the speed of a real-time chat app.

## The Engineering Curiosity: The "Ghost" Leader

One of the most interesting bugs we encountered during this build was the "Ghost Leader" scenario. In a high-churn environment, a node might think it's still the leader (due to a network partition) and keep trying to write to ScyllaDB.

We solved this using **ScyllaDB's Conditional Updates (LWT)** specifically for the `Leader_Elect` metadata. Before a Mantle node can commit a batch of messages to the log, it performs a lightweight check: "Am I still the owner of the `current_term` in the metadata table?"

Because ScyllaDB handles the linearizability of that metadata check, the Raft implementation remains "split-brain proof" even under extreme network stress.

---

## Looking Ahead

Building a custom consensus layer isn't for the faint of heart. It requires a deep understanding of distributed safety proofs, low-level I/O, and the specific quirks of your storage engine. For Discord, the investment paid off.

We aren't just storing messages; we're orchestrating a global conversation in real-time. By pushing the boundaries of what Raft can do when backed by a shard-per-core database like ScyllaDB, we’ve ensured that Discord can scale not just to the next million users, but to the next billion.

**Next time you send a `:ping:` in your favorite server, remember: you’re triggering a high-speed dance of distributed consensus that happens faster than you can blink.**
