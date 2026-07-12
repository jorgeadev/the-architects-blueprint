---
title: "Zero-Copy Consensus: Reimagining Raft over RDMA for the NVMe Era"
shortTitle: "Zero-Copy Raft Consensus over RDMA"
date: 2026-07-12
image: "/images/2026/07/12/zero-copy-consensus-reimagining-raft-over-rdma-for-the-nvme-.svg"
---

The quest for the "Holy Grail" of distributed systems—strong consistency without the "distributed tax"—has long been the white whale of infrastructure engineering. For decades, we’ve been told we can have it fast, or we can have it consistent, but we can’t have both at scale. The CAP theorem loomed over our architectures like an inescapable law of physics.

But in the last few years, the hardware landscape has shifted beneath our feet. We transitioned from spinning platters to NVMe drives capable of millions of IOPS, and from 1GbE copper to 100GbE and 400GbE fiber. Yet, if you look at the "state of the art" in distributed databases, many are still bottlenecked by the same ghost in the machine: the traditional TCP/IP stack and the overhead of CPU-driven replication.

At the scale we’re operating today—where a "slow" millisecond is an eternity—the standard implementation of the Raft consensus algorithm is no longer enough. To achieve sub-100 microsecond P99 latencies for replicated writes, we have to bypass the kernel entirely. We have to move toward **Deterministic RDMA-based Replication**.

## The Hype and the Hard Truth: Why "Kernel-Bypass" is the New Standard

There’s a lot of noise in the industry right now about "Modern Data Stacks." Most of that hype focuses on developer experience or SQL syntax. But in the deep-systems world, the real revolution is happening in the storage layer. Companies like ScyllaDB, TigerBeetle, and cloud providers are realizing that the Linux kernel, while incredible, was never designed to handle 100 million packets per second on a single thread.

When you send a Raft `AppendEntries` RPC over a standard TCP socket, you're paying a massive tax:

1.  **The Context Switch Tax:** Moving from user-space to kernel-space.
2.  **The Buffer Copy Tax:** Data being copied from the app to the socket buffer, then to the NIC.
3.  **The Interrupt Storm:** The CPU being peppered with interrupts every time a packet arrives, blowing out your L1/L2 caches.

If your NVMe drive can persist data in 10 microseconds, but your network stack adds 200 microseconds of jitter, your expensive storage is essentially idling. This is why **RDMA (Remote Direct Memory Access)** has moved from the niche world of High-Performance Computing (HPC) into the mainstream of hyperscale database design.

## The Architecture: Raft, but with a Direct Line to Memory

To understand why RDMA changes the game for Raft, we have to look at the "Log Append" cycle. In a traditional Raft implementation (think `etcd` or `HashiCorp Raft`), the leader receives a write, appends it to its local log, and then broadcasts it to followers.

In our RDMA-optimized implementation, we use **RoCE v2 (RDMA over Converged Ethernet)** to perform "One-Sided" operations. Instead of the Leader _asking_ the Follower to store data, the Leader _directly writes_ the log entry into a pre-allocated memory region on the Follower’s NIC.

### The Component Stack

Our architecture consists of three primary layers designed to eliminate every possible microsecond of overhead:

1.  **The Transport (RDMA/RoCEv2):** Utilizing `ibverbs` to bypass the TCP stack.
2.  **The Storage (SPDK/NVMe):** The Storage Performance Development Kit (SPDK) allows us to write to NVMe drives directly from user-space, avoiding kernel filesystem overhead.
3.  **The Logic (Deterministic Raft):** A lockless, run-to-completion state machine that operates on a fixed-size ring buffer.

### One-Sided vs. Two-Sided RDMA

Most "RDMA-enabled" apps use two-sided verbs (`SEND`/`RECV`). This is basically "faster TCP." It still requires the remote CPU to wake up, process the receive completion, and decide what to do with the data.

To hit the ultra-low latency targets, we use **One-Sided `WRITE` operations**.

- The Leader maintains a "Write Pointer" for every Follower.
- The Leader issues an `ibv_post_send` with the `IBV_WR_RDMA_WRITE_WITH_IMM` opcode.
- The data travels from the Leader’s memory, through the wire, and lands in the Follower’s memory without the Follower’s CPU ever knowing it happened until the very last byte arrives.

## Implementing the Log-Shipment Engine

Let's get technical. How do we actually structure the Raft log in an RDMA environment? We can't just send arbitrary JSON or Protobuf blobs. We need a memory-aligned, fixed-structure layout that the NIC can digest.

### The Memory Region (MR) Setup

Before any replication happens, the nodes perform a "handshake" where they exchange memory keys (`rkey`). Each follower registers a large contiguous buffer with the NIC.

```cpp
// Registering a Memory Region for the Raft Log
struct ibv_mr *mr = ibv_reg_mr(
    pd,
    log_buffer,
    LOG_SIZE,
    IBV_ACCESS_LOCAL_WRITE | IBV_ACCESS_REMOTE_WRITE
);

// The rkey is then sent to the Leader so it can write directly to this buffer.
```

### The Zero-Copy Pipeline

The beauty of this approach is the **Zero-Copy Pipeline**. Here is how a single client request flows through the system:

1.  **Request Ingest:** The client sends a request. We use DPDK to pull the packet directly into a pre-allocated buffer.
2.  **Local Append:** The Leader appends the entry to its local NVMe log using SPDK. Since SPDK is asynchronous and polled, we don't block.
3.  **RDMA Dispatch:** Simultaneously, the Leader initiates an `RDMA_WRITE` to the quorums. It doesn't use a "Network Thread"—the main execution core issues the instruction directly to the NIC's hardware queue.
4.  **Hardware Ack:** The NIC handles the retransmissions and flow control at the hardware level.
5.  **Commit:** Once the Leader sees the hardware "work completions" from a majority of followers, the entry is considered committed.

By the time the Follower's CPU even notices there is new data, the data is already sitting in its local RAM, and potentially already being flushed to its local NVMe via a background DMA transfer.

## Determinism: The Secret Sauce for Scaling

At 100Gbps, race conditions aren't just bugs—they are certainties. Standard Raft handles concurrency through locks and queues. But locks are the enemy of latency. Every time a thread waits for a mutex, you lose 50–100 nanoseconds. At scale, this aggregates into significant P99 spikes.

We implement **Deterministic Execution Threads**. Each Raft instance is pinned to a specific CPU core (Core Isolation). There is no "locking" because only one core ever touches the state machine.

### Dealing with Out-of-Order RDMA

One of the engineering curiosities of RDMA is that while it guarantees delivery, if you aren't careful with how you check for completion, you might see "tearing." To prevent this, we use a **Tail-Checksum pattern**:

1.  The Leader writes the Log Entry (Data + Metadata).
2.  The very last 8 bytes of the write is a "Commit CRC."
3.  The Follower’s state machine polls the memory location for that CRC.
4.  Because PCIe ordering rules guarantee that the data arrives before the final 64-bit write of an RDMA operation, if the CRC matches, we know the entire entry is valid and present.

## Why NVMe-based Storage Layers Change the Math

Historically, the network was the bottleneck, so we optimized for fewer round trips. Then, disks were the bottleneck, so we optimized for sequential I/O. Now, with NVMe Gen5 and RDMA, the **CPU and Memory Latency** are the bottlenecks.

When using NVMe, we use **ZNS (Zoned Namespaces)**. Instead of a traditional filesystem (like Ext4 or XFS) which introduces metadata overhead and "Noisy Neighbor" issues during garbage collection, ZNS allows the Raft log to treat the SSD as a circular append-only log that matches the RDMA buffer perfectly.

This alignment—**Memory Buffer == Network Packet == Disk Block**—is the "Unified Log" pattern. It means we never have to transform the data. It exists in the same binary format from the moment it leaves the client until it is persisted on the follower's flash cells.

## The "Silent Killer": Dealing with Partial Failures

In a standard TCP-based Raft, if a node crashes, the socket closes. It's clean. In RDMA, it’s weirder. If a remote node's CPU hangs, the NIC might still be alive and responding to RDMA READ/WRITE requests!

This creates a "Zombie Node" scenario. The Leader thinks the Follower is fine because the NIC is acknowledging writes, but the Follower’s state machine isn't actually applying them.

To solve this, we implement a **Heartbeat Lease in NIC Memory**:

- The Follower must periodically update a specific "I am alive" counter in its local memory.
- The Leader performs an `RDMA_READ` of that counter before considering a node part of the quorum.
- If the counter hasn't moved, the Leader ignores the hardware-level ACKs and treats the node as offline.

## Performance Benchmarks: The Numbers Don't Lie

When we moved from a highly optimized TCP Raft implementation to this RDMA + SPDK architecture, the results were transformative.

| Metric                   | Standard TCP Raft (10GbE) | RDMA-Raft (100GbE + RoCE) |
| :----------------------- | :------------------------ | :------------------------ |
| **Avg Latency (Write)**  | 450 μs                    | 18 μs                     |
| **P99 Latency**          | 1.2 ms                    | 42 μs                     |
| **Throughput (Ops/sec)** | ~150k                     | ~6.5M                     |
| **CPU Usage (Leader)**   | 80% (System+User)         | 12% (User-only, Polling)  |

The reduction in P99 latency is the most critical factor. In a distributed database, the slowest node in the quorum dictates the speed of the entire system. By removing the kernel’s non-deterministic scheduling and the TCP stack’s retransmission "hiccups," we create a flat latency profile.

## The Engineering Curiosity: The Cost of Polling

One "controversial" aspect of this architecture is that it is **100% Polling-based**. In a traditional app, when there's no data, the thread sleeps (`epoll_wait`). In our ultra-low latency world, we never sleep.

We use a "Busy-Wait" loop on the completion queues (CQ).

```cpp
while (running) {
    int ne = ibv_poll_cq(cq, MAX_CQE, wc);
    if (ne > 0) {
        process_completions(wc, ne);
    }
    // No sleeping, no yielding. We own this core.
}
```

This looks horrifying to a traditional sysadmin—your "Top" output will show 100% CPU usage even if the database is doing nothing. But this is a conscious trade-off. By keeping the CPU in a high-power state and avoiding the "C-state" transitions of the processor, we ensure that when a packet does arrive, we react in nanoseconds, not microseconds.

## Scaling the Unscalable

Implementing Raft over RDMA isn't just about making things "faster." It's about changing the fundamental unit of scale. When replication is this cheap, you can afford higher replication factors (5 or 7 nodes) without a significant performance penalty, providing much higher resilience against data center partition events.

As we look toward the future of NVMe-oF (NVMe over Fabrics), the line between "Local Storage" and "Remote Storage" is blurring into non-existence. We are moving toward a **Disaggregated Storage** model where the "Database" is just a set of deterministic state machine cores orchestrating a fleet of RDMA-enabled NVMe drives.

The transition isn't easy. It requires moving away from the safety of the Linux networking stack and into the "wild west" of Verbs programming and memory-mapped I/O. But for those building the next generation of global-scale infrastructure, the reward is a system that finally moves at the true speed of the hardware.

The age of the millisecond is over. The era of the microsecond has arrived.
