---
title: "# The HBM-Like Fabric That’s Secretly Powering Exascale LLM Training: A Deep Dive into GPU Memory Hierarchies & RoCE v2"
shortTitle: "GPU Memory Hierarchies and RoCE v2 for Exascale LLM Training"
date: 2026-07-20
image: "/images/2026/07/20/the-hbm-like-fabric-that-s-secretly-powering-exascale-llm-tr.svg"
---

**Stop thinking of your GPU cluster as a collection of cards. Think of it as a single, distributed, hyper-scaled memory fabric.**

If you’ve been anywhere near the AI infrastructure space in the last 18 months, you’ve heard the hype. “Exascale clusters.” “100,000 GPU training runs.” “Trillion parameter models.” But let’s be brutally honest: **The hardware is lying to you.**

The GPUs are fast. The HBM3e bandwidth is insane—3+ TB/s per die. But the moment you need to synchronize gradients across 10,000+ GPUs, you hit the wall. Not a compute wall. A **memory wall.** And not just any memory wall—a hierarchy of memory walls.

Today, we’re going to tear down the layers of this problem. We’re going to look at why **Hierarchical GPU Memory Interconnects** are the only sane way to train a 1T+ parameter model, and why **RoCE v2 (RDMA over Converged Ethernet, version 2)** has become the dark horse champion of the exascale fabric war.

Buckle up. This isn’t a blog post about theory. This is about the _actual_ packet flows, the NUMA domains, the switch topologies, and the bleeding-edge PFC (Priority Flow Control) tuning that makes a 100,000-GPU cluster not just possible, but _efficient_.

---

## The Big Lie: "GPUs Are the Bottleneck"

Here’s the thing about modern LLM training: **It’s a memory bandwidth problem wearing a compute hat.**

When you do a forward pass on a 70B parameter model, you're not doing anything computationally complex. You're doing _matmuls_—big, dumb, parallel matrix multiplications. The GPU is a muscle car engine that runs at 500 mph _if you can feed it data fast enough._

But the data? The weights? They live in **HBM3**—the Ferrari of memory. And in a single node, you have **8 GPUs**, each with 80GB of HBM. That’s 640GB of screaming-fast memory. But your model? It’s 1.2TB in size (if you’re using FP8, which if you’re not, you’re wasting energy).

**You can’t fit the model on one node.**

So we _shard_ it. We use **Tensor Parallelism** (splitting a single matrix op across GPUs) and **Pipeline Parallelism** (splitting layers across nodes). And now, every single math operation requires a **collective communication**—an all-reduce, an all-to-all, a reduce-scatter.

And that’s where the hierarchy bites you.

---

## The Three Levels of Memory Hell

We have to stop pretending that memory is flat. It’s not. In an exascale LLM training cluster, we have three distinct memory hierarchies:

### 1. On-Die: HBM3 (The Goldilocks Zone)

- **Latency:** ~100ns
- **Bandwidth:** 3.35 TB/s (H100) to 4.8 TB/s (B200)
- **Size:** 80GB per GPU (H100) or 192GB (B200)
- **Problem:** It’s not big enough for a large model, and it’s _private_ to the GPU.

### 2. Intra-Node: NVLink 4.0 (The High-Speed Interconnect)

- **Latency:** ~200ns (GPU to GPU via NVSwitch)
- **Bandwidth:** 900 GB/s (bidirectional, per GPU in an H100 HGX baseboard)
- **Problem:** This is a _commodity_ speed. It’s 3x slower than HBM bandwidth. Every time you do a tensor parallel all-reduce across 8 GPUs, you pay the NVLink tax.

### 3. Inter-Node: The Network Fabric (The Sludge)

- **Latency:** 1.5µs to 10µs (depending on switch hops and packet serialization)
- **Bandwidth:** 400 Gbps (InfiniBand NDR) or 200/400 Gbps (RoCE v2)
- **Problem:** This is **100x slower** than NVLink. And this is where 90% of cluster inefficiency lives.

**The goal of hierarchical memory architecture is to minimize the number of trips to this third tier.**

---

## RoCE v2: The Contender That Won’t Quit

If you’ve been following the networking drama, you know there are two religions: **InfiniBand** (Mellanox/Nvidia) and **Ethernet** (Broadcom, Cisco, Arista). The tech press loves to say InfiniBand is the "winner" for AI. That’s a lie.

InfiniBand has better raw latency. But Ethernet has **ecosystem** and **flexibility**. And RoCE v2 (RDMA over Converged Ethernet, version 2) is the protocol that makes Ethernet viable for the latency-sensitive world of GPUs.

### Why RoCE v2 Works (When Everyone Said It Wouldn’t)

RoCE v2 essentially allows a GPU—via a **GDS (GPUDirect Storage) capable NIC**—to read and write directly to the memory of another GPU on a different node, _without touching the CPU kernel_. That’s the "RDMA" part. The "Converged" part is the magic.

Here’s the packet flow:

```
GPU A (Node 1) → GPU Memory (HBM)
  → PCIe Gen5 x16 (128 GB/s)
    → ConnectX-7 NIC (400 Gbps)
      → RoCE v2 Packet (IP/UDP encapsulation of InfiniBand verbs)
        → Ethernet Switch (Arista 7800R3, 25.6 Tbps)
          → ConnectX-7 NIC (Node 2)
            → PCIe Gen5
              → GPU B (Node 2) Memory
```

The latency of that path is around **~2-3 µs** in a well-tuned cluster. That’s insane for Ethernet. The reason it’s possible is:

1. **Explicit Congestion Notification (ECN):** The switches mark packets when their queues start to fill. The NICs back off _before_ packets drop.
2. **Priority Flow Control (PFC):** The IEEE 802.1Qbb standard. It’s a per-hop pause mechanism. If a switch port is about to drop a packet, it sends a pause frame to the upstream switch. It’s brutal if misconfigured (hello, **head-of-line blocking**), but it’s necessary for lossless operation.
3. **DCQCN (Data Center Quantized Congestion Notification):** A congestion control algorithm that’s essentially a hybrid of TCP’s Reno and DCTCP. It adapts the injection rate of RDMA flows based on ECN marks.

**The key insight:** RoCE v2 abstracts the complexity of Ethernet congestion control into a single, well-defined lossless fabric. And because it’s IP-based (the "v2" version encapsulates IB transport packets in IP/UDP), you can route it. You can load balance it. You can do **ECMP (Equal Cost Multi-Path)** with dynamic hashing.

---

## The Architecture: 3D Torus, Dragonfly, or Fat-Tree? None of the Above.

When you’re building a cluster for 100,000 GPUs, you can’t use a standard fat-tree. The bisection bandwidth required is astronomical. You need a **hierarchical fabric** that matches the **hierarchical memory** of the model.

### The "3D Torus of GPU Pods"

Modern exascale clusters are built in **pods**.

**Pod Level:**

- 8 GPUs (NVLink domain) → 1 HGX baseboard
- 32 GPUs (4 HGX baseboards) → 1 DGX H100 server node

**Rack Level:**

- 128 GPUs (4 DGX nodes, plus 8 leaf switches in a spine-leaf topology)
- **RoCE v2 fabric:** Each DGX node has 8 ConnectX-7 NICs, each at 400 Gbps. That’s 3.2 Tbps of uplink bandwidth per node. The rack’s leaf switches aggregate this into a spine of 64x400G ports.

**Super-Pod Level:**

- 4,096 GPUs (32 racks)
- This is where the _hierarchical interconnect_ becomes a _network memory_ topology.
- **The trick:** You don’t connect every rack to every other rack directly. You build a **multi-tiered ring** using **NVSwitch 4.0** (yes, switches in the fabric).

### The "GPU Memory Router" Concept

Nvidia’s NVSwitch 4.0 is not a network switch. It’s a **memory router**. It sits inside the node, connecting the 8 GPUs via a fully-connected crossbar. But we also use **external NVSwitch** (the DGX SuperPOD architecture) to create a **4-level memory hierarchy**:

1. **Level 1 (L1):** GPU HBM (private)
2. **Level 2 (L2):** NVLink Domain (8 GPUs, 900 GB/s per GPU)
3. **Level 3 (L3):** NVSwitch Domain (32 GPUs, 400 GB/s per GPU)
4. **Level 4 (L4):** RoCE v2 Domain (4,096+ GPUs, 200 Gbps per GPU)

**Why not just use a massive InfiniBand fabric for all levels?** Because InfiniBand cannot provide the **coherent memory semantics** that NVLink provides. NVLink allows direct load/store operations between GPU memories. RoCE v2 gives you _queued, message-passing_ semantics. They are not the same thing.

---

## The Real Engineering: AllReduce Through Hierarchical Levels

Let’s get concrete. You’re training a **1.8 trillion parameter Mixture-of-Experts (MoE) model** using **FSDP (Fully Sharded Data Parallel)**.

In FSDP, each GPU holds a shard of the model weights. When you do a forward pass, you need to **all-gather** the weights from everyone. After the backward pass, you need to **reduce-scatter** the gradients.

Here’s what happens at the network level:

### Step 1: Intra-Node Reduction (NVLink)

You have 8 GPUs in a node. Each GPU holds a 1/8 shard of the model. During the backward pass, each GPU computes its gradient for its own shard. But the final gradient is the **sum of all gradients for that shard**.

- **Algorithm:** **Ring AllReduce** on NVLink.
- **Cost:** 2 \* (model_size / 8) / (NVLink_bandwidth)
- **Latency:** ~1.5 µs (negligible)
- **Key insight:** This reduces the data that needs to be sent _off-node_ by a factor of 8.

### Step 2: Inter-Node Aggregation (RoCE v2)

Now you have a single gradient per node. You need to sum these across all nodes.

- **Algorithm:** **Butterfly AllReduce** or **Binary Tree AllReduce**.
- **Cost:** 2 _ (node_gradient_size) / (RoCE_bandwidth) _ log2(num_nodes)
- **Bandwidth constraint:** 400 Gbps per NIC, but you have 8 NICs per node. The **bottleneck is the switch’s load balancing**.
- **The RoCE trick:** Because RoCE v2 uses ECMP, you can stripe the data across multiple flows. But **static hashing** breaks if flows are too large (a problem known as "hash collision"). Modern clusters use **dynamic threshold hashing** or **Packet Spraying** (a la Narayan’s RPC protocol) to avoid this.

### Step 3: Hierarchical Consolidation (The Secret Sauce)

Instead of doing a flat all-reduce across 4,096 nodes, you do a **hierarchical all-reduce**:

1. **Reduce within rack (L3 NVSwitch):** 32 GPUs → 32/8 = 4 nodes. Use the 4-layer NVSwitch fabric (900 GB/s).
2. **Reduce across racks (L4 RoCE v2):** 4,096 GPUs → 4,096 / 32 = 128 racks. Use a **sparse all-to-all** over RoCE v2.
3. **Broadcast:** Reverse the steps.

**Why this matters:** The bandwidth at L3 is 5x higher than L4. By reducing the data size before hitting the fabric, you **dramatically reduce congestion**. In a flat topology, the all-reduce time scales linearly with network diameter. In a hierarchical topology, it scales _logarithmically_.

---

## The RoCE v2 Tuning That Makes or Breaks Your Cluster

Most people think RoCE v2 is plug-and-play. It’s not. In production, we see clusters where PFC storms destroy 40% of training throughput. Here’s what you actually need to tune:

### 1. PFC Deadlock Prevention

PFC is lossless _only if you never drop packets_. But if you pause a switch port, that pause propagates upstream, and you get a **PFC storm**:

- Port A sends pause to B.
- B sends pause to C.
- C sends pause to A.
- Deadlock.

**Solution:** **PFC Watchdog.** Set a timer—if a port is paused for more than 500 ms, drop all incoming packets and re-train the link. It hurts, but it’s better than deadlock.

### 2. DCQCN Alpha Tuning

DCQCN has a parameter **α** (alpha) that controls how aggressively the sender reduces its rate after receiving an ECN mark.

- **Too low:** Congestion collapses. The link goes to 0 bandwidth.
- **Too high:** No congestion control. Packet drops, PFC kicks in, throughput tanks.

**The sweet spot:** α = 0.1 to 0.2 for RoCE v2. And **must be set per-traffic class** (QoS). All-reduce traffic gets a different alpha than checkpointing traffic.

### 3. The "Jumbo Frame" Strategy

Ethernet MTU is 1500 bytes. But RoCE v2 uses **Jumbo Frames** (9000 bytes). This reduces the number of packets per message by 6x. But it also increases **latency** per packet (because you have to serialize 9000 bytes at 400 Gbps = ~200 ns vs 35 ns for 1500 bytes).

**The trade-off:** For large messages (gradient synchronization), use jumbo frames. For small messages (control signals), use the standard MTU. This requires a **smart NIC** (like the ConnectX-7) that can do **on-the-fly MTU switching**.

---

## The Code That Runs the Cluster: A Snippet

You can’t write a blog post about exascale networking without showing a bit of actual code. Here’s a real **NCCL (Nvidia Collective Communications Library)** call that uses RoCE v2 under the hood:

```cpp
// This is the actual function that triggers the all-reduce across 4096 GPUs
ncclResult_t ncclAllReduce(
    const void* sendbuff,      // Input: local gradient
    void* recvbuff,            // Output: averaged gradient
    size_t count,              // Number of elements (e.g., 1e9)
    ncclDataType_t datatype,   // e.g., ncclFloat16
    ncclRedOp_t op,            // e.g., ncclSum
    ncclComm* comm,            // Communicator handle (4096 ranks)
    cudaStream_t stream)       // CUDA stream to synchronize
{
    // Internally, NCCL:
    // 1. Selects the best algorithm (Ring, Tree, or Hierarchical Ring)
    // 2. Determines the topology (NVLink vs RoCE v2)
    // 3. For inter-node, creates GDR (GPUDirect RDMA) memory regions
    // 4. Posts the RDMA READ operations to fetch remote gradients
    // 5. Uses a CUDA kernel to compute the reduction on the fly

    // Example of a low-level GDR registration:
    ibv_mr* mr = ibv_reg_mr(
        pd,                     // Protection domain (NIC context)
        recvbuff,               // GPU memory pointer
        count * sizeof(half),   // Bytes
        IBV_ACCESS_LOCAL_WRITE | IBV_ACCESS_REMOTE_WRITE
    );

    // The RDMA write (from remote GPU to local GPU memory):
    post_rdma_write(
        qp,                     // Queue pair (NIC channel)
        remote_addr,            // Remote GPU buffer address
        remote_rkey,            // Remote memory key
        local_addr,             // Local (temporary) buffer
        1 * 1024 * 1024,        // 1 MB chunk
        wr_id                   // Work request ID for completion checking
    );

    // The magic: No CPU involvement. The NIC writes directly into HBM.
    return ncclSuccess;
}
```

The key takeaway from that snippet is the **ibv_reg_mr** call with the GPU memory pointer. That’s GPUDirect RDMA. The NIC bypasses the GPU’s driver, bypasses the CPU’s MMU, and writes directly to physical HBM addresses. **That’s 5-10x lower latency than bounce buffers.**

---

## The Hard Truth: Why Most Clusters Run at 40% Utilization

After all the hyper-optimization, the cruel reality is that even with perfect RoCE v2 tuning, perfect NVSwitch hierarchy, and perfect FSDP sharding, most exascale clusters run at **30% to 50% GPU utilization** during LLM training.

The culprit? **Load imbalance in the pipeline.**

When you do pipeline parallelism, one stage might take 10 ms to compute, while another takes 12 ms. That 2 ms of idle time per iteration per GPU costs you **200 ms of throughput over 100 iterations**.

The fabric can’t fix that. The fabric is the **plumbing**. The architecture of the **training loop** (the model parallelism strategy, the optimizer offloading, the activation checkpointing) is the **actual engine**.

### The Future: NVLink 5.0 and Beyond

The next leap is **NVLink 5.0** (expected with Blackwell Ultra). It promises 1.8 TB/s per GPU—finally closing the gap between HBM and inter-GPU bandwidth.

But even with that, the **inter-node gap** (NVLink vs RoCE) will still be a factor of 5-10x. The only solution is **CXL 3.0** (Compute Express Link) and **rCXL** (retimed CXL) to create a **coherent memory fabric over Ethernet**. Imagine a world where a GPU on Node A can **load** from the HBM of a GPU on Node B with **500 ns latency**.

That’s the dream. And it’s coming in 2026.

---

## The Final Word

Architecting hierarchical GPU memory interconnects is not a networking problem. It’s a **physics problem**. The speed of light in fiber is 20 cm/ns. A 400Gbps link can serialize a byte in 20 picoseconds. The bottleneck is the **PCIe bus**, the **switch buffers**, and the **slow growth of NAND/compute ratios**.

RoCE v2 is not a hack. It’s the **best possible balance between cost, flexibility, and performance** for the AI era. It’s the reason why meta’s 16,000-GPU clusters don’t cost a billion dollars. It’s the reason why any decent cloud provider can offer 400 Gbps inter-GPU bandwidth without vendor lock-in.

**So the next time you see a headline about a "100 exaflop" cluster, don’t ask about the GPU count. Ask about the fabric topology. Ask about the PFC threshold. Ask about the DCQCN alpha.**

Because that’s where the real engineering lives.

---

**Want to dive deeper?**

- Read the actual NCCL architecture paper: "NCCL: A High-Performance Collective Communications Library for GPUs"
- Check the RoCE v2 specification (IBTA Architecture Annex A17)
- Build a dummy cluster in simulation with **ns-3** using the **RDMA model**

The fabric is the bottleneck. Now you know why. Go build something that breaks it.
