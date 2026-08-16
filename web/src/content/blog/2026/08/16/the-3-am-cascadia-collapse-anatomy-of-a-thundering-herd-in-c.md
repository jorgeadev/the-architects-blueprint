---
title: "The 3 AM Cascadia Collapse: Anatomy of a Thundering Herd in CockroachDB’s Global Replication"
shortTitle: "CockroachDB Global Replication: Anatomy of a Thundering Herd"
date: 2026-08-16
image: "/images/2026/08/16/the-3-am-cascadia-collapse-anatomy-of-a-thundering-herd-in-c.svg"
---

It’s 3:14 AM. Your pager isn't just buzzing; it’s screaming. You open your laptop, squinting against the blue light, and find a Grafana dashboard that looks like a crime scene. P99 latency has jumped from 20ms to 45 seconds. The "Request Throughput" graph has fallen off a cliff.

In the world of distributed SQL, we promise "Bulletproof" reliability. We talk about **Multi-Raft**, **Serializability**, and **Survival Goals**. But tonight, the system isn't surviving. It’s caught in a death spiral.

What we witnessed wasn't a hardware failure or a simple network partition. It was a **Thundering Herd**—a high-concurrency phenomenon where the very mechanisms designed to keep the system alive turned into a digital circular dependency that strangled our global replication layer. This is the postmortem of how CockroachDB’s distributed locking mechanism encountered a catastrophic edge case, and what it teaches us about the fragility of "Infinite Scale."

---

## The Architecture: How CockroachDB "Owns" Data

To understand why it broke, we first have to understand how CockroachDB (CRDB) handles data. Unlike a traditional monolithic database, CRDB breaks data into small chunks called **Ranges** (typically 512MB). Each range is replicated across multiple nodes (usually 3 or 5) using the **Raft Consensus Algorithm**.

But Raft alone isn't enough for high-performance SQL. If every read had to go through a full Raft round-trip to achieve consensus, the database would be impossibly slow. To solve this, CRDB uses a **Leaseholder** system.

### The Role of the Leaseholder

In any given Range, one replica is designated as the **Leaseholder**.

- **The Power:** Only the Leaseholder can serve reads and coordinate writes.
- **The Speed:** Because the Leaseholder is the "authority," it can serve local reads without asking the other replicas for permission, provided its lease is still valid.
- **The TTL:** Leases are time-bound (typically 9 seconds). The Leaseholder must periodically "renew" its lease via a Raft command to prove it’s still alive.

This architecture is brilliant—until the network hiccups.

---

## The Spark: A Regional "Brownout"

The incident began with a transient network instability in the `us-east-1` region. For exactly 12 seconds, packet loss spiked to 15%. In a standard system, this might cause a few retries. In a globally distributed database, it’s the equivalent of pulling the rug out from under a marathon runner.

When the network flickered:

1.  Several Leaseholders in `us-east-1` were unable to communicate with their followers in `us-west-1` or `eu-central-1`.
2.  The Raft heartbeats failed.
3.  The **Leases expired**.

Normally, this is fine. The system is designed to handle this. If a lease expires, another node in the Range should step up, claim the lease, and life goes on. But this wasn't a single Range failing. This was **thousands of Ranges** losing their Leaseholders simultaneously.

---

## The Thundering Herd: When Consensus Becomes Chaos

In distributed systems, a **Thundering Herd** occurs when a large number of processes are waiting for an event, and when that event happens, they all start running at once, overwhelming the system resources.

As the network stabilized, every node that was a "follower" for those thousands of expired ranges suddenly realized: _"The King is dead. Long live the King."_

### Phase 1: The Race for the Lease

Thousands of nodes simultaneously sent `RequestLease` commands via Raft. Remember, a lease acquisition is a **write operation**. It must be logged in the Raft log and committed by a majority of the replicas.

Suddenly, the internal Raft transport layer was flooded with tens of thousands of "Request Lease" proposals. This created a massive spike in **CPU utilization** and **gRPC stream contention**.

### Phase 2: The Intent Resolution Logjam

In CockroachDB, writes are handled via **Intents**. When you write a row, you don't overwrite the value immediately; you write a "provisional value" (the Intent) and a pointer to a transaction record. Once the transaction commits, the Intents are "resolved" (cleaned up).

When the leases moved, the new Leaseholders inherited a mountain of unresolved Intents from the previous, crashed Leaseholders. To maintain **Strict Serializability**, a new Leaseholder cannot serve certain requests until it resolves these orphaned Intents.

Now, we have a circular dependency:

1.  **Node A** wants to take the lease.
2.  To take the lease, it must process the Raft log.
3.  The Raft log is backed up because **Node B** is trying to resolve Intents.
4.  **Node B** can't resolve Intents because it's waiting for a lease on a _different_ range.

### Phase 3: The Livelock

This is where it gets technical. CockroachDB uses a **Wait Queue** to manage transaction conflicts. If Transaction A is waiting for Transaction B, it enters the queue.

Under the Thundering Herd, the Wait Queue became a bottleneck. Thousands of transactions were waking up, seeing the lease had moved, attempting to re-evaluate their state, failing because the new leaseholder was overloaded, and then going back to sleep.

The **exponential backoff** logic was supposed to save us. But there was a bug: the jitter was too small. Instead of a smooth distribution of retries, the nodes were retrying in "pulses."

```go
// Simplified representation of the problematic retry logic
func (l *LeaseAcquisition) RetryWithBackoff(attempt int) {
    // BUG: Jitter was based on a small constant,
    // leading to synchronized retry waves.
    timer := time.Duration(math.Pow(2, attempt)) * time.Millisecond
    jitter := time.Duration(rand.Intn(100)) * time.Millisecond
    time.Sleep(timer + jitter)
    l.AttemptAcquire()
}
```

In a system with 1,000 nodes, 100ms of jitter is nothing. The "waves" of retries were hitting the Raft layer like a tsunami, keeping CPU usage at 100% and preventing any _actual_ work from being done.

---

## The Deep Dive: Why "Multi-Raft" Made It Worse

CockroachDB's greatest strength is **Multi-Raft**—the ability to run thousands of independent Raft consensus groups on a single physical machine. However, during this incident, Multi-Raft became an amplification vector.

Each node might be a leader for 500 ranges and a follower for 1,000 more. When the network stabilized, the node didn't just have one Thundering Herd to deal with; it had **1,500 miniature herds** competing for the same disk I/O, the same network buffer, and the same CPU cycles.

### The Scheduler Latency Death Spiral

We observed a phenomenon called **Scheduler Latency**. In Go, the runtime manages goroutines. When the CPU is saturated, the Go scheduler struggles to move goroutines off the run queue.

Because the Raft heartbeats (which keep leases alive) are processed in goroutines, the scheduler delay caused _even more_ leases to expire.

- Node is busy trying to acquire Lease A.
- The CPU is so busy that it forgets to send a heartbeat for Lease B.
- Lease B expires.
- Another node tries to steal Lease B, adding more load.
- **Total system collapse.**

---

## The Technical Substance: Fixing the Global Replication Layer

We couldn't just "turn it off and on again." We had to rewrite the way the replication layer handled "panic" scenarios. The fix involved three major engineering shifts: **Lease Transfer Coalescing**, **Priority-Based Raft Processing**, and **Adaptive Jitter**.

### 1. Lease Transfer Coalescing

Instead of allowing every replica to fight for a lease the moment they think it’s gone, we implemented a "Leadership Transfer" protocol. If a node knows it's shutting down or sees a network issue, it proactively nominates a successor. This prevents the "race" entirely.

### 2. Raft Priority Queues

We realized that not all Raft messages are created equal. A `Heartbeat` is more important than a `Data Write`, and a `LeaseRenewal` is more important than a `Snapshot`.

We modified the transport layer to implement **Differentiated Service**. If the gRPC buffers are full, the system now drops data writes but preserves heartbeats. This keeps the cluster topology stable even when the data plane is screaming.

### 3. The "Full Jitter" Backoff

We moved away from simple exponential backoff to an **Architecture-Aware Backoff**. The retry logic now factors in the total cluster size and the observed latency of the Gossip network.

```go
// The New and Improved Backoff
func (l *LeaseAcquisition) AdaptiveBackoff(attempt int, clusterSize int) {
    // Scale the base delay by the size of the "herd"
    baseDelay := time.Duration(clusterSize) * time.Microsecond

    // Exponential growth
    maxSleep := time.Duration(math.Pow(1.5, attempt)) * time.Second

    // Full Jitter: Sleep anywhere between 0 and maxSleep
    // This breaks the "synchronized wave" pattern effectively.
    sleepTime := time.Duration(rand.Int63n(int64(maxSleep + baseDelay)))
    time.Sleep(sleepTime)
}
```

---

## The Hype vs. The Reality of Distributed SQL

In the current tech climate, there is massive hype around "Serverless Databases" and "Global Consistency." Companies promise that you can deploy a database across 15 regions and never worry about the underlying infrastructure.

The reality is that **physics is not optional.**

Light only travels so fast. Networks will always partition. The "technical substance" behind the hype of CockroachDB or Google Spanner isn't just the ability to distribute data—it's the hundreds of thousands of lines of code dedicated to **failure mode mitigation**.

This incident highlighted that even with "Perfect" consensus algorithms like Raft, the implementation details—how you handle retries, how you prioritize CPU cycles, and how you manage "Intents"—are what determine if your database stays up at 3 AM.

---

## Observability: The Hero of the Postmortem

We wouldn't have solved this without **Structured Trace Spans**. In a distributed system, a single SQL query can hop across five nodes. Standard logging is useless.

By using **OpenTelemetry** integrated deep into the CRDB kernel, we were able to see a "trace" of a single lease acquisition that was being bounced around. We saw exactly where it sat in a queue for 400ms, and we saw the exact moment the Go scheduler preempted the Raft heartbeat.

**Engineering Insight:** If you are building distributed systems, your observability can't be an afterthought. It has to be baked into the "hot path" of your consensus engine.

---

## Moving Forward: Resilience is a Moving Target

The "Cascadia Collapse" (as we internally named it) was a humbling reminder that scale introduces new classes of bugs. What works for a 3-node cluster will fail for a 300-node cluster. What works at 10k QPS will melt at 1,000k QPS.

We've since implemented **Admission Control** in CockroachDB. Now, when a node detects it is entering a Thundering Herd state (based on scheduler latency and queue depths), it will proactively reject low-priority SQL queries to save the replication layer.

It’s better to return a `503 Service Unavailable` to 10% of users than to let the entire global cluster descend into a Livelock death spiral.

### Key Takeaways for Distributed Systems Engineers:

- **Jitter is life:** Never use a constant or a small-range jitter for retries in a high-concurrency system.
- **Prioritize Heartbeats:** In a consensus-based system, the "health signals" must have their own "fast lane" in the network and CPU.
- **Beware the Go Scheduler:** At extreme scale, Go’s cooperative multitasking can become a bottleneck. Monitor `sched_latency_ns`.
- **Circular Dependencies:** Always map out your "wait-for" graphs. If A waits for B, and B waits for A’s lease, you are one network hiccup away from a disaster.

Distributed systems are a constant battle against entropy. By analyzing these "Thundering Herd" failures, we don't just fix bugs—we deepen our understanding of the complex, emergent behaviors that happen when we try to make the world’s data behave as one.

The next time the pager goes off at 3 AM, we’ll be ready. Or, more accurately, the code will be ready so the pager stays silent.
