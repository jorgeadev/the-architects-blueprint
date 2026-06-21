---
title: "The 100-Millisecond Ripple: Inside the Cloud Spanner Fan-Out Storm and the Shift to Hybrid Latch-Free B-trees"
shortTitle: "Solving Cloud Spanner Fan-Out Storms via Hybrid Latch-Free B-trees"
date: 2026-06-21
image: "/images/2026/06/21/the-100-millisecond-ripple-inside-the-cloud-spanner-fan-out-.jpg"
---

In the world of distributed systems, "five nines" (99.999% availability) is more than a metric—it is a religion. For Google Cloud Spanner, the crown jewel of globally distributed databases, maintaining this uptime means orchestrating thousands of nodes across the planet with nanosecond precision. But even the most robust architectures have a breaking point.

Recently, a series of seemingly minor high-throughput events triggered what internal engineers called a **"Fan-Out Storm."** It was a perfect sequence of microscopic delays in the Write-Ahead Log (WAL) that cascaded into a macro-level service degradation. The culprit wasn't a hardware failure or a fiber cut. It was a fundamental architectural friction point: **Latch Contention in the B-tree.**

This is the story of how we diagnosed a storm that moved faster than our monitoring could see, and how we re-engineered Spanner’s core storage engine to use **Hybrid Latch-Free B-trees**, fundamentally changing how the world's most scalable database handles concurrency.

---

## The Anatomy of the Write Path: A Primer

To understand the storm, we first have to understand the calm. Cloud Spanner is built on a stack of technologies that shouldn't work together, but do: **Paxos** for consensus, **TrueTime** for external consistency, and **Colossus** for distributed storage.

When a write request hits Spanner, it follows a rigorous lifecycle:

1.  **The Transaction Coordinator:** A node is elected as the leader for the "split" (a shard of data).
2.  **The WAL Entry:** Before any data is modified, the mutation is written to the **Write-Ahead Log (WAL)**.
3.  **Paxos Consensus:** The leader sends the WAL entry to replicas. Once a majority acknowledges, the write is considered "committed."
4.  **The Mutation:** The data is applied to the in-memory **MemTable** (a B-tree structure) and eventually compacted into **SSTables** on disk.

In this pipeline, the WAL is the heart. If the WAL stops, the heart stops. But in our case, the heart didn't stop—it developed a lethal arrhythmia.

---

## The Incident: When "Fast" Isn't Fast Enough

The "Fan-Out Storm" began during a massive retail "drop" event. Millions of concurrent users attempted to update rows within a narrow key range. Under normal circumstances, Spanner’s load balancer (the **Splitter**) would detect the hotspot and split the data across more nodes.

However, the velocity of this specific burst was unprecedented. Because the keys were sequential (think: timestamp-prefixed IDs), the writes hit the same B-tree leaf nodes simultaneously.

### The Feedback Loop

As the writes flooded in, the **WAL persistence layer** experienced a minor spike in tail latency—moving from 1ms to 10ms. In a standard database, this is annoying. In Spanner, it was catastrophic.

Because the B-tree implementation used **exclusive latches** for updates, the following chain reaction occurred:

1.  **Latch Acquisition:** A thread locks a B-tree node to apply a mutation.
2.  **I/O Block:** The thread waits for the WAL to sync to Colossus to guarantee durability.
3.  **The Queue:** Because the WAL was slightly slower, the thread held the B-tree latch for 10x its usual duration.
4.  **Fan-Out:** New incoming requests for the same node couldn't acquire the latch. They began to queue in the RPC layer.
5.  **The Storm:** The RPC layer, seeing the queue growing, spun up more worker threads. These threads all began competing for the same latches, consuming CPU cycles just to perform "spin-locks."

This is the **Fan-Out Storm**: a scenario where internal management overhead (locking and thread context switching) grows exponentially relative to the actual work being done. The system was spending 90% of its CPU time just waiting to talk to itself.

---

## The Bottleneck: The "Latch" Problem

Traditional B-trees rely on latches (lightweight mutexes) to ensure that multiple threads don't corrupt the data structure during a split or a write. When you update a value, you latch the leaf. If the update causes the leaf to exceed its size limit, you "split" the leaf, which requires latching the parent node, and potentially the grandparent, all the way up to the root.

This is **pessimistic concurrency control**. It assumes the worst: that someone else will definitely try to mess with your data while you’re working on it.

In our postmortem, we realized that as we scaled Spanner to handle millions of mutations per second per cluster, the "latch" was no longer a tool—it was a wall. We needed a way to update the B-tree without ever stopping the world.

---

## The Innovation: Hybrid Latch-Free B-trees

To solve the Fan-Out Storm, Google’s storage team introduced a radical departure from traditional indexing: the **Hybrid Latch-Free B-tree**.

This structure combines the best of two worlds: the simplicity of B-trees and the high-concurrency performance of **Bw-trees** (log-structured wire-speed B-trees).

### 1. The Mapping Table (Indirection)

Instead of physical pointers between nodes, the Hybrid B-tree uses a **Mapping Table**. Each Node ID maps to a physical memory address. This allows us to "swap" a node's entire contents by changing a single entry in the mapping table using an atomic **Compare-And-Swap (CAS)** operation.

### 2. Delta Chains

In a standard B-tree, if you want to change one byte, you overwrite the whole node. In our Hybrid model, we use **Delta Chains**.

- When a write comes in, we don't modify the leaf node.
- Instead, we create a tiny "Delta Record" representing the change.
- We use a CAS operation to prepend this Delta Record to a linked list starting at the Mapping Table entry.

**No latches. No waiting.** The write is "lock-free."

### 3. The "Hybrid" Component: In-Place Consolidation

If we just used Delta Chains forever, reads would become incredibly slow (you’d have to traverse a long list of changes to find the current value).

The "Hybrid" magic happens during **Consolidation**. When a Delta Chain reaches a certain length (e.g., 8-16 records), a background thread creates a new, "flattened" version of the node. It then attempts to swap the old chain for the new node via a CAS. If it fails (because another write came in), it simply tries again.

---

## Deep Dive: How the Code Handles the Storm

Let’s look at a conceptual implementation of how this Hybrid approach handles a write during a high-contention event.

```cpp
// Conceptual Hybrid B-tree Node Update (C++)
struct Node {
    atomic<uint64_t> version;
    // ... data ...
};

bool UpdateNode(NodeID id, Mutation m) {
    while (true) {
        Node* current_node = MappingTable.lookup(id);

        // 1. Create a Delta Record (The "Write-Ahead" logic)
        DeltaRecord* delta = new DeltaRecord(m);
        delta->next = current_node;

        // 2. Attempt an Atomic Swap (Lock-Free)
        // If MappingTable[id] still points to current_node,
        // swap it with our new delta.
        if (MappingTable.compare_and_swap(id, current_node, delta)) {
            // Success! No latches were harmed in this transaction.
            return true;
        }

        // 3. Failure means someone else updated the node first.
        // We simply retry. In high-contention, this is faster
        // than context-switching a blocked thread.
        delete delta;
    }
}
```

In the old system, if a thread failed to get a latch, it would "park" and wait, leading to the **Fan-Out Storm**. In the new system, the thread stays active, retrying a lightweight atomic operation. This keeps the CPU pipelines full and prevents the "thundering herd" of blocked threads.

---

## Solving the Structural Change Problem

One of the biggest challenges with latch-free structures is the **Node Split**. How do you split a node into two without locking the whole tree?

We implemented **Multi-Step Atomic Splits**:

1.  **Isolate:** The overflowed node is marked with a "Split Delta."
2.  **Create:** Two new nodes are created in memory.
3.  **Swap:** The Mapping Table is updated to point to a "Gap" entry.
4.  **Connect:** The parent node is updated with a Delta Record to point to the two new children.

Because each step is an atomic CAS or a Delta Record, a reader traversing the tree will always see a consistent state, even in the middle of a split. If a reader hits a "Split Delta," it knows how to follow the pointer to the new half-page.

---

## The Result: Beyond the Storm

The implementation of Hybrid Latch-Free B-trees across the Spanner fleet produced results that surprised even our internal performance teams.

### 1. P99.99 Latency Collapse

The most significant impact wasn't on average latency, but on the **long-tail latency**. During high-load events, the P99.99 latency (the slowest 0.01% of requests) dropped by **over 70%**. By removing the need for threads to wait on latches while the WAL was syncing, we effectively decoupled the memory-speed of the B-tree from the I/O-speed of the storage layer.

### 2. Throughput Linearization

In the old "latch-heavy" model, throughput would actually _decrease_ once contention hit a certain threshold (the "cliff"). With Hybrid B-trees, throughput remains linear. Even when nodes are heavily contested, the system performs "useful work" rather than "locking work."

### 3. CPU Efficiency

We observed a **25% reduction in total CPU utilization** during peak traffic. This efficiency comes from the elimination of kernel-level thread parking and unparking (mutex contention).

---

## The Broader Context: Why This Matters for the Industry

The move toward latch-free and hybrid data structures is the next frontier for high-performance computing. As we move into an era of **CXL (Compute Express Link)** and persistent memory (PMEM), the bottleneck is no longer the disk—it’s the synchronization primitives in our code.

The Spanner Fan-Out Storm was a wake-up call. It proved that even at the scale of Google, the fundamental ways we've built databases for 40 years (latched B-trees) are hitting a physical limit.

By shifting to **Hybrid Latch-Free B-trees**, Spanner has effectively moved the "concurrency ceiling." It allows us to handle the world's most intense data bursts not by building bigger walls (locks), but by building a more fluid, atomic stream of changes.

## What’s Next?

We are currently exploring how to apply these hybrid principles to other areas of the stack, including the **Paxos state machine** itself. The goal is a completely "wait-free" path from the user's RPC call to the final byte written on Colossus.

The Fan-Out Storm was a trial by fire, but it led us to an architecture that is not only faster but fundamentally more resilient. In the world of "five nines," the best way to handle a storm is to make sure your system doesn't have anything for the wind to catch.

---

**Are you interested in solving these kinds of distributed systems challenges?** Google Cloud Spanner is always looking for engineers who want to dive deep into the internals of global-scale storage. Check out our careers page or follow our technical series on the Google Cloud Blog for more deep dives.
