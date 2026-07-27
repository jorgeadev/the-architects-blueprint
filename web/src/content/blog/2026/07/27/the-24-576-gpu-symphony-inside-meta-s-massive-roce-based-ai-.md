---
title: "The 24,576 GPU Symphony: Inside Meta’s Massive RoCE-Based AI Fabric"
shortTitle: "Meta's 24,576 GPU RoCE-Based AI Fabric"
date: 2026-07-27
image: "/images/2026/07/27/the-24-576-gpu-symphony-inside-meta-s-massive-roce-based-ai-.svg"
---

Imagine trying to orchestrate a perfectly synchronized dance involving 24,576 world-class athletes. Now, imagine that if a single athlete stumbles—even for a microsecond—the entire performance grinds to a halt, costing thousands of dollars per minute.

This isn't a hypothetical rehearsal; it is the reality of training Llama 3.

When Meta announced their two massive 24,576 H100 GPU clusters, the industry’s collective jaw dropped. But the real story wasn't just the sheer number of GPUs. It was the "how." For a long time, the consensus in high-performance computing (HPC) was that if you wanted to train at this scale, you _had_ to use NVIDIA’s proprietary InfiniBand. Ethernet was considered too "lossy," too high-latency, and too jittery for the extreme demands of Large Language Model (LLM) training.

Meta decided to challenge that dogma. Alongside an InfiniBand cluster, they built a twin cluster of 24,576 H100s using a purely **RoCEv2 (RDMA over Converged Ethernet)** based fabric.

This is a deep dive into the engineering wizardry required to make Ethernet behave like a supercomputer interconnect, the architectural choices behind the Grand Teton platform, and why this cluster represents a turning point in the "InfiniBand vs. Ethernet" wars.

---

## The Scale of the Ambition: Why 24,576?

To understand the network, you have to understand the workload. Training a model like Llama 3 involves trillion-parameter scales. In these workloads, the bottleneck isn't just the raw TFLOPS of a single H100; it’s the **All-Reduce** and **All-to-All** collective communication operations.

When you shard a model across 24,000+ GPUs using Fully Sharded Data Parallel (FSDP), the GPUs spend a significant portion of their time talking to each other. If the network is slow, the GPUs sit idle. This is the "communication overhead," and at this scale, it can easily consume 30-50% of the training time if the fabric isn't meticulously tuned.

Meta’s goal was to build a cluster where the network fabric was "invisible"—providing high enough bandwidth and low enough latency that the GPUs could operate at peak efficiency.

---

## The Building Blocks: Grand Teton and Open Rack V3

Before we look at the cables, we have to look at the boxes. Meta’s hardware design is a masterclass in density and thermal management.

### The Grand Teton Platform

Meta’s **Grand Teton** is the successor to the ZionEx platform. It’s an integrated chassis designed specifically for AI.

- **The GPU Baseband:** It houses 8 NVIDIA H100 GPUs connected via an internal **NVLink Fabric**, providing 900 GB/s of all-to-all bandwidth within the node.
- **The Host Power:** It features significantly beefed-up CPU-to-GPU bandwidth compared to ZionEx (using PCIe Gen5), ensuring the host can feed data to the GPUs fast enough to keep the H100s saturated.
- **Network Connectivity:** Each Grand Teton node exposes **8x 400Gbps network interfaces**.

### Open Rack V3 (ORV3)

You can’t just plug 24,000 H100s into a standard wall outlet. Each H100 can pull up to 700W at peak. A single rack of these servers can exceed 100kW. Meta uses **ORV3**, which moves the power conversion (AC to 48V DC) to a centralized "power shelf" in the rack. This increases efficiency and allows for the massive power densities required for H100 clusters.

---

## The Network Fabric: RoCEv2 at "Impossible" Scale

This is where the engineering gets spicy. In the InfiniBand world, the network is "lossless" by design at the hardware level. In the Ethernet world, packets are dropped if there’s congestion. To make Ethernet work for AI, Meta uses **RoCEv2** (RDMA over Converged Ethernet), which allows the GPU to write directly into the memory of a remote GPU without involving the CPU, all over standard Ethernet frames.

### 1. The Topology: A 3-Tier Clos Architecture

Meta’s RoCE fabric is built on a non-blocking, multi-tier Clos topology (essentially a massive, high-performance spiderweb).

- **Tier 1 (Rack Switches):** Inside each rack, the 8x 400G NICs from each server connect to "Wedge 400" or similar Top-of-Rack (ToR) switches.
- **Tier 2 (Cluster Fabric):** These ToR switches up-link to a massive middle layer of Arista 7800R3 series modular switches.
- **Tier 3 (Aggregation):** This layer ties the entire 24k cluster together, ensuring that any GPU can talk to any other GPU with minimal hops.

The magic here is the **Rail-Local** routing. In an 8-GPU node, NIC 0 always handles traffic for GPU 0, NIC 1 for GPU 1, and so on. Meta organizes the fabric so that all "NIC 0s" across the entire 24,576 cluster are part of the same network plane. This significantly reduces the complexity of the routing and minimizes "incast" congestion.

### 2. Solving the "Lossy Ethernet" Problem

To make RoCEv2 viable at this scale, Meta had to implement several advanced traffic engineering features:

#### **PFC (Priority Flow Control)**

Standard Ethernet just drops packets when a buffer is full. RoCE can't handle that—retransmitting a dropped RDMA packet is a performance killer. Meta uses **PFC** to send "pause frames" back to the sender when a switch buffer starts to fill up. This essentially creates a "lossless" environment over a traditionally lossy medium.

#### **DCQCN (Data Center Quantized Congestion Notification)**

PFC is a blunt instrument; if you pause a link, you stop all traffic on that priority. To be more surgical, Meta utilizes **DCQCN**.

1. The switches monitor their queue depths.
2. When a queue gets too deep, the switch marks packets with an **ECN (Explicit Congestion Notification)** bit.
3. When the destination receives a marked packet, it sends a **CNP (Congestion Notification Packet)** back to the source.
4. The source NIC then throttles its injection rate specifically for that flow.

#### **Routing and Load Balancing: The Battle Against Elephant Flows**

AI training traffic is notorious for creating **"Elephant Flows"**—massive, long-lived, high-bandwidth data transfers. Standard Ethernet load balancing (ECMP) hashes flows to paths. If two Elephant Flows happen to hash to the same physical cable, that cable gets congested while others sit idle.

Meta solves this using a combination of:

- **Adaptive Routing:** The switches can dynamically move traffic away from congested ports.
- **Advanced Hashing:** Using more entropy in the packet headers to ensure a more even distribution across the 3-tier fabric.

---

## The Software Stack: Where the Rubber Meets the Road

Hardware is just expensive sand without the software stack. Meta’s cluster relies on a deeply optimized version of **PyTorch** and **NCCL (NVIDIA Collective Communications Library)**.

### NCCL Tuning for RoCE

NCCL is the library that handles the "All-Reduce" operations. On an InfiniBand cluster, NCCL is plug-and-play. On a RoCE cluster, you have to tune it to the specific topology of your Ethernet fabric.

Meta engineers worked to ensure that NCCL understands the 3-tier Clos layout. For example, when performing a reduction, NCCL will prioritize "local" traffic (within the rack) before pushing data up to the aggregation layers.

### The Monitoring Nightmare

How do you know if one of the 196,608 (24,576 x 8) high-speed lanes is underperforming?
Meta uses a tool called **"FBOSS" (Facebook Open Switching System)** to manage their switches. They’ve integrated deep telemetry that monitors for "silent data corruption" and "flapping links." At this scale, cables fail every day. The system must be resilient enough to route around a dead switch or a degraded fiber optic cable without crashing the entire training job.

---

## InfiniBand vs. RoCE: The Great Debate

Why did Meta go through the immense pain of tuning RoCE when they could have just bought more InfiniBand?

| Feature         | InfiniBand (Quantum-2)           | RoCEv2 (Ethernet)                     |
| :-------------- | :------------------------------- | :------------------------------------ |
| **Ecosystem**   | Proprietary (NVIDIA)             | Open (Many vendors)                   |
| **Control**     | "Black Box" firmware             | Deeply programmable (FBOSS)           |
| **Scale**       | Extremely high, proven           | High, requires expert tuning          |
| **Cost/Supply** | High premium, supply constrained | Competitive, diversified supply chain |

**The answer is Strategy.**
By proving that RoCE can match InfiniBand performance at a 24k GPU scale, Meta has broken the NVIDIA networking monopoly. They can now source switches from Arista, Broadcom, or Cisco, and NICs from multiple vendors. This "vendor optionality" is worth billions in bargaining power and supply chain security.

Furthermore, Meta already knows how to run Ethernet at a massive scale. Their entire global data center fleet is Ethernet-based. By using RoCE, they leverage their existing operational expertise, tooling, and monitoring systems.

---

## Technical Curiosities: The "Hidden" Challenges

### 1. The Physics of Light

At 400Gbps, signals don't travel far over copper. While some intra-rack connections use Direct Attach Copper (DAC) cables, the vast majority of the 24,576 GPU cluster is connected via **Optical Transceivers**. We are talking about hundreds of thousands of lasers firing simultaneously. A tiny speck of dust on a fiber connector can cause enough signal attenuation to trigger bit errors, which in RoCE, can lead to massive performance degradation.

### 2. The Power-Up Sequence

You cannot simply "turn on" 24,576 H100s. The inrush current would likely trip the utility sub-station. Meta's infrastructure team has to carefully stage the power-up sequence of the racks. Even during training, if the GPUs suddenly go from 10% load to 100% load (at the start of a compute cycle), the "di/dt" (change in current over time) can cause voltage sags. This requires massive banks of capacitors and sophisticated power management at the rack level.

### 3. The "Silent" Killer: Flapping Links

In a cluster this size, a link that is "sort of" broken is worse than a link that is "completely" broken. If a link is flapping (going up and down rapidly), the routing protocols (BGP/ECMP) will constantly try to recalculate the best path. This creates "route flap" and can destabilize the whole network. Meta implemented sophisticated "damping" algorithms in FBOSS to identify and isolate these "zombie" links before they cause a cluster-wide slowdown.

---

## Why This Matters for the Future of AI

The success of Meta's RoCE cluster is a signal to the rest of the industry. It proves that **Ethernet is no longer the "budget" option—it’s a viable, high-performance competitor to InfiniBand for the most demanding workloads on Earth.**

This achievement has accelerated the momentum of the **Ultra Ethernet Consortium (UEC)**, a group including Meta, Microsoft, AMD, and Broadcom, aimed at refining Ethernet specifically for AI workloads. They are working on things like:

- **Packet Sprayed Routing:** Sending individual packets of a single flow across different paths to perfectly balance the load.
- **Flexible Order Delivery:** Allowing the NIC to process packets even if they arrive out of order, reducing the "head-of-line blocking" that plagues current RoCE implementations.

---

## Closing Thoughts

Building a 24,576 H100 cluster is a feat of brute-force capital. But making it work over a RoCE-based Ethernet fabric is a feat of pure engineering brilliance.

Meta has moved beyond simply buying hardware; they are architecting a bespoke supercomputing environment that bridges the gap between traditional hyperscale data centers and specialized HPC clusters. As we look toward Llama 4 and beyond—which will likely require 100k+ GPU clusters—the lessons learned from this RoCE fabric will be the blueprint for the next generation of AI infrastructure.

The "dance" of 24,000 GPUs is now in perfect sync. And the music is playing over Ethernet.

---

### Engineering Summary for the TL;DR Crowd:

- **Compute:** 24,576 NVIDIA H100 GPUs in Grand Teton nodes.
- **Network:** RoCEv2 (RDMA over Converged Ethernet) using a 3-tier Clos topology.
- **Throughput:** 400Gbps per GPU (8 NICs per node) providing massive bi-sectional bandwidth.
- **Congestion Control:** Heavy reliance on PFC and DCQCN to maintain a pseudo-lossless environment.
- **Efficiency:** Achieved performance parity with InfiniBand clusters, proving Ethernet's viability at the extreme scale.
- **Secret Sauce:** Rail-local networking and FBOSS-driven telemetry for proactive link management.
