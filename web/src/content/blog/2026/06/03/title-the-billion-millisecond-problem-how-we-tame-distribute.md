---
title: "Title: The Billion-Millisecond Problem: How We Tame Distributed Transactions Across Three Continents"
shortTitle: "Distributed Transactions Across Three Continents"
date: 2026-06-03
image: "/images/2026/06/03/title-the-billion-millisecond-problem-how-we-tame-distribute.jpg"
---

**So you want to run a bank. Or a global booking system. Or maybe just keep a shopping cart in sync between New York, Singapore, and Frankfurt.**

You’ve got 200 servers, 5 regions, and a boss who expects ACID transactions with **sub-100ms latency** across the Atlantic. The database whitepapers all promise "strong consistency." Your SRE team is looking at you with the kind of exhaustion usually reserved for Kubernetes upgrades at 3 AM.

Welcome to the **hardest problem in distributed systems**—or, as I like to call it, _Tuesday_.

---

## The Hook: Why Your "Simple" SQL Database is Lying to You

Let’s start with an uncomfortable truth. **95% of "multi-region" setups you see in production aren’t actually providing global strong consistency.** They’re offering _eventual consistency with a really good haircut_—read-after-write semantics, quorum-based reads, maybe a sprinkle of CRDTs on the side.

But here’s the rub: _when your application requires true serializability_—meaning every transaction appears to execute in some total order, globally—all the standard tricks break. CAP theorem isn’t just a buzzword; it’s a **straitjacket** that tightens the moment you cross ocean fiber.

This blog post isn’t about theory. This is about the **actual architecture** we built to achieve **strict serializable isolation** across three AWS regions (us-east-1, eu-west-1, ap-southeast-1) with a median transaction latency under 80ms. This is about the engineering curiosities that keep distributed protocol designers up at night.

---

## The State of the Art: What Actually Exists?

Before we dive into our custom architecture, let’s survey the landscape. Because the _right_ solution depends entirely on your pain tolerance.

### The Big Three Approaches:

**1. Google Spanner (TrueTime + 2PC)**

- **The hype:** "Global consistency with 7ms clock uncertainty!"
- **The reality:** Requires atomic clocks (GPS + NTP) in every datacenter. Hardware-bound. Fantastic if you’re Google. Terrible if you’re a startup spending $15k/month on the whole stack.
- **Key insight:** Spanner doesn't _eliminate_ clock skew; it _bounds_ it with certainty, then uses **commit wait** to ensure external consistency.

**2. CockroachDB (Hybrid Logical Clocks + 2PC)**

- **The hype:** "Spanner-like without the atomic clocks!"
- **The reality:** Uses hybrid logical clocks (HLC) that combine physical time with logical counters. Transactions still use 2PC across regions. Works well for geo-partitioned workloads, but **pure global operations** kill throughput.
- **Key pain point:** The "grind" you’ll feel when your multi-region transaction has to lock rows across continents. Latency goes from 50ms to 500ms fast.

**3. FoundationDB (Multi-Key Transactions via Deterministic Test Harness)**

- **The hype:** "Serializable isolation, period."
- **The reality:** FoundationDB achieved this by _strictly controlling the execution environment_—a single-writer log per shard, with a distributed **sequencer** that orders transactions. The trick? They run all deterministic. But the **latency floor** for cross-region commits is ~1 round trip.

---

## The Core Problem: The Geometry of Consistency

Here’s where we get technical. The fundamental challenge of global strong consistency is **the conflict between latency and ordering**.

Consider a simple transaction:

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 'A' IN us_east;
UPDATE accounts SET balance = balance + 100 WHERE id = 'B' IN eu_west;
COMMIT;
```

If these two rows live in different regions, you have a problem: **you need to order these updates relative to every other concurrent transaction**. That ordering requires coordination. Coordination requires communication. Communication across 5,000km takes ~50ms round trip. Minimum.

**This is the billion-millisecond problem.** Every transaction that touches multiple regions pays this latency penalty _at least once_.

### Where Most Implementations Fail:

- **Optimistic Concurrency Control (OCC):** Assumes conflicts are rare. In multi-region, they're not—because the _order_ itself becomes the conflict. OCC has _wasted work_ cascades.
- **Two-Phase Locking (2PL):** Locks held for the entire transaction duration. In multi-region, transaction times blow up. Locks held for 200ms+ → domino effect of deadlocks.
- **Percolator (Google's MVCC-based 2PC):** Works for low-contention workloads. But the _prepare phase_ is synchronous. One slow region → whole system stalls.

---

## Our Approach: **The Clockwork Protocol**

We had two constraints:

1. **No atomic clocks** (budget: 1/100th of Google's)
2. **Sub-100ms for 99th percentile** cross-region reads

We ended up with a hybrid protocol we call **Clockwork**—a marriage of **Non-Voting Paxos for ordering**, **Conflict-Aware MVCC for storage**, and a dash of **Speculative Execution** that feels like cheating but mathematically isn't.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Global Clockwork Cluster                │
│                                                             │
│  Region A (us-east)     Region B (eu-west)    Region C (ap) │
│  ┌────────────────┐    ┌────────────────┐   ┌─────────────┐ │
│  │ Transaction     │    │ Transaction     │   │ Transaction  │ │
│  │ Coordinator     │    │ Coordinator     │   │ Coordinator  │ │
│  │ (TC-A)          │    │ (TC-B)          │   │ (TC-C)       │ │
│  │ [Paxos Node]    │    │ [Paxos Node]    │   │ [Paxos Node] │ │
│  └────────┬───────┘    └────────┬───────┘   └──────┬──────┘ │
│           │                     │                   │        │
│           ▼                     ▼                   ▼        │
│  ┌────────────────┐    ┌────────────────┐   ┌─────────────┐ │
│  │ Storage Engine  │    │ Storage Engine  │   │ Storage     │ │
│  │ (LSM+MVCC)      │    │ (LSM+MVCC)      │   │ Engine      │ │
│  └────────────────┘    └────────────────┘   └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**The magic?** We don't use a single global sequencer. Instead, each region runs a **Paxos group** that _independently_ timestamps local transactions, but we enforce a global order through a novel **“commit window”** mechanism.

### The Clockwork Commitment Protocol (Step-by-Step)

Let's trace a cross-region transaction:

```
Client in Japan wants to:
1. Read row 'R1' (in Singapore)
2. Update row 'R2' (in Frankfurt)
3. Commit
```

**Step 1: Client gets a "tentative timestamp"** from their local TC (Tokyo).

- This is a _hybrid logical timestamp_ (HLC). Physical time + logical counter + node ID.
- **Key:** The timestamp is _optimistic_. It might be adjusted later.

**Step 2: The coordinator (Tokyo) sends a `Prepare` message to both regions.**

But here’s the twist: **We don't wait for both to respond before computing the commit decision.**

Instead, we use **Speculative Execution**:

```python
# Pseudocode of the coordinator logic
async def prepare_transaction(tx):
    futures = []
    for shard in tx.affected_shards:
        futures.append(shard.prepare(tx))

    # We don't await all futures yet
    # Instead, we start the Paxos consensus IN PARALLEL with shard preparation

    paxos_future = paxos.propose(tx.tentative_timestamp, tx.id)

    # Wait for first N/2 + 1 prepare responses
    # OR for the Paxos to commit, whichever comes first
    done, pending = await wait_for_min_consensus(futures, quorum=2)

    if paxos_future.is_committed:
        # The order is decided. We can abort shards that are slow.
        for shard in pending:
            shard.abort(tx.id)  # Rollback
        return COMMITTED
    else:
        # We need to wait for Paxos to finish
        await paxos_future
        if paxos_result == COMMITTED:
            for shard in futures:
                if shard.is_prepared:
                    await shard.commit(tx.id)
            return COMMITTED
        else:
            for shard in futures:
                await shard.abort(tx.id)
            return ABORTED
```

**The beauty?** We never block on the _slowest_ shard. The Paxos group serves as a **global ordering service** that doesn't care about individual shard latency. The commit decision is made as soon as enough shards confirm.

**Step 3: The commit window.**

Here's the "Clockwork" secret sauce: **Each committed transaction gets a "final" timestamp from the Paxos group** that is _guaranteed to be_:

- Greater than any previous committed transaction's timestamp.
- Less than any later committed transaction's timestamp.
- Within a **commit window** defined by the Paxos round duration.

This is achieved because the Paxos leader **waits for a commit window to expire** before proposing the next transaction. The window is dynamically sized based on observed RTT between regions.

```go
// Simplified Paxos leader logic
func (l *Leader) proposeNext(tx Transaction) {
    // Wait until commitWindow has elapsed since last commit
    now := hlc.Now()
    if now.Sub(l.lastCommitTime) < l.commitWindow {
        time.Sleep(l.commitWindow - now.Sub(l.lastCommitTime))
    }

    // Propose with timestamp = lastCommitTime + commitWindow
    proposedTS := l.lastCommitTime + l.commitWindow
    l.paxosGroup.propose(proposedTS, tx)

    // Wait for consensus
    result := l.paxosGroup.awaitDecision()

    l.lastCommitTime = result.Timestamp
    return result
}
```

This ensures external consistency: If transaction `T1` committed before transaction `T2` started, `T1`'s timestamp will be less than `T2`'s timestamp, _guaranteed_.

---

## Engineering Curiosities & Pain Points

### The Clock Grind (Real Deployment Numbers)

In our production environment across three AWS regions:

| Metric                                  | Value                        | Implication                                |
| --------------------------------------- | ---------------------------- | ------------------------------------------ |
| **Median cross-region RTT**             | 72ms (Singapore ↔ Frankfurt) | Baseline latency floor                     |
| **Paxos commit window**                 | 25ms (dynamic)               | The time "wasted" per transaction          |
| **Speculative execution success rate**  | 87%                          | 13% of transactions get speculative aborts |
| **99th percentile transaction latency** | 94ms                         | Within our 100ms target                    |
| **Throughput (global txn/s)**           | 4,200                        | Limited by Paxos leader throughput         |

**The surprise:** The **Paxos commit window** is the bottleneck, not network latency. We spent three weeks optimizing it.

**Trick we used:** Instead of a static window, we used **adaptive window sizing** based on observed latency jitter. When regions are "quiet" (no load spikes), we shrink the window to 15ms. During load (like Black Friday), we expand to 40ms. This gave us a 22% throughput improvement.

### The Write-Ahead Log (WAL) Nightmare

Every regional storage engine runs with **Write-Ahead Logging**, but the moment a transaction commits, we must ensure the WAL entry is **durable** in _both_ regions before ack'ing the client.

We ran into a nasty edge case:

> **Scenario:** Paxos commits the transaction, but the WAL flush in Singapore fails (EBS hiccup). The coordinator has already ack'd the client. Now we have a transaction that is _committed in the log_ but _not durable_ in one region.

**Our solution:** The coordinator issues a **commit** to each region, but the region does NOT ack until the WAL write has been flushed to **persistent storage** (not just OS page cache). If the flush fails, the region persists a **"commit pending"** flag in _its own_ log. A background reconciliation process (running every 500ms) checks committed transactions against regional durability.

This is **not perfect**—there's a 500ms window where a region could have a "ghost commit" that still appears in queries. We mitigate this with **read-your-writes** consistency: the coordinator caches the fact that the commit happened and serves read retries from its own memory until the reconciliation catches up.

### The Memory Leak You Didn't Expect: Transaction Objects

This is the kind of thing that haunts you at 3 AM.

When a transaction is **speculatively prepared** but then aborted (because Paxos decided a different order), the storage engine holds **locks and MVCC versions** that need to be cleaned up. If your speculation rate is 13% and your throughput is 4200 txn/s, that's **546 abort objects per second** that need garbage collection.

We initially used a simple reference-counting scheme. **It blew up.** (Memory growth of 2GB/hour).

**The fix:** A _generational_ cleanup approach. Aborted transaction objects are placed into a **ring buffer** that's processed by a background thread every 100ms. The ring buffer is sized to hold 10 seconds of aborts. If it fills up (the GC can't keep up), the system enters **"back-pressure mode"**: new transactions are forced to wait until GC catches up.

That sounds simple, but the ring buffer had to be **lock-free** to not interfere with the fast path. We used a **bounded MPMC queue** with a near-empty flag that the coordinator checks before accepting new transactions.

---

## The Cache That Wasn't: Replication vs. Partitioning

A common question: _Why not just use caching?_

Because caching **destroys consistency guarantees.**

Imagine you have a cache in Singapore that holds a hot key. A transaction in Frankfurt updates that key. If you invalidate the Singapore cache immediately, you've added 150ms to the read path (invalid → fetch from primary). If you don't, you've broken strong consistency.

**The real trick:** We don't cache _data_. We cache **timestamps**.

Each region maintains a **local timestamp cache** (LTC) that maps keys to the _latest committed timestamp_ seen for that key. When a read comes in:

```java
// Read operation with global consistency
public Record read(String key, Transaction tx) {
    // 1. Check local timestamp cache
    long localTS = timestampCache.get(key);

    // 2. Get the global commit timestamp (from Paxos)
    long globalTS = paxosGroup.getLatestCommitTimestamp();

    // 3. If local timestamp is >= global timestamp, we have the latest data
    if (localTS >= globalTS) {
        return localStorage.read(key);  // Fast path!
    }

    // 4. Otherwise, we must fetch from the most recent region
    return fetchFromRegionWithLatestVersion(key, globalTS);
}
```

This cache reduces reads that hit the _fast path_ to **92%** in practice. The 8% that miss pay the 72ms RTT penalty, but that's still within our 100ms budget.

**Why this works:** The timestamp cache doesn't store data; it stores **commit order information**. Two regions can have different timestamp caches, but as long as they both see the _same global commit sequence_, they will agree on which data is current.

---

## The Elephant in the Room: What About Network Partitions?

I'm glad you asked.

**Scenario:** Our global Paxos group has 5 nodes (3 regions, with 2 nodes in the primary region for redundancy). A network partition splits the group: 3 nodes in one side, 2 in the other.

**Standard Paxos response:** The side with fewer than 3 nodes (i.e., the 2-node side) cannot commit new transactions. **This is correct behavior**—it prevents split-brain.

**The practical impact:** The _smaller_ region becomes read-only. Writes fail. Your application must handle `TransactionCommitException` gracefully.

**Our mitigation:** We run **two Paxos groups**—one for "hot" regions (us-east, eu-west) and one for "cold" regions (ap-southeast, us-west, etc.). The hot group has higher commit throughput. Cross-group transactions require a **two-phase commit** between the groups, which adds latency but ensures that a partition in the "cold" group doesn't impact the majority of traffic.

Reads, however, are **always served locally** (using the timestamp cache). So even during a partition, reads succeed as long as the local region has seen the latest timestamp. The only thing that fails is writes that require a quorum.

---

## Key Engineering Takeaways

**1. Speculative execution is your friend, but only if you can afford the rollback cost.**
We optimized our MVCC storage to support **O(1) aborts** by using version chains with a "valid until" field. Rolling back a speculative pre-commit is just marking the chain entry as invalid. No garbage collection needed.

**2. The clock is the enemy; the clock is the answer.**
We spent 40% of our engineering time on **clock synchronization**. Our hybrid logical clocks drift by up to 5ms per hour. We run a background **clock sync thread** that uses NTP to gently steer the RTC, but we never trust it. Every timestamp is checked against the Paxos global order before being used.

**3. The system is only as strong as your weakest network link.**
We had a 4-hour outage when AWS's Frankfurt-Australia fiber was degraded. Latency went from 72ms to 340ms. Our commit window expanded to 80ms. Throughput collapsed to 800 txn/s. The fix? **Application-layer timeouts that differentiate between "slow" and "failed"** —and a circuit breaker that isolates a region if latency exceeds 2x the median.

**4. Testing is impossible without simulation.**
We built a **network simulator** (in Go) that can model packet loss, latency spikes, and clock drift. We run a nightly "chaos experiment" that simulates a 500ms partition in one region. The system must recover within 30 seconds. This caught at least 3 bugs that would have been catastrophic in production.

---

## The Future: What's Next for Clockwork?

We're currently exploring **Deterministic Database** techniques (like Calvin) to remove the Paxos overhead entirely. The idea: if every node knows exactly what every other node will do, you don't need to agree on order—just on inputs.

We also have a prototype of **gossip-based timestamp propagation** that replaces the Paxos group for read-only workloads. The idea is that commits still go through Paxos, but reads can be satisfied by any node that has "heard" about recent commits via gossip. This would reduce read latency from 72ms to ~10ms for non-critical paths.

**But that's a story for another blog post.**

---

## Final Thoughts

Building a globally consistent distributed database is not for the faint of heart. You will encounter edge cases that make you question the very nature of time. You will debug interactions between clock skew and network jitter that look like memory corruption but are actually just physics.

**But when it works—when you see a transaction commit across three continents in under 100ms with serializable isolation—it feels like magic.**

That feeling, my friends, is why we do this.

---

_Clockwork is now open-source (MIT license) on GitHub. We welcome contributions, especially in the areas of clock synchronization and speculative execution optimization. Star us if you want more deep dives—next up: "How We Implemented Snapshot Isolation Without Snailing the WAN."_

**— The Clockwork Engineering Team**
