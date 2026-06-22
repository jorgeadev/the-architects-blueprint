---
title: "The Day the Nervous System Shattered: How Uber Re-Architected Global Pub/Sub with CRDTs"
shortTitle: "Uber Re-Architecting Global Pub/Sub with CRDTs"
date: 2026-06-21
image: "/images/2026/06/21/the-day-the-nervous-system-shattered-how-uber-re-architected.jpg"
---

On a Tuesday in mid-2023, the "nervous system" of Uber went dark.

For the uninitiated, Uber doesn't just run on code; it runs on **events**. Every ride request, every GPS ping, every price adjustment, and every Uber Eats order is a message flowing through a global Pub/Sub (Publish/Subscribe) architecture. At the heart of this system lies **Manhattan**, Uber’s massive, multi-tenant distributed database that handles metadata for these event streams.

The **2023 Manhattan Control Plane Failure** wasn't a simple power outage. It was a "Grey Failure"—a subtle, creeping misalignment where the control plane (the brains) lost sync with the data plane (the brawn). This resulted in a catastrophic "split-brain" scenario across global regions. Subscriptions vanished in some data centers while persisting in others, leading to billions of lost events and a recovery process that took hours of manual intervention.

The post-mortem was clear: **Consensus-based systems (Paxos/Raft) are too brittle for global-scale partition healing when the network itself is the enemy.**

This is the story of how Uber Engineering spent the last year re-architecting their global Pub/Sub mesh, moving away from rigid consensus and toward the mathematically elegant world of **Conflict-free Replicated Data Types (CRDTs)**.

---

## The Ghost in the Machine: Anatomy of the 2023 Failure

To understand the fix, we have to understand the break. Uber’s Pub/Sub architecture (internally evolved from systems like _Cherami_ and _uRP_) relied on Manhattan to store the "Source of Truth" for which microservices were subscribed to which topics.

### The Stack Before the Fall:

- **Edge Layer:** Envoy proxies handling incoming traffic.
- **Messaging Layer:** Apache Kafka clusters distributed across regions.
- **Metadata Layer:** Manhattan (using a Paxos-based consensus) storing subscription states.
- **Control Plane:** A centralized orchestrator that pushed updates from Manhattan to the regional message brokers.

### The Failure Mode: "The Manhattan Partition"

In 2023, a latent bug in the control plane’s leader election logic triggered during a routine network maintenance in the US-East region. Instead of failing over gracefully, the system entered a **partial partition state**.

Region A thought Region B was down and took over its traffic. However, Region B still thought it was healthy. Because Manhattan relied on strict quorum (the majority must agree), and the network latency between regions spiked beyond the Paxos timeout, the database entered a read-only state to protect data integrity.

The result? The Pub/Sub mesh couldn't update. If a service scaled up and tried to subscribe to a new topic, the request was rejected. If a node died, its subscriptions stayed "active" in the metadata, leading to **black-holing**—messages being sent to dead servers.

**The realization was chilling:** In our quest for perfect consistency (CP in CAP theorem), we had sacrificed the very availability our business depended on.

---

## The Pivot: Why CRDTs?

After the outage, the mandate was clear: **The Pub/Sub mesh must be partition-tolerant and self-healing without requiring a global "Source of Truth" to be online.**

We looked at CRDTs. A Conflict-free Replicated Data Type is a data structure that can be updated independently and concurrently on different nodes without coordination. If two nodes receive different updates, they can always be merged back together into a mathematically predictable state once they can talk again.

### The Shift from CP to AP

In the CAP theorem (Consistency, Availability, Partition Tolerance), we decided that for **Subscription Metadata**, Availability and Partition Tolerance (AP) were more important than instantaneous Global Consistency.

If a user in London subscribes to a topic, it’s okay if a user in San Francisco doesn't see that subscription for 500ms. It is _not_ okay if the London user can't subscribe at all because the San Francisco link is flapping.

---

## Deep Dive: The New CRDT-Based Mesh Architecture

The new architecture, internally codenamed **Project Aegis**, replaces the centralized Manhattan control plane with a **Peer-to-Peer (P2P) Gossip Mesh**.

### 1. The State Representation: The OR-Set

We chose the **Observed-Remove Set (OR-Set)** as our primary CRDT for managing subscriptions.

In a standard set, if one node adds an element and another removes it simultaneously, the outcome is ambiguous. In an OR-Set, we attach a unique tag (usually a UUID or a Lamport Timestamp) to each addition.

- **Add:** `(Topic_A, Client_1) -> {Tag: 101}`
- **Remove:** The system keeps track of the tags it has "observed." To remove an element, you simply add those tags to a "tombstone" set.

When two regions merge their states, the union of the tags minus the union of the tombstones gives the exact, correct subscription state—no leader election required.

### 2. The Compute Scale: 100 Million Mutations per Second

Uber’s scale is staggering. We aren't just syncing a few variables; we are syncing the subscription state for millions of concurrent connections.

To handle this, we implemented **Delta-State CRDTs**. Instead of sending the entire subscription set (which could be gigabytes) over the wire, we only transmit the "Delta"—the changes since the last successful sync.

### 3. The Gossip Protocol: HyParView and Plumtree

To disseminate these Deltas, we couldn't use a simple broadcast (that's an $O(N^2)$ problem). We implemented a hybrid approach:

- **HyParView:** Maintains a partial view of the network (active nodes). It ensures the mesh stays connected even if 80% of the nodes fail.
- **Plumtree (Push-Lazy-Push):** An epidemic broadcast protocol that builds an efficient spanning tree for fast message delivery but falls back to "gossip" (lazy-push) if a branch of the tree breaks.

---

## Engineering Curiosity: Handling "The Thundering Herd" of Healed Partitions

One of the most fascinating challenges we faced during implementation was the **Reconciliation Storm**.

When a network partition that lasted for 30 minutes finally heals, you have two massive clusters trying to exchange 30 minutes' worth of state changes. If handled poorly, the overhead of merging these CRDTs consumes all available CPU and RAM, causing the nodes to crash—a classic secondary failure.

### The Solution: Merkle Tree Fingerprinting

Before exchanging any CRDT data, nodes now exchange **Merkle Tree roots** of their local state.

1.  Node A and Node B exchange a 32-byte hash.
2.  If the hashes match, they are in sync. No data is sent.
3.  If they differ, they exchange hashes of the tree's branches to find the _exact_ sub-set of subscriptions that are out of sync.

This reduced our cross-region sync traffic by **94%** during recovery events.

---

## Technical Substance: The Code Behind the Convergence

To give you a taste of the internals, here is a simplified representation of our **LWW-Element-Set (Last-Write-Wins)** used for topic metadata, written in Go. This allows us to handle metadata updates (like changing a topic's priority) across regions.

```go
type Record struct {
    Value     string
    Timestamp int64
    IsDeleted bool
}

type LWWSet struct {
    Elements map[string]Record
    mu       sync.RWMutex
}

// Merge combines another LWWSet into the current one
func (s *LWWSet) Merge(other *LWWSet) {
    s.mu.Lock()
    defer s.mu.Unlock()
    other.mu.RLock()
    defer other.mu.RUnlock()

    for key, otherRecord := range other.Elements {
        localRecord, exists := s.Elements[key]
        if !exists || otherRecord.Timestamp > localRecord.Timestamp {
            // The incoming record is newer; adopt it.
            s.Elements[key] = otherRecord
        } else if otherRecord.Timestamp == localRecord.Timestamp {
            // Tie-break: Bias towards 'Deleted' to ensure safety
            if otherRecord.IsDeleted {
                s.Elements[key] = otherRecord
            }
        }
    }
}
```

While the code looks simple, the complexity lies in the **Monotonicity Property**. CRDTs must be monotonic; they can only move forward in state. By ensuring every update has a high-precision synchronized timestamp (using Uber's **HLC - Hybrid Logical Clocks**), we ensure that the mesh always converges to the same state regardless of the order in which updates arrive.

---

## Context of the Hype: Is CRDT the New Kafka?

There’s been a lot of "hype" around CRDTs recently, with companies like Redis, Discord, and Figma touting them for real-time collaboration. In the infrastructure world, the hype exists because we've reached the limits of **Strong Consistency** at global scale.

The speed of light is a constant. If you want to commit a transaction in both New York and Tokyo using Paxos, you are looking at a minimum of 200ms of latency just for the round-trip. In high-frequency environments like Uber’s ride-matching engine, 200ms is an eternity.

**The actual technical substance:** CRDTs aren't a replacement for Kafka or Manhattan; they are a **coordination strategy**. Uber still uses Kafka for the durable storage of events and Manhattan for persistent state. However, the _routing logic_—the map of who gets what—now lives in a CRDT-powered mesh that lives _on top_ of the infrastructure.

---

## The Results: Resilience in the Face of Chaos

Since deploying the CRDT-based mesh (Project Aegis), we have simulated over 50 "Chaos Engineering" events, including total regional isolation.

- **Recovery Time (MTTR):** Dropped from ~45 minutes (manual intervention) to **under 30 seconds** (automated convergence).
- **Availability:** We achieved "five nines" (99.999%) availability for the Pub/Sub metadata layer over the last 12 months.
- **Resource Efficiency:** Despite the background gossip, the CPU overhead on our edge nodes increased by less than 2%.

### The "Invisible" Healing

In late 2023, an actual fiber cut occurred between two major data centers. In the old world, this would have triggered PagerDuty alerts for fifty engineers. In the new world, the CRDT mesh simply "forked." Subscriptions continued to work locally in both regions. When the fiber was repaired two hours later, the Merkle tree reconciliation kicked in, the states merged silently, and not a single event was lost.

**The engineers didn't even have to wake up.**

---

## Engineering Curiosities: Lessons Learned

Re-architecting the core of a global system while it's running (the "changing the engines on a plane while flying" analogy) taught us three critical lessons:

1.  **Observability is Harder in AP Systems:** In a CP system, if a write fails, you know immediately. In an AP/CRDT system, writes always "succeed" locally. We had to build new tooling to measure **"State Divergence"**—a metric that tells us how different the nodes are at any given time.
2.  **Clock Skew is the Silent Killer:** Even with HLCs, extreme clock skew on a misconfigured server can wreak havoc on LWW (Last-Write-Wins) sets. We implemented a "Max Drift" guardrail that isolates any node whose clock deviates by more than 200ms from the cluster mean.
3.  **Tombstone Management:** If you don't clean up your tombstones (the records of deleted items), your CRDTs will grow indefinitely (State Explosion). We implemented a **Garbage Collection (GC) grace period** based on the maximum expected partition time.

---

## The Path Forward

The move to a CRDT-based mesh represents a fundamental shift in how we think about "Truth" at Uber. We have moved away from the idea of a single, central authority and toward a **distributed consensus of peers.**

By embracing eventual consistency and the mathematical guarantees of CRDTs, we’ve built a Pub/Sub system that is not only faster but fundamentally more human. It’s a system that understands that networks fail, regions go dark, and the best way to handle chaos is not to resist it, but to design a data structure that can navigate through it.

Uber’s global nervous system is now more resilient than ever, proving that sometimes, to build a more stable future, you have to let go of total control and trust the math of convergence.

---

**If you’re interested in the intersection of distributed systems and high-scale infrastructure, keep an eye on our upcoming deep-dive into Hybrid Logical Clocks and how we manage global time without atomic clocks.**
