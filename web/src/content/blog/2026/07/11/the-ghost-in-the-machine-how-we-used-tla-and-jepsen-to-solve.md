---
title: "The Ghost in the Machine: How We Used TLA+ and Jepsen to Solve the Multi-Writer Consistency Crisis in Decentralized Storage"
shortTitle: "Solving Multi-Writer Consistency in Decentralized Storage with TLA+ and Jepsen"
date: 2026-07-11
image: "/images/2026/07/11/the-ghost-in-the-machine-how-we-used-tla-and-jepsen-to-solve.svg"
---

Imagine you are building a global, decentralized hard drive. No central authority, no AWS S3 bucket to lean on, just a massive, distributed swarm of nodes providing block-level storage. Now, imagine two different users, one in Singapore and one in Berlin, attempt to write to the exact same logical block at the exact same millisecond.

In a centralized system, a single lock manager or a primary database node decides who wins. In a decentralized world, there is no "king." Without a rigorous consistency model, your data doesn't just get old—it gets corrupted. You end up with "zombie data," where bits of the Berlin write and the Singapore write merge into a Frankenstein block that no filesystem can parse.

At this scale, **"it works on my machine" is a death sentence.** To build a system that people can actually trust with their data, we had to move beyond traditional unit testing and into the realm of formal verification. We had to embrace the mathematical rigor of **TLA+** and the chaotic, scorched-earth testing of **Jepsen**.

This is the story of how we hunted down race conditions that only happen once in a billion operations and how we proved that our decentralized multi-writer architecture isn't just fast—it’s mathematically sound.

---

## The Hype vs. The Hard Reality of Decentralized Storage

Decentralized storage has been riding a massive wave of hype. From IPFS to Filecoin and various "Web3" storage plays, the promise is always the same: censorship resistance, lower costs, and no single point of failure.

But there is a technical "tax" that most projects don't talk about: **Consistency is incredibly expensive.**

Most decentralized systems settle for **Eventual Consistency**. They tell you, "Eventually, everyone will agree on what the data is." That’s fine for a social media profile picture, but it is catastrophic for **Block Storage**. If you are running a database (like PostgreSQL) on top of a decentralized block device, a "lost update" or a "stale read" doesn't just mean a glitch; it means a corrupted B-Tree and a total database collapse.

To support **Multi-Writer** scenarios—where multiple clients can mount and write to the same volume—you need something stronger. You need **Linearizability** or, at the very least, **Causal Consistency with Convergent Conflict Resolution**.

Achieving this in a peer-to-peer network where nodes can disappear (churn), messages can be delayed (latency), and the network can split in two (partitioning) is one of the hardest problems in computer science.

---

## The Architecture: AetherStore and the Multi-Writer Challenge

Before we dive into the verification, let's look at the architecture we’re testing. Let’s call our hypothetical system **AetherStore**.

AetherStore doesn't use a single leader. Instead, it uses a **Weighted Quorum** system combined with **Hybrid Logical Clocks (HLCs)**.

1.  **Block Fragmentation:** Every 4MB block is sharded using Erasure Coding.
2.  **The Metadata Layer:** A distributed hash table (DHT) tracks which nodes hold which shards.
3.  **The Multi-Writer Protocol:** When a client writes to Block `0x42`, it must contact a quorum of nodes. It attaches a timestamp (HLC) and a version vector.

The engineering curiosity here is the **Read-Modify-Write (RMW)** cycle. In a multi-writer setup, you can't just blind-write. You have to:

- Fetch the current version and the "Lease" of the block.
- Verify you have the latest state.
- Propose the new state.
- Get a majority of nodes to commit the change.

If two writers try this simultaneously, the system must detect the conflict and either serialize them or merge them using a Conflict-free Replicated Data Type (CRDT) logic.

**This is where the bugs hide.** In the gap between "fetching the lease" and "committing the write," a thousand things can go wrong.

---

## Phase 1: Modeling the Universe with TLA+

We started with **TLA+ (Temporal Logic of Actions)**. Developed by Leslie Lamport, TLA+ isn't a programming language; it's a way to describe the _logic_ of a system using set theory and temporal logic.

### Why TLA+?

In a distributed system, the number of possible states is effectively infinite. You cannot test every combination of network failures and timing overlaps with standard code. TLA+ allows us to define:

- **Safety:** "The system never does something bad" (e.g., two writers never think they own the same block at the same time).
- **Liveness:** "The system eventually does something good" (e.g., a write eventually completes despite minor network blips).

### The Spec: Defining the Multi-Writer State

We wrote a TLA+ specification to model our Quorum-based Lease protocol. Here is a simplified look at how we define a "Write" action in PlusCal (a C-like language that translates to TLA+):

```tla
--algorithm AetherStore {
    variables
        network = [nodes |-> {}],
        storage = [n \in Nodes |-> [version |-> 0, val |-> 0]],
        quorum_size = 3;

    define {
        Success(v) == v.acks >= quorum_size
    }

    process (Writer \in Writers) {
        W1: while (TRUE) {
            \* Phase 1: Prepare/Lease Request
            with (v \in Versions) {
                send_request(self, "PREPARE", v);
            };

            \* Phase 2: Accept/Commit
            if (received_acks >= quorum_size) {
                storage[n].version := v;
                storage[n].val := new_val;
            }
        }
    }
}
```

### The "Aha!" Moment in Model Checking

We ran our spec through the **TLC Model Checker**. We gave it a small model (3 nodes, 2 writers, 2 possible values). Within minutes, TLC found an **Error Trace**.

**The Bug:** A "Stale Lease Takeover." If Writer A gets a lease but is delayed by a GC pause (garbage collection), and Writer B gets a lease and finishes its write, Writer A might wake up and overwrite Writer B's data because the HLC didn't account for a specific edge case in the "Lease Heartbeat" expiration.

**The Fix:** We modified the protocol to include "Fencing Tokens." Every write now carries a token that is validated by the storage nodes. If a storage node sees a token lower than the one it has already accepted, it rejects the write instantly.

TLA+ allowed us to fix this at the **design level** before we ever wrote a single line of Go or Rust.

---

## Phase 2: Chaos in the Real World with Jepsen

Formal verification is beautiful, but it assumes your implementation matches your spec perfectly. In reality, programmers make mistakes. Disk controllers lie about `fsync`. The Linux kernel has bugs.

Enter **Jepsen**.

Created by Kyle Kingsbury, Jepsen is a framework for distributed systems safety testing. It sets up a cluster of nodes, runs your actual database/storage software, and then introduces a **Nemesis**.

The Nemesis is a chaotic force that:

- Cuts network cables (software-defined).
- Kills processes (`kill -9`).
- Desynchronizes system clocks.
- Induces file system corruption.

### The AetherStore Jepsen Test

We wrapped our decentralized block storage in a Jepsen test suite written in Clojure. We focused on the **Linearizability** checker.

We simulated multiple clients performing `read`, `write`, and `cas` (compare-and-swap) operations on the same block. Jepsen records every operation and its result into a "History." At the end of the run, it uses a tool called **Knossos** to see if there is a valid linearizable path through that history.

### What Jepsen Found (The Engineering Curiosity)

During a "Partial Partition" (where Node A can talk to Node B, and Node B can talk to Node C, but Node A _cannot_ talk to Node C), we saw a spike in **Internal Server Errors**.

However, the real issue was a **Non-Linearizable Write**.

1.  Writer 1 performed a write and got a "Timed Out" error.
2.  Writer 2 performed a read and saw the old value.
3.  Later, a third reader saw the _new_ value from Writer 1.

Wait... if Writer 1 timed out, should the write have happened? In a linearizable system, a failed operation can either happen or not happen, but once a "later" operation sees it, it must be permanent.

We discovered that our storage nodes were committing writes to their local log _before_ ensuring they were part of a healthy quorum. If the network split mid-vote, the "ghost write" would sit in one node's log and suddenly reappear when the network healed, overwriting newer data.

**The Fix:** We implemented a **Two-Phase Commit (2PC)** inside the quorum logic. A write is now "Provisional" until a "Commit" message is broadcast. If a node wakes up and sees a Provisional write without a Commit, it must sync with its peers to decide the fate of that block.

---

## Scale and Compute: The Infrastructure of Verification

Formal verification isn't free. It requires significant compute resources.

### TLC Model Checking at Scale

Running a TLA+ model with a large state space can take days. We deployed TLC on a cluster of **96-core AWS c6i.metal instances**.

- **Breadth-First Search:** We explored billions of states per hour.
- **State Compression:** We used symmetry reduction to ignore states that were functionally identical (e.g., if Node 1 and Node 2 swap roles, it’s the same state).

### The Jepsen Lab

Our Jepsen tests run in a dedicated CI environment. Every time a developer pushes code to the storage engine, we spin up:

- 5-10 Docker containers representing the storage nodes.
- A control node running the Clojure-based Jepsen runner.
- **The "Nemesis" workload:** 10 minutes of intense network partitioning.

We found that running Jepsen for 10 minutes is often better than running unit tests for 10 hours. It finds the "impossible" bugs.

---

## The Technical Substance: Why This Matters for the Future of Data

We are moving toward a world where data is no longer stored in a single silo. Whether it's for data sovereignty, edge computing, or cost efficiency, decentralized storage is the frontier.

However, the "Magic" of decentralized storage only works if the **Consistency Model** is bulletproof. By using TLA+ and Jepsen, we’ve moved from "guessing" to "knowing."

### Key Takeaways for Distributed Systems Engineers:

1.  **Don't trust timestamps:** System clocks (NTP) are a lie. Always use HLCs or Logical Clocks (Lamport clocks) for ordering events in a decentralized system.
2.  **Safety is a Property of the Design, not the Code:** If your algorithm is flawed, the best Rust code in the world won't save you. Write a spec.
3.  **The Network is Your Enemy:** Assume every packet will be delayed, duplicated, or dropped. Design your "Nemesis" before you design your "Happy Path."
4.  **Verification is Continuous:** Formal verification isn't a "one and done." As we add features (like snapshots or deduplication), we update the TLA+ spec and the Jepsen tests.

---

## Moving Beyond "Eventually Consistent"

The engineering world has been lazy with "Eventual Consistency" for too long. We used it as an excuse for poor system design. But when you’re building **Block Storage**—the foundation upon which filesystems and databases sit—there is no room for "eventually."

By combining the **mathematical foresight of TLA+** with the **brute-force chaos of Jepsen**, we have proven that it is possible to build a decentralized system that is as reliable as a local NVMe drive.

The next time you write data to a decentralized volume, you shouldn't have to pray to the gods of distributed systems. You should be able to rely on the fact that somewhere, a model checker has already verified every possible way that write could have failed—and ensured that it didn't.

**This is the new standard for engineering at scale. If you aren't verifying, you're just hoping. And in storage, hope is not a strategy.**
