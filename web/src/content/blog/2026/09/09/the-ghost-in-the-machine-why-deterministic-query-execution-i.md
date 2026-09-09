---
title: "The Ghost in the Machine: Why Deterministic Query Execution is the Final Frontier for Distributed NewSQL"
shortTitle: "Deterministic Execution: Final Frontier for Distributed NewSQL"
date: 2026-09-09
image: "/images/2026/09/09/the-ghost-in-the-machine-why-deterministic-query-execution-i.svg"
---

Imagine it’s 3:00 AM. Your distributed database—the backbone of a global fintech platform—is processing thousands of transactions per second across three continents. On the surface, the dashboards are green. Paxos is reaching consensus, the Raft logs are tailing perfectly, and the replication lag is sub-10ms.

Then, the "silent killer" strikes.

A routine audit script flags a discrepancy: Node A in US-East reports a user balance of $1,050.42. Node B in EU-West reports $1,050.41. It’s a single cent. You check the logs; both nodes received the exact same sequence of transactions in the exact same order. There were no network partitions, no hardware failures, and no bit-flips.

You’ve just encountered **Non-Replicable State Drift**. In the world of NewSQL and distributed systems, this is the ultimate nightmare. It’s the moment you realize that even if your nodes agree on the _order_ of events, they don't agree on the _result_ of those events.

Today, we’re diving deep into the engineering architecture required to solve this: **Deterministic Query Execution**. We’ll explore why traditional SQL engines are inherently chaotic, how we can virtualize "entropy," and how to build a query pipeline that guarantees bit-for-bit identity across a thousand-node cluster.

---

## The Illusion of Consensus

In the distributed systems hype cycle of the last decade, we spent most of our energy on the **Consensus Layer**. We fell in love with Raft and Paxos because they solved the "Order Problem." If Node 1 says `Command A` happened before `Command B`, then every other healthy node in the cluster eventually agrees.

But there is a dangerous assumption baked into most NewSQL architectures: **"If we execute the same command in the same order on two identical state machines, we will get the same output."**

In a modern, complex SQL engine, this assumption is fundamentally false.

Traditional engines like PostgreSQL or MySQL were designed for a single-box world. They are riddled with "Entropy Leaks"—sources of non-determinism that are invisible to the consensus layer but catastrophic for the state machine. If you want to build a true NewSQL engine (think CockroachDB, TiDB, or Google Spanner), you can't just slap Raft on top of a legacy executor. You have to rebuild the executor to be a deterministic sanctuary.

---

## The Usual Suspects: Sources of State Drift

Before we talk about the solution, we have to identify the enemies. In a distributed SQL environment, non-determinism enters the pipeline through four primary vectors.

### 1. The Temporal Trap: `CURRENT_TIMESTAMP`

This is the most obvious offender. If a query includes `UPDATE users SET last_login = NOW()`, every replica will evaluate `NOW()` at a slightly different wall-clock time. Even with PTP (Precision Time Protocol) or Google’s TrueTime, you are looking at microseconds of variance. In a high-concurrency system, that microsecond determines whether a record falls into a specific partition or triggers a time-based constraint.

### 2. The PRNG Poison: `RAND()` and `UUID()`

If your logic relies on generating a random discount code or a unique ID at the execution layer, you’re in trouble. Unless the seed is synchronized across the cluster (which adds massive latency), every replica will diverge the moment a `RAND()` function is called.

### 3. The IEEE 754 Floating-Point Quagmire

This is the one that keeps systems engineers up at night. Floating-point arithmetic is not guaranteed to be identical across different CPU architectures or even different compiler optimization levels.

- **Fused Multiply-Add (FMA):** One CPU might combine a multiply and an add into one instruction with one rounding step; another might do it in two steps with two rounding errors.
- **Intermediate Precision:** Some x86 instructions use 80-bit internal precision before dropping to 64-bit.
  If your SQL engine calculates interest rates using `FLOAT` or `DOUBLE`, Node A (on an Intel Ice Lake) and Node B (on an AMD Milan) might eventually drift by a few bits.

### 4. Relational Non-Determinism: `LIMIT` without `ORDER BY`

SQL is declarative. If you run `UPDATE accounts SET status = 'active' LIMIT 10`, the engine picks 10 rows. Without an explicit `ORDER BY` on a unique key, the "first 10" depends on the physical layout of the data on disk, the state of the B-Tree, or which shard responded first. On a replica undergoing a background compaction, those 10 rows might be different from a replica that is freshly booted.

---

## Architecture: Building the Deterministic Pipeline

To eliminate drift, we must move from **Unconstrained Execution** to a **Deterministic Sandbox**. This requires a fundamental re-architecture of the query lifecycle.

### The Deterministic Context (The "Sidecar" Pattern)

In our implementation, every query is wrapped in a `DeterministicContext`. Think of this as a virtualized environment that intercepts all calls to the "outside world."

When a leader node receives a query, it doesn't just replicate the SQL string. It performs a **Pre-Execution Trace**.

```go
// Simplified representation of a Deterministic Transaction Header
type DeterministicHeader struct {
    TxID          uint64
    Timestamp     int64    // The "Virtual" Wall Clock
    Seed          int64    // The PRNG Seed for this Tx
    MaxParallelism int      // Constraint on the scheduler
    SystemVars    map[string]string
}
```

The leader "freezes" the environment. It captures the current time and a high-entropy seed. This `Header` is then bundled with the SQL command into the Raft log. When the followers receive the log entry, they don't ask their own OS for the time or a random number. They "re-read" the environment from the header.

### Virtualizing Time and Randomness

Inside the executor, we override the standard function library.

```rust
// Instead of calling the OS, the SQL function calls the context
fn eval_now(ctx: &Context) -> DateTime {
    return ctx.frozen_timestamp;
}

fn eval_rand(ctx: &mut Context) -> f64 {
    // Each call evolves the seed deterministically for the next call
    ctx.current_seed = linear_congruential_generator(ctx.current_seed);
    return scale_to_float(ctx.current_seed);
}
```

This ensures that regardless of when or where the query runs, the "now" is identical. We have effectively decoupled logical time from physical time.

---

## The Hard Part: Deterministic Parallelism

Now we get into the heavy lifting. Modern databases are fast because they are highly concurrent. They use multi-core CPUs to scan partitions in parallel. However, concurrency is the natural enemy of determinism.

If you have a query that aggregates data from four shards, the order in which those shards return their results is non-deterministic (it depends on network congestion, disk I/O, and CPU scheduling). If your aggregation logic isn't **commutative and associative**, your state will drift.

### The Conflict: Parallel Scans vs. Order Guarantees

Consider a `SUM` operation on floating-point numbers. Because of rounding errors, `(A + B) + C` is not always equal to `A + (B + C)`. If Shard 1 returns data before Shard 2 on Node A, but Shard 2 wins on Node B, the final sum could differ in the least significant bits.

To solve this, we implement a **Deterministic Merge Layer**.

Instead of a "first-come, first-served" approach to processing internal result sets, we enforce a strict ordering based on the **Logical Shard ID**.

1.  Worker threads process shards in parallel.
2.  Results are pushed into a **Priority Buffer**.
3.  The Aggregator only pulls from the buffer in a predefined order (Shard 0, then Shard 1, etc.).

This introduces a slight "tail latency" risk—if Shard 0 is slow, the aggregator waits even if Shard 1 is ready. But this is the price we pay for absolute state integrity. In high-scale engineering, **correctness is a non-negotiable prerequisite for performance.**

---

## Engineering Curiosity: The Floating-Point "Bit-Symmetry" Problem

One of the most fascinating challenges we faced was cross-platform floating-point consistency. You might think, "Just use fixed-point decimals!" That works for currency, but what about scientific data, geolocation, or complex scoring algorithms?

We looked at how the gaming industry handles this (think _Age of Empires_ or _StarCraft_ synchronization). They use **Software-Based Floating Point units (SoftFloat)** or strict compiler flags.

In a NewSQL engine, we can’t afford the performance hit of SoftFloat for every calculation. Instead, we implement **Hardware-Specific Normalization**. During the "Handshake" phase when a node joins the cluster, it runs a suite of floating-point benchmarks. If the node’s CPU handles IEEE 754 rounding differently than the cluster's "Golden Standard," the node is forced into a "Compatibility Mode" where it uses software emulated math for sensitive operations.

Furthermore, we enforce **No-FMA (Fused Multiply-Add)** flags across the entire codebase to ensure that every CPU arrives at the same rounding error. It’s counter-intuitive: we are intentionally making the math slightly "less accurate" to ensure it is "perfectly consistent."

---

## Taming the Optimizer: Plan Stability

In a distributed database, the Cost-Based Optimizer (CBO) is the brain. It looks at table statistics and decides: "Should I use a Hash Join or a Merge Join?"

State drift can occur if Node A’s optimizer thinks a Hash Join is better while Node B’s optimizer (perhaps having slightly fresher statistics) chooses a Merge Join. While both should return the same rows, the _order_ of those rows will be different. If that result is used to insert into another table, the physical layout of the data on the replicas will diverge. Over time, this leads to "Performance Drift," where one replica becomes significantly slower than the others due to fragmented indices.

To eliminate this, we implement **Plan Locking in the Consensus Log**.

1.  The Leader generates the execution plan.
2.  The plan is serialized (usually into a Protobuf or JSON representation).
3.  The _entire plan_ is sent over the wire via Raft.
4.  Followers are forbidden from re-optimizing. They must execute the leader's plan literally, regardless of their local statistics.

This ensures that the "Execution Path" is just as deterministic as the "Data."

---

## The "Calvin" Approach: Is Deterministic Scheduling the Future?

We can't talk about determinism without mentioning the **Calvin** paper (which inspired databases like FaunaDB). While traditional NewSQL uses Paxos to agree on the _data_, Calvin-style systems use Paxos to agree on the _schedule_.

In a Calvin-based architecture, there is a global "Sequencer" that batches incoming transactions and pre-analyzes their "Read/Write Sets." It then creates a deterministic schedule that every node follows. Because the schedule is locked in, nodes can execute transactions in parallel without ever using traditional locks (like 2PL).

### Why hasn't everyone switched to Calvin?

While deterministic scheduling sounds like a silver bullet for state drift, it has a significant technical overhead: **Predictive Analysis**. To build a deterministic schedule, the engine needs to know exactly which rows a query will touch _before_ it runs it.
For a simple `UPDATE accounts SET balance = balance - 100 WHERE id = 5`, that’s easy.
For a complex `UPDATE users SET status = 'VIP' WHERE id IN (SELECT user_id FROM orders WHERE amount > 1000)`, it’s nearly impossible without a preliminary "reconnaissance" scan.

Most modern NewSQL engines (like the one we’re discussing) choose a **Hybrid Model**:

- Use standard Raft/Paxos for concurrency control.
- Use a **Deterministic Executor** to ensure the _application_ of the transaction is identical across replicas.

---

## The Impact on Scale and Reliability

Implementing this level of determinism isn't just about avoiding a one-cent discrepancy in a bank account. It unlocks massive engineering advantages for cluster operations:

### 1. Instant Replay Debugging

If a node crashes on a specific query, we can take the Raft log and the `DeterministicHeader` and replay that exact query on a developer's laptop. Because we’ve virtualized the entropy (time, seeds, plan), the query will fail in the exact same way, with the exact same bit-pattern. No more "it works on my machine."

### 2. Zero-Downtime Migration Between Architectures

With deterministic execution, you can have a cluster running a mix of ARM64 (AWS Graviton) and x86_64 nodes. Because you’ve handled the floating-point and instruction-set variances at the engine level, you can migrate data seamlessly across architectures without fear of the state diverging.

### 3. Non-Blocking Backups

If execution is deterministic, a backup is just a "Snapshot LSN" (Log Sequence Number). You don't need to lock the database to get a consistent view. You can just tell a follower, "Give me the state after you've deterministically applied log entry #5,000,210."

---

## Code Deep Dive: The Deterministic Merge Sort

Let’s look at a concrete example of how we handle one of the most common sources of drift: **Distributed Sorting**.

In a distributed system, a `SELECT * FROM logs ORDER BY level` query is dangerous. If multiple logs have the same `level`, the order is undefined. On Node A, "Error: Timeout" might come before "Error: Disk Full." On Node B, it might be reversed.

Here is how we implement a **Deterministic Merge** in our middleware layer (simplified Rust):

```rust
struct Record {
    primary_key: Vec<u8>,
    data: Vec<u8>,
    sort_key: i32,
}

/// A deterministic comparator that ensures even if the sort_key is a tie,
/// the result is stable across all replicas.
fn deterministic_compare(a: &Record, b: &Record) -> Ordering {
    // Primary Sort: The user-defined criteria
    let res = a.sort_key.cmp(&b.sort_key);

    if res == Ordering::Equal {
        // TIE-BREAKER: The Secret Sauce
        // We always fall back to the unique physical primary key
        // to guarantee bit-identical ordering.
        return a.primary_key.cmp(&b.primary_key);
    }

    res
}

/// Merges multiple sorted streams from different shards into one.
fn merge_shards(streams: Vec<Vec<Record>>) -> Vec<Record> {
    let mut heap = BinaryHeap::new();

    // Implementation uses the deterministic_compare...
    // This ensures that even if Shard 1 and Shard 2 return
    // identical values, they are merged in the same order
    // on every single node in the cluster.
}
```

By forcing every "undefined" sort to terminate in a comparison of the **Primary Key**, we eliminate the "Physical Layout Dependency" of the SQL engine.

---

## Contextualizing the Hype: Is this "Over-Engineering"?

In the current landscape of "Serverless Databases" and "Edge Computing," there is a lot of marketing noise about "Global Consistency." Many providers claim to be "Global," but when you look under the hood, they are actually **Eventual Consistency** systems with a "last-writer-wins" conflict resolution policy.

"Last-writer-wins" is fine for a social media "Like" count. It is **not** fine for an inventory management system, a ledger, or an identity provider.

The move toward **Deterministic Query Execution** is the industry's response to the limitations of simple consensus. We are realizing that `Agreement on Order != Agreement on State`. The hype around NewSQL isn't just about scaling—it’s about the massive engineering effort required to make a thousand machines behave like a single, perfectly predictable processor.

---

## The Path Forward

Building a deterministic distributed engine is a journey of a thousand edge cases. It requires auditing every single line of code for "Entropy Leaks." It means questioning the very way CPUs handle numbers and the way compilers optimize loops.

But the result is a system that is fundamentally more robust. When you eliminate non-deterministic drift, you don't just get a more accurate database; you get a system that is easier to debug, easier to scale, and—most importantly—a system you can trust at 3:00 AM when the transactions are flying and the world is watching.

As we move toward more complex distributed architectures, determinism will shift from a "nice-to-have" engineering curiosity to the foundational requirement for the next generation of data infrastructure. We are finally exorcising the ghost in the machine.

---

**Are you dealing with state drift in your distributed systems? Or have you found a novel way to virtualize entropy in your query pipeline? Let’s talk in the comments below.**
