---
title: "The 24,576 H100 Leviathan: Inside Meta’s Grand Teton Networking Fabric"
shortTitle: "Meta's Grand Teton: Networking a 24,576 H100 GPU Cluster"
date: 2026-09-01
image: "/images/2026/09/01/the-24-576-h100-leviathan-inside-meta-s-grand-teton-networki.svg"
---

Imagine, for a moment, the sheer physical scale of 24,576 NVIDIA H100 GPUs. We aren’t just talking about a few racks of servers; we are talking about a sprawling, humming metropolis of silicon, consuming tens of megawatts of power and generating enough heat to require state-of-the-art liquid cooling.

When Meta announced they were building not one, but _two_ of these massive clusters to train the next generation of Llama models, the AI world pivoted. While the industry often obsesses over TFLOPS and HBM3 memory bandwidth, the real battle for AGI isn’t fought at the chip level—it’s fought in the **interconnect**.

At this scale, the network _is_ the computer. If your networking topology isn't flawless, those 24,576 GPUs will spend 50% of their time sitting idle, waiting for data packets to arrive. They become the world’s most expensive space heaters.

Today, we’re going deep. We’re dissecting the networking topology, the collective communication primitives, and the engineering sorcery that Meta used to stitch 24,576 H100s into a single, cohesive training brain.

---

### The Architecture of the Beast: Grand Teton and the Node

Before we look at the cluster, we have to look at the "unit of compute." Meta’s **Grand Teton** platform is the successor to the Zion-EX. Each node is a masterpiece of density:

- **8x NVIDIA H100 Tensor Core GPUs**: Connected via a fully non-blocking **NVLink** fabric.
- **The NVLink Switch Fabric**: Inside the box, GPUs talk to each other at a blistering **900 GB/s** of bidirectional bandwidth.
- **The Frontend/Backend Split**: This is where it gets interesting. Each node has two distinct networks. The "Frontend" (Ethernet) handles storage, logging, and management. The "Backend" (The Fabric) is dedicated solely to GPU-to-GPU communication.

The backend is where the magic happens. In Meta’s RoCE (RDMA over Converged Ethernet) cluster, each of the 8 GPUs in a node is paired with its own **400 Gbps NIC** (Network Interface Card). That’s **3.2 Tbps** of external bandwidth per node.

Why 1:1 GPU-to-NIC mapping? Because in the world of Large Language Models (LLMs), any bottleneck in the "All-Reduce" step is a death sentence for training efficiency.

---

### The Great Divide: RoCE v2 vs. InfiniBand

In a move that sparked endless debate among infrastructure nerds, Meta built two versions of this 24k cluster:

1.  One based on **NVIDIA Quantum-2 InfiniBand**.
2.  One based on **RoCE v2** (built on Arista 7800 series switches).

The InfiniBand path is the "tried and true" HPC route. It’s lossless by design and features hardware-level offloading for collectives. However, Meta’s massive investment in the RoCE cluster signals a shift. By using **Arista’s 7800-series switches** and a **leaf-spine topology**, Meta proved that Ethernet can play in the big leagues of AI—if you tune it within an inch of its life.

The RoCE cluster isn't just "Standard Ethernet." It uses **DCQCN (Data Center Quantized Congestion Notification)** and **PFC (Priority Flow Control)** to simulate a lossless environment. At 24,576 GPUs, "standard" Ethernet would collapse under the weight of **Incast**—a phenomenon where thousands of nodes send data to one node simultaneously, blowing out switch buffers and causing massive packet loss.

---

### Dissecting the "Rail-Optimized" Topology

This is the technical heart of the cluster. You don't just plug 24,000 GPUs into a giant switch and call it a day. You have to design the topology to match the way models actually communicate. Meta uses a **Rail-Optimized** design.

#### What is Rail-Optimization?

In a standard 8-GPU node, let's index the GPUs 0 through 7. In a rail-optimized topology, all "GPU 0s" across the cluster are grouped into the same network leaf switches. All "GPU 1s" are in another, and so on.

**Why do this?**
When you perform a **Reduce-Scatter** or an **All-Gather** (the bread and butter of Distributed Data Parallel training), the communication usually happens between the "same" GPU index across different nodes. By ensuring that all GPU 0s are on the same physical network "rail," you minimize the number of hops and switch crossings required for the most common communication patterns.

The 24,576 cluster is organized into:

- **Rack Level**: Multiple Grand Teton nodes per rack.
- **Cluster Fabric**: A non-blocking, two-tier leaf-spine architecture.
- **The Scale**: Meta uses a "fat-tree" topology where the oversubscription ratio is **1:1**. This means if every single GPU tries to send 400 Gbps of data simultaneously, the spine switches have enough backplane capacity to handle it without dropping a single bit.

---

### Collective Communication Primitives: The "Sync" Phase

When training Llama 3, the cluster oscillates between two states: **Computation** (math on the GPU) and **Communication** (sharing the math). The communication is handled by "Collective Primitives."

If you look at the NCCL (NVIDIA Collective Communications Library) logs on a 24k cluster, you’ll see four main players:

1.  **All-Reduce**: Every GPU has a piece of the gradient; after the call, every GPU has the _sum_ of all gradients.
2.  **All-to-All**: Used heavily in Mixture of Experts (MoE) models to route "tokens" to the correct "expert" GPU.
3.  **Reduce-Scatter**: Breaking the gradients into chunks and distributing them.
4.  **All-Gather**: Collecting those chunks back to reconstruct the full weight matrix.

#### The Challenge of the 24k Scale

On a small 8-GPU node, an All-Reduce is trivial. On 24,576 GPUs, a simple ring-based All-Reduce would be incredibly slow because the latency scales linearly with the number of nodes.

Meta employs **Hierarchical Collectives**:

- **Intra-node**: Use **NVLink** (900 GB/s) to aggregate data within the 8 GPUs.
- **Inter-node**: Use the **400 GbE RoCE/IB** fabric to aggregate data across the racks.

By doing a "Reduce" within the node first, you reduce the amount of data that needs to fly across the global network by a factor of 8.

---

### Engineering Curiosity: The "Silent Data Corruption" Nightmare

When you run 24,576 H100s, you enter a statistical realm where "one-in-a-billion" events happen every hour. Meta engineers have frequently discussed the challenge of **Silent Data Corruption (SDC)**.

Occasionally, a cosmic ray or a voltage ripple might flip a bit in a network packet or a GPU calculation. In a standard web app, this might result in a slightly off-color pixel. In LLM training, a single bit flip in the gradient can cause the entire model's weights to "explode" (NaNs), ruining a training run that costs millions of dollars.

To combat this, Meta’s networking stack implements:

- **End-to-end CRC (Cyclic Redundancy Checks)**.
- **Custom NCCL wrappers** that perform "sanity checks" on gradients before applying them.
- **Aggressive Telemetry**: Monitoring the "FCS" (Frame Check Sequence) errors on the Arista switches in real-time. If a specific optical cable starts showing even a 0.0001% error rate, the scheduler automatically "drains" those nodes and reroutes the job.

---

### Performance Tuning: MTU, GPUDirect, and User-Priority

To squeeze every drop of performance out of the 400Gbps RoCE fabric, Meta doesn't use the standard MTU (Maximum Transmission Unit) of 1500 bytes. They utilize **Jumbo Frames (MTU 9000)**.

Small packets are the enemy of high throughput. By using Jumbo Frames, they reduce the interrupt overhead on the NICs and maximize the payload-to-header ratio.

Furthermore, they leverage **GPUDirect RDMA**. In a traditional network stack, data goes:
`GPU Memory -> CPU Memory -> NIC -> Network`

With GPUDirect RDMA, the NIC reaches directly into the H100’s HBM3 memory via PCIe Gen5:
`GPU Memory -> NIC -> Network`

This bypasses the CPU entirely, slashing latency and freeing up the EPYC processors to handle storage I/O and data preprocessing.

---

### The Hype vs. The Reality: Why Llama 3 Needed This

There was significant hype around Meta’s "Compute Bottomless Pit." Critics asked: "Do you really need 24k H100s for a single model?"

The answer lies in **Model Parallelism**.
Llama 3 400B+ is too large to fit in the 80GB VRAM of a single H100. It has to be sharded. Meta uses a combination of:

- **FSDP (Fully Sharded Data Parallel)**: Sharding model states, gradients, and parameters across the GPUs.
- **Tensor Parallelism**: Splitting individual layers across multiple GPUs.
- **Pipeline Parallelism**: Splitting different layers across different nodes.

These techniques turn the training process into a massive, multi-dimensional jigsaw puzzle. The networking topology we’ve discussed—the rail-optimized leaf-spine—is the "table" this puzzle sits on. If the table shakes (latency spikes) or pieces go missing (packet loss), the puzzle falls apart.

---

### The Routing Problem: ECMP vs. Packet Spraying

One of the most technical "deep-cuts" in the Meta RoCE cluster is how they handle **Entropy**.

In a standard network, we use **ECMP (Equal-Cost Multi-Pathing)** to spread traffic across the spine switches. ECMP hashes the source/destination IP and port to decide which path a packet takes. However, in AI training, you often have a "Elephant Flow"—one massive stream of data between two GPUs. ECMP might accidentally send two Elephant Flows down the same 400Gbps link, causing a collision while other links sit empty.

Meta's solution involves **Receiver-side steering** and advanced congestion control. While they haven't moved fully to "Packet Spraying" (sending individual packets of a single flow down different paths, which requires reordering at the NIC), they have tuned their **Hashing Algorithms** to be aware of the "Rail" topology, ensuring that the traffic is perfectly balanced across the Arista spine.

---

### Summary of the Infrastructure Stack

| Component                   | Technical Specification                           |
| :-------------------------- | :------------------------------------------------ |
| **GPU**                     | 24,576 x NVIDIA H100 (80GB HBM3)                  |
| **Node Architecture**       | Meta Grand Teton (8 GPUs / node)                  |
| **Intra-node Interconnect** | NVLink 4.0 (900 GB/s)                             |
| **Inter-node Interconnect** | 400 Gbps RoCE v2 (Ethernet) or InfiniBand         |
| **Network Switch**          | Arista 7800 Series (RoCE) / NVIDIA Quantum-2 (IB) |
| **Topology**                | 2-tier non-blocking Fat-Tree (Rail-Optimized)     |
| **Storage Fabric**          | Tectonic (Meta's distributed filesystem)          |
| **Collective Library**      | Optimized NCCL with MSCCL influences              |

---

### Final Thoughts: The Future is the Fabric

Dissecting Meta’s 24,576 H100 cluster reveals a fundamental truth of modern AI: **the compute is the commodity; the network is the moat.**

Meta’s decision to build such a massive RoCE-based cluster proves that the "commodity" Ethernet ecosystem, when paired with high-end Arista silicon and obsessive engineering, can rival the specialized InfiniBand fabrics traditionally used in supercomputing.

By optimizing the **Rail Topology**, mastering **Collective Primitives**, and ruthlessly hunting down **Silent Data Corruption**, Meta created a platform capable of training Llama 3 at unprecedented speeds. This cluster isn't just a collection of GPUs—it’s a finely tuned instrument, where every packet is choreographed and every switch is a conductor.

As we move toward the million-GPU era (which Mark Zuckerberg has already hinted at), the lessons learned in this 24k leviathan will form the blueprint for the machines that will eventually train the first true AGI. The silicon gets the headlines, but the networking wins the race.
