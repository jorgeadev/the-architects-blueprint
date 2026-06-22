---
title: "The Azure Storage Symphony Outage: When Write-Ahead Logs Went Rogue and Quorums Crumbled"
shortTitle: "Azure Storage Outage: Write-Ahead Logs & Quorum Failure"
date: 2026-06-17
image: "/images/2026/06/17/the-azure-storage-symphony-outage-when-write-ahead-logs-went.jpg"
---

**Or: How I Learned to Stop Worrying and Love the Byzantine Fault**

You’ve heard the whispers. The memes. The frantic Slack messages from your SRE friends at 3 AM. "Azure Storage is down." Again. But this time? This time it wasn't just a "transient network issue" or a "DNS propagation delay." No. This was the **Symphony Outage**—the one that didn't just break blob storage for 12 hours; it broke the _mental model_ of how distributed systems _should_ work.

We’re not here to recap the news. We’re here to dissect the corpse. The _real_ story isn't about the marketing fluff of "Azure Copilot impacted." It’s about what happens when **Write-Ahead Log corruption** meets **Distributed Quorum failure** in a system that was theoretically designed to survive nuclear winter.

Buckle up. We’re going deep into the I/O pathway, the log-structured merge trees, and the quorum math that made a god-tier storage service trip over its own shoelaces.

---

## The Scale: Why "Petabytes" Doesn't Cut It

First, we need to calibrate our brains. Azure Storage isn't a SAN array in a single data center. It's a **hyper-scale, geo-distributed, append-only, erasure-coded** monstrosity.

- **Stamp Count:** Thousands of storage stamps.
- **Nodes Per Stamp:** Hundreds of nodes (think 10-20 racks, each with 40+ high-density drives).
- **Replication Factor:** Configurable (LRS, ZRS, GRS), but at the core, it uses a **Reed-Solomon erasure coding** (typically 12+4 or 16+4) for durability.
- **Write Throughput:** Tens of millions of IOPS globally.

The catch? All of this scales horizontally via a **distributed consensus layer** sitting on top of a **local Write-Ahead Log (WAL)** on each node. This is where the party started.

---

## The Architecture: The Choreography of a Write

To understand the **Symphony** failure, you have to understand the three layers of a typical Azure Storage write path:

1.  **The Front-End (FE) / Partition Layer:** Load balances and routes requests to the correct **partition server**.
2.  **The Partition Server (PS):** The brain. It maintains the _metadata_ (the key-to-location mapping) and coordinates the **replication quorum**.
3.  **The Extent Node (EN):** The brawn. Actually stores the data in blobs (extents). Each EN has a local **Log (WAL)** and a **Log Flusher** that moves data to the final extent layer.

When you write a blob, the sequence is:

1.  Client sends data to FE.
2.  FE hashes the blob name, finds the PS.
3.  PS issues an **Append to Log** command to **N** replica ENs (e.g., 3 for LRS).
4.  Each EN writes to its **local WAL** (a purely sequential, append-only file on an NVMe SSD).
5.  The EN responds "Ack" to the PS **only after** the WAL write is flushed to stable storage (`fsync`).
6.  The PS waits for a **quorum** of the ENs (e.g., 2 out of 3) to Ack.
7.  The PS marks the write as committed and returns success to the client.

**This is standard Paxos/Raft-like logic.** It’s brilliant because the WAL is the source of truth. If the node crashes, it replays the WAL. Simple.

**But what if the WAL lies?**

---

## The Critical Bug: WAL Corruption via "Partial Flush"

Here’s the specific technical reason the **Symphony** event escalated from "minor blip" to "global outage."

### The Old Pattern: Atomic WAL Writes

For years, Azure Storage used a **pre-allocated WAL file** with a fixed size (e.g., 8GB). When writing a log entry:

1.  The entry was written to a **write buffer** in memory.
2.  A **memory barrier** was issued.
3.  They called `pwrite()` to write the buffer directly to a specific offset in the pre-allocated file.
4.  They called `fsync()`.

This was safe because the file was **pre-allocated** (sparse or zero-filled). A partial write might corrupt the _data_, but the file metadata (size, inode) remained consistent. On recovery, the system could scan the file headers to find the last _valid_ entry.

### The New (Broken) Pattern: Dynamic WAL Files

To improve performance (reduce SSD wear, improve tail latency), the team introduced **dynamic, appending-only WAL files**. Instead of pre-allocating, they did this:

```c
// Simplified pseudo-code of the bug
fd = open("log.123.wal", O_CREAT | O_APPEND | O_WRONLY);
write(fd, entry_buffer, entry_size);
fsync(fd); // <-- Flush to disk
close(fd);
```

**The problem here is subtle but deadly.** Using `O_APPEND` means every `write()` call appends to the end of the file. The `fsync()` guarantees the data hits the disk.

But what about **file system metadata**? When you write to a newly created file (or a file that just grew past a logical block boundary), the OS must update the **file size** (inode) and potentially allocate new disk blocks (updating the indirect block pointers).

**The race condition:**

1.  The `write()` system call returns. The data is in the kernel's page cache.
2.  The `fsync()` starts. It issues a **write-back** for the data blocks.
3.  The `fsync()` _also_ issues a **write-back** for the metadata (inode) to update the file size.
4.  **If the metadata write succeeds but the data write fails** (e.g., power loss, drive controller bug, NVMe command timeout) — the file size grows, but the actual data is garbage (zeros or stale blocks from a previous file).
5.  The system thinks the WAL entry is valid because the size says "yes, I contain data."

**This is a classic "torn write" or "metadata-data inconsistency."** On reboot, the server reads the WAL. It sees a valid log entry length. It tries to parse it. The checksum fails. It retries. It panics. The node goes into a crash loop.

---

## The Quorum Cascade: From Single Node to Global Collapse

A single node crashing? That's a Tuesday. Azure Storage is designed for that. The **Extent Node** failure is handled by the **Stream Layer**.

But here’s the kicker: **This corruption wasn't random.**

Because the bug was in the _write path_ of the **O_APPEND** behavior, it wasn't isolated to one node. It was triggered by a specific _workload pattern_ — the **Symphony** deployment.

### The Chain Reaction

1.  **The Trigger:** A fleet-wide upgrade (presumably a rolling upgrade or a new build of the EN software) introduced the dynamic WAL file logic.
2.  **The Immediate Spark:** A specific workload (maybe heavy point-in-time restore or a massive delete operation) caused a _surge_ of WAL file creation/deletion cycles. This maximized the metadata pressure on the NTFS/XFS filesystem.
3.  **The Corruption Wave:** Multiple nodes, simultaneously, experienced the metadata-data race condition. They all crashed.
4.  **The Quorum Failure:** Remember the Partition Server? It waits for a **write quorum** from the ENs.

    > **Normal:** 3 ENs. Write to all 3. Wait for 2 acks. If 1 fails, the replica set shrinks to 2, and you have a degraded write path.

    > **Cascade:** 3 ENs. All 3 **crash simultaneously** because of the same code path. The PS can't get a quorum. **No writes succeed.**

5.  **The Read Failure:** Reads also fail. Why? Because the PS might have committed the write (got the quorum before the nodes crashed), but when reading, it needs to fetch the data from an EN. The EN is down, and the replica set is broken.

6.  **Metadata Corruption Spreads:** The Partition Servers themselves maintain their own **transaction logs** (also using WAL patterns). As PS nodes try to recover, they attempt to query the dead ENs. They time out. They enter recovery loops. They start electing new leaders. But the new leader doesn't know which extents were **actually** replicated and which were "phantom" (committed by PS but never flushed to disk by the crashing EN).

7.  **The "Poison Pill" Extent:** Some extents were in a state of **partial write**. The PS thought they were fully written. The EN crashed before finalizing. On restart, the EN replayed the WAL, found the corruption, and **refused to serve that extent**. The PS then had a reference to a non-extant block of data.

**This is a distributed "split-brain" scenario, except no one is alive to claim responsibility.**

---

## The Debugging Nightmare: How Do You Fix a Ghost?

From a **SRE and Engineering perspective**, detecting this was a horror show.

**The Symptoms (misleading):**

- "High disk latency"
- "Network connectivity lost"
- "Out of memory errors"

**The (Deeply Hidden) Root Cause:**

- **Inode journaling conflicts.**
- **A specific pattern of `fdatasync()` vs `fsync()` usage.** (The fix was likely to use `fdatasync()` with pre-allocation to avoid metadata updates entirely).
- **A silent corruption that only triggered on a specific SSD firmware + kernel scheduler combination.**

### The Aha! Moment

The team likely found the bug by:

1.  **Crash Dump Analysis:** Looking at the failing nodes' memory dumps. The WAL replay code was failing with a CRC mismatch on the _first_ entry after a file boundary.
2.  **Reproduction in a Lab:** Creating a test cluster. Injecting a specific `blktrace` workload to induce the metadata race. They would have used **Fault Injection** (like `inject_failure` in the Linux SCSI layer) to simulate a drive flushing metadata before data.
3.  **Code Review:** Seeing the change from "pre-allocated" to "appending" and saying, "Wait. That's not safe."

---

## The Technical Fix: Lessons in WAL Hygiene

The permanent fix, which Microsoft has likely already rolled out to all stamps, involves a multi-pronged approach:

### 1. Return to **Pre-Allocated WAL Files**

No more dynamic file creation. Each node gets a pool of pre-allocated, zero-filled files (e.g., 64 files of 4GB each).

```c
// Correct pattern: Pre-allocate, then use pwrite
int fd = open("log_pool_5.wal", O_CREAT | O_WRONLY);
fallocate(fd, 0, 0, 4 * 1024 * 1024 * 1024); // Allocate 4GB, no holes
// ... later, on a write ...
pwrite(fd, entry, size, current_offset); // Direct offset, no metadata change
fsync(fd); // Only flushes data blocks, inode size doesn't change
```

**Why this works:** `fallocate()` allocates disk blocks and updates the inode size _once_. Subsequent `pwrite()` calls at specific offsets within that file do **not** change the inode metadata. They only modify data blocks. Thus, a crash during `fsync()` cannot result in a phantom file size.

### 2. Mandatory `fdatasync()` with Checks

For any dynamic writes, they should now use `fdatasync()` (which only flushes data and necessary metadata for a subsequent data access) combined with a **post-write verification read** from a different offset to ensure the drive didn't reorder.

### 3. **Checksum Everywhere**

Every WAL entry already had a CRC. But the fix now likely includes a **header checksum** that validates the _existence_ of the entry before the payload checksum. This catches "empty space" being read as data.

### 4. **Quorum Safety Margin (Paxos on Steroids)**

The most significant architectural lesson: **Never trust a single node's WAL for quorum decisions about data presence.**

The Partition Servers should not rely solely on the EN's "Ack" (which means "WAL flushed"). They should also require a **second confirmation** from the **Stream Layer** that the data was _logged_ (not just received). This is essentially turning the system into a **Two-Phase Commit** (2PC) internally, even though it abstracts as a single-phase write to the client.

---

## The Engineering Curiosity: Why "Symphony"?

The outage was named "Symphony" because it was a **coordinated failure**. Not a single note off-key, but an entire orchestra collapsing because the conductor (the WAL flush logic) decided to rewrite the sheet music in the middle of the performance.

This is the most terrifying class of bug in distributed systems: **A State-Machine Replication disaster caused by a silent storage assumption.**

- **Latent Coupling:** The performance improvement (dynamic WAL) was coupled to a failure mode (metadata corruption) that was invisible to all monitoring.
- **No Isolation:** The bug was not isolated to a single hardware vendor or kernel version. It was in the application logic.
- **Amplification:** A 10ms delay in a single I/O operation caused a 12-hour global outage.

---

## What We (The Engineers) Can Learn

Let’s not just point fingers at Redmond. Every major cloud—AWS, GCP, Azure—has hit this exact class of failure.

1.  **`fsync()` is a lie.** It does not guarantee you have a consistent file. It guarantees the bits are on the platter, but it does not guarantee the _relationship_ between file metadata and data bits is correct.
2.  **Never use `O_APPEND` for critical logs.** It's fine for `stdout`. It's deadly for a WAL.
3.  **Pre-allocate aggressively.** The extra storage overhead ($/GB) is trivial compared to the cost of a global outage.
4.  **Test metadata corruption, not just data corruption.** Most chaos engineering tools corrupt the data payload. They rarely corrupt the file system metadata (inode, directory entries, block pointers). You need to simulate a drive that says "I wrote it" but lied.
5.  **The quorum is only as strong as the weakest I/O path.** A Paxos guarantee is only meaningful if the underlying storage layer provides strict ordering and atomicity. If your storage lies, your distributed consensus is just a fancy voting system for chaos.

---

## The Aftermath: The Silver Lining in the Data Cloud

The Azure Storage team did what all great engineering teams do: they **blamelessly dissected the physiology of the failure**.

They likely presented internal postmortems that looked like this:

> **Title:** "Dynamic WAL Append Induced Silent Metadata Corruption Leading to Geo-Scale Quorum Exhaustion"
> **Root Cause:** `fsync()` on a dynamically appended file does not provide atomic metadata+data persistence in the presence of `O_APPEND` and certain SSD write-back cache behaviors.
> **Fix:** Revert to pre-allocated WAL rings. Implement `fallocate()` + `pwrite()` + `fdatasync()`. Add a mandatory verification read on WAL replay.

The blog post they _should_ write is a masterpiece of distributed systems theory meeting physical hardware reality.

**The real takeaway?** We build these incredible, Byzantine-tolerant, Paxos-optimized, global databases. But they all rest on a fundamental truth: **The laws of physics still apply to the NVMe controller.** And sometimes, physics lies.

Keep your WALs pre-allocated, your quorums large, and your `fsync()` faith firmly checked by a healthy dose of paranoia.

_Got any horror stories about `fsync` betraying you? Drop them in the comments. We’re all recovering here._
