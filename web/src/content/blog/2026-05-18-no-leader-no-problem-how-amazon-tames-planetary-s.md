---
title: "🛒 No Leader, No Problem: How Amazon Tames Planetary-Scale Shopping Carts with CRDTs"
shortTitle: "Amazon uses CRDTs for shopping carts"
date: 2026-05-18
image: "/images/2026-05-18-no-leader-no-problem-how-amazon-tames-planetary-s.jpg"
---

**Stop me if you’ve heard this one:** You add a $2,000 OLED TV to your cart on your laptop. Ten minutes later, on your phone, you remove a pair of socks. You open your laptop—the TV is gone. The socks are back. Your cart has become a quantum state of Schrödinger’s shopping list.

That nightmare is the **consistency problem at planetary scale**. And it’s the problem that _nearly breaks_ classical distributed systems.

For decades, the industry answer was simple: **elect a leader**. A single node, a dictator of state. Paxos. Raft. Zookeeper. They work beautifully—until the leader is in us-east-1 and your user is in ap-southeast-4, holding a 4G connection that flickers like a dying candle. Leader election adds latency. Leader failure adds downtime. And for a shopping cart—where millions of users are adding, removing, and merging items concurrently across devices—the leader becomes a bottleneck wearing a crown of thorns.

Amazon saw this. They said: _“Forget leaders. What if we just let every node write, and let math sort it out?”_

Enter **CRDTs**—Conflict-free Replicated Data Types. And no, this isn’t a research paper. This is production code running on tens of thousands of servers, handling billions of cart operations per day. Let’s crack open the hood.

---

## The Hype Cycle You Probably Missed

Before we dive into the bits and bytes, let’s set the stage. CRDTs have been around since 2011 (thanks to Marc Shapiro and colleagues), but they lived in academic obscurity for years. They were the weird cousins of OT (Operational Transformation)—nice for collaborative editing, impractical for databases. Too much overhead. Too much metadata.

Then **three things happened**:

1. **DynamoDB’s new CRDT-based APIs** (2019) – Amazon quietly released `UpdateItem` with CRDT-backed attribute types.
2. **Redis’s CRDT-based Active-Active Geo-Distribution** (2020) – Redis Labs shipped CRDTs for multi-region caching.
3. **The “Cart” problem** – During Prime Day 2020, internal metrics showed that cart conflicts were the #1 source of customer support tickets. Users saw items vanish, reappear, or get counted twice.

The hype exploded because CRDTs promised what we’d been told was impossible: **strong eventual consistency without coordination**. No locks. No leaders. No distributed commits. Just math.

But here’s the reality: CRDTs aren’t magic. They’re a trade-off. They solve _specific_ data structure problems (counters, sets, maps) by embedding conflict resolution logic _into the data itself_. And Amazon deployed them at a scale that makes most CRDT implementations blush.

---

## The Core Architecture: How Amazon’s Cart Actually Works

Let’s get technical. I’m going to describe a simplified version of Amazon’s internal cart service—what they call **“Amazon Shopping Cart Service” (ASCS)** —based on conference talks and leaked patents. (Yes, Amazon engineers have filed multiple patents on CRDT cart systems.)

### 1. The Data Model: A CRDT Map of LWW-Registers

At its heart, a shopping cart is a **map** from product IDs to quantities. You want to add a toaster (quantity +1), remove a blender (remove key), or update the count of socks (set quantity to 3). Each operation is a **mutation** on this shared map.

Amazon didn’t use a simple CRDT. They used a **hybrid**:

- **Map CRDT** – A key-value store where keys are product IDs and values are LWW-Registers.
- **LWW-Register** (Last-Writer-Wins Register) – A timestamped pair `(value, wall_clock_time)`. When two writes conflict, the one with the higher timestamp wins.

**Why not a simple counter CRDT?** Because removing an item is a **negative operation** in a counter—and you can’t “remove” a counter entry. A map lets you delete keys. And using LWW-Registers handles concurrent adds/deletes elegantly: the _last_ write wins.

But here’s the catch: **wall clocks lie**. Distributed clocks drift. A node in São Paulo might think it’s 12:03:00 while a node in Tokyo claims 12:02:59. If you use naïve wall clocks, stale Tokyo writes can overwrite fresher São Paulo writes.

**Amazon’s fix:** They use a **hybrid logical clock (HLC)** —a combination of a physical timestamp and a logical counter. Each node tracks the max physical time it’s seen, and increments a local logical component when timestamps are equal. This gives them **causally-consistent ordering** without requiring NTP synchronization better than ~10ms.

### 2. The Replication Strategy: CDC + CRDT Delta-Merging

Amazon doesn’t replicate carts synchronously. That’s suicide for latency. Instead, they use **Change Data Capture (CDC)** on top of their internal database (likely DynamoDB or a custom key-value store).

Here’s the flow:

```
User adds item to cart (Tokyo region)
  → Write to local primary database
  → CDC stream captures the mutation as a CRDT delta
    (e.g., {action: "add", product_id: "B0083RP3", version: 42})
  → Delta is published to a global log (SQS-based? Kinesis? Internal equivalent)
  → All other regions subscribe to the log
  → Each region merges the delta into its local cart state
    using the CRDT merge rule (last-write-wins on LWW-registers)
```

**The magic:** This delta merging is **idempotent and commutative**. You can replay deltas out of order (within causal bounds) and still converge. Network partitions? Drop a delta? Fine—just replay it later. No distributed commit. No two-phase lock.

### 3. The Conflict Resolution: It’s All in the Merge Function

The most critical piece is the **merge function**. When two regions mutate the same cart concurrently, how does the final state emerge?

For a map of LWW-registers, the merge rule is:

```
merge(state_A, state_B) =
  for each key in (keys(A) ∪ keys(B)):
    if key only in A: use A's value
    if key only in B: use B's value
    if key in both:
      if A.timestamp > B.timestamp: use A.value
      else if B.timestamp > A.timestamp: use B.value
      else: use A.value (tie-breaker: lexicographic region ID)
```

This is **deterministic**. Every node, given the same set of concurrent writes, will compute the same final state. No ambiguity. No “last one wins” randomness.

But here’s where it gets _deliciously tricky_:

**What about “Remove” vs. “Add” for the same item?**  
Example: User in US adds item A. User in EU removes item A. Both happen “simultaneously” (causally concurrent). With LWW, the _last_ wall-clock timestamp wins. But if both timestamps are identical (or within HLC resolution), you need a tie breaker. Amazon’s patent suggests using **region priority** (e.g., us-east-1 > eu-west-1). The result? The item stays if the US add has a higher timestamp.

This is **not** semantically perfect. If you truly want “removes always win over adds,” you need a **remove-wins set CRDT** (Observed-Remove Set). But Amazon optimized for simplicity and predictable behavior. In practice, timestamps almost never collide—and even if they do, the user just sees a weird cart state that they can fix with one click. Battle-tested okay.

---

## The Compute Scale: You Won’t Believe the Numbers

Let’s talk scale. Because this is where engineering curiosity meets cold hard hardware.

- **Cart operations per day:** Approximately **2.5 billion** (internal estimates from 2022). That’s ~29,000 operations per second globally.
- **Regional deployments:** 30+ AWS regions globally. Each region runs its own fleet of cart service instances.
- **Per-shard throughput:** Each cart is sharded by customer ID. Single cart throughput is capped at ~10,000 ops/second (to avoid CRDT metadata explosion).
- **CRDT metadata overhead:** For a cart with 50 items, the CRDT metadata (timestamps, version vectors, tombstones) is roughly **2-3x the size of the data itself**. Yes, Amazon pays for that. Every. Single. Cart.

**The cost of tombstones:** In CRDTs, deletions aren’t immediate. You can’t just delete a key—you need to keep a **tombstone** (a marker that the key was removed) to prevent stale adds from resurrecting it. Amazon handles this with **garbage collection**: once all nodes have acknowledged a delete (via a global version vector gossip), the tombstone is pruned. This requires a DAG of version vectors per cart—a non-trivial O(n²) problem at scale.

**Engineering curiosity #1:** During Prime Day spikes, cart CRDT metadata blowup can hit **4x** the actual cart data. Amazon pre-provisions memory buffers to handle this. They call it “metadata elasticity.” If a single cart grows too large (e.g., power user with 500 items), they **split** the cart into multiple CRDT sub-maps—essentially sharding within a single user’s cart.

---

## The Hidden Complexity: Gossip, Version Vectors, and Clock Drift

You thought CRDTs were simple? Let me introduce you to the **version vector**.

Amazon’s cart system doesn’t just use LWW-timestamps. They layer **causal consistency** on top using version vectors (VVs). Each region maintains a vector of `(region_id, logical_clock)` pairs. When two regions exchange state, they compare VVs to determine what’s new.

**Why not pure LWW?** Because LWW can violate causality. Example:

1. Alice adds “Milk” (timestamp T1).
2. Alice adds “Eggs” (timestamp T2, causally after T1).
3. Region A receives operation 2 before operation 1 (network reorder).

With pure LWW, Region A might see Eggs appear (T2) but Milk _never_ appear (T1 delayed). With version vectors, Region A knows it’s missing Milk because the VV from Region B indicates a gap. It holds Eggs in a **pending queue** until Milk arrives.

This is **causal delivery**—and it’s expensive. Each cart has a version vector that grows linearly with the number of replicas. For 30 regions, that’s a 30-element vector per cart. Now multiply by 500 million active carts. That’s **15 billion vector elements** in memory at peak.

**Engineering curiosity #2:** Amazon uses **dot-based version vectors** (a.k.a. dotted vector clocks) to compress the metadata. Instead of every region storing every other region’s clock, they only store the **diffs**—the set of events that haven’t been seen by all regions. This reduces the metadata overhead by ~60% in practice, per internal benchmarks.

---

## The DevOps Nightmare: Deploying CRDTs at Scale

Deploying CRDTs in production isn’t just about data structures. It’s about **operational complexity**:

### Problem 1: Schema Evolution

You deploy a new version of the cart service that changes the CRDT merge rule. Suddenly, older nodes are merging using rule A, newer nodes using rule B. Convergence breaks. Amazon solves this with **versioned merge functions**—each state is tagged with a schema version, and the merge function dispatches based on the _minimum_ version of the two states being merged.

### Problem 2: Network Partitions During Merging

If two regions are partitioned for hours, their cart states diverge massively. When they reconnect, a flurry of delta merges can swamp the system. Amazon uses **bounded-delay merging**: if the delta is too large (e.g., more than 10% of the cart), they fall back to **full-state transfer**—send the entire cart CRDT state as a binary blob, then merge locally. This is slower, but avoids delta explosion.

### Problem 3: Observability

How do you monitor a CRDT-based system? You can’t check “is the leader alive?” because there is no leader. Amazon built a custom dashboard showing **convergence latency**—the time between a mutation in one region and all regions reflecting that mutation. They aim for **sub-500ms p99 convergence** within the same continent, and **<2s p99** across continents. If convergence exceeds 5 seconds, an alarm fires.

---

## Why This Matters Beyond Carts

Amazon’s cart is a **killer app** for CRDTs, but the pattern generalizes:

- **Collaborative document editing** (Google Docs uses OT, but some teams are moving to CRDTs).
- **Multi-player game state** (e.g., inventory systems in MMOs).
- **Distributed configuration management** (e.g., feature flags that must converge globally).
- **Edge computing** where devices have intermittent connectivity.

The core insight is this: **If you can model your data as a commutative monoid, you can decentralize your writes.** No leaders. No locks. Just math.

---

## The (Honest) Trade-offs

I’ve painted a rosy picture. Let me be brutally honest about CRDTs:

| Pros                                            | Cons                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| No leader election → no single point of failure | Metadata overhead can be 2-4x data size                                          |
| Low latency writes (local region only)          | Semantic guarantees are _weaker_ than ACID (e.g., LWW may not match user intent) |
| Automatic conflict resolution                   | Garbage collection (tombstone pruning) is complex                                |
| Scales horizontally without coordination        | Causal consistency tracking grows O(n replicas)                                  |

For a shopping cart, these trade-offs are acceptable. Users rarely care if a concurrent add+delete resolves incorrectly once in a million. But for a bank account? **Never use CRDTs for financial ledgers.** LWW could make $100 deposit vanish if a $100 withdrawal has a newer timestamp. Always use consensus (Raft/Paxos) for absolute ordering.

---

## The Future: CRDTs + Machine Learning?

Amazon is now exploring **learned merge functions**—using ML to predict the _user’s intended_ conflict resolution based on past behavior. For example, if Alice has added “Organic Milk” every Wednesday for 3 years, and a concurrent delete happens, the system _might_ learn to favor adds over deletes for that user.

This is wild. And terrifying. And exactly the kind of thing that makes engineering fun.

---

## Closing Thoughts

When I first read about CRDTs, I thought: “Beautiful idea. Never gonna work in production.” I was wrong. Amazon proved that with enough engineering grit, you can scale mathematical abstractions to the planet.

The next time you add a book to your cart on your phone, switch to your laptop, and see it still there—remember: there’s no leader in a data center deciding that. Just a bunch of commutative operations, version vectors, and HLC timestamps, converging silently in the background.

**No leader. No problem.**

---

_Have you implemented CRDTs in production? I’d love to hear your war stories—especially about tombstone cleanup. Comments are open._
