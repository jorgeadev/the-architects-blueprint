---
title: "Scaling to the Stratosphere: Inside Meta’s 24,576 H100 Custom RoCE Network"
shortTitle: "Scaling Meta’s 24,576 H100 Custom RoCE Network"
date: 2026-08-20
image: "/images/2026/08/20/scaling-to-the-stratosphere-inside-meta-s-24-576-h100-custom.svg"
---

When you’re training a model as massive as Llama 3, the hardware challenges move from "difficult" to "statistically improbable." We aren't just talking about plugging in a few servers. We are talking about **24,576 NVIDIA H100 GPUs** humming in a single synchronous dance.

At this scale, the network isn't just a pipe; it’s the bottleneck, the nervous system, and—if not handled correctly—the single point of failure that can turn a \$500 million cluster into a very expensive space heater.

Meta recently pulled back the curtain on their dual-cluster strategy: one powered by NVIDIA’s proprietary InfiniBand fabric, and the other—perhaps more impressively—powered by a **custom-tuned RoCE (RDMA over Converged Ethernet) network stack.**

Today, we’re going deep into the weeds. We’re going to look at how Meta engineered a "lossless" experience on a "lossy" medium, the topology that makes 24,500 GPUs feel like a single machine, and the software wizardry required to keep collective communication from collapsing under its own weight.

---

## The Hype vs. The Hard Reality: Why RoCE?

For years, the gold standard for High-Performance Computing (HPC) and AI training has been **InfiniBand (IB)**. It’s a network architecture designed from the ground up for low latency and credit-based flow control (meaning it’s natively lossless).

However, InfiniBand is a specialized ecosystem. It requires specific switches, specific NICs, and a specific skill set. Ethernet, on the other hand, is the language of the internet. It’s ubiquitous, the supply chain is diverse, and Meta’s engineers already know how to manage it at the scale of millions of servers.

The challenge? **Ethernet was designed to be lossy.** If a packet drops on the internet, you just re-send it. But in AI training, a single dropped packet during an `All-Reduce` operation can stall the entire 24,576 GPU cluster, leading to "tail latency" that kills training efficiency.

Meta’s achievement isn't just building a big Ethernet network; it’s building a **custom RoCE v2 stack** that achieves parity with InfiniBand at a scale that was previously thought impossible.

---

## The Physical Foundation: Grand Teton and the Backend Fabric

Before we talk about packets, we have to talk about the iron. Meta’s cluster is built on the **Grand Teton** platform.

Each Grand Teton node is a beast:

- **8x NVIDIA H100 GPUs** interconnected via **NVLink 4**.
- **2 TB/s** of internal aggregate bandwidth.
- **ConnectX-7 NICs** providing **400Gbps** of external bandwidth per GPU.

In a 24,576-node cluster, you have over 3,000 of these chassis. To connect them, Meta uses a **3-stage Clos (Fat Tree) topology**.

### The "Rail-Optimized" Layout

This is where it gets interesting. Meta doesn't just plug cables randomly. They use a **Rail-Optimized** design.

In a standard cluster, you might just connect servers to the nearest switch. In a rail-optimized cluster, all "GPU 0s" across a group of servers are connected to the same set of switches, all "GPU 1s" to another, and so on.

- **The Logic:** Most collective communications (like `All-Reduce` or `All-to-All`) happen between the same GPU index across different nodes.
- **The Benefit:** By keeping "Rail 0" traffic on a specific set of switches, you minimize the number of "hops" a packet takes during a collective operation, drastically reducing the chance of congestion across the entire fabric.

---

## Deep Dive: The Custom RoCE Stack

To make Ethernet behave like a supercomputer fabric, Meta had to optimize every layer of the OSI model. They didn't just use RoCE; they rebuilt how their network handles congestion.

### 1. The Congestion Control Nightmare (DCQCN)

In a massive GPU cluster, you encounter the **"Incast" problem**. Imagine 1,000 GPUs all trying to send data to a single GPU simultaneously during a parameter update. The switch buffers overflow, and packets are dropped.

Meta uses **DCQCN (Data Center Quantized Congestion Notification)**, but with a massive twist in tuning.

- **ECN (Explicit Congestion Notification):** The switches monitor their queue depths. If a queue starts to fill up, the switch marks the packet header with a "congestion encountered" bit instead of dropping it.
- **The Feedback Loop:** When the destination receives this marked packet, it sends a Congestion Notification Packet (CNP) back to the sender.
- **The Meta Secret Sauce:** Meta tuned the algorithm’s **Alpha (reduction rate)** and **Beta (increase rate)** parameters to be incredibly aggressive. They don't wait for a packet drop to slow down; they throttle the sender at the first sign of a queue building up.

### 2. Handling the "Pause Frame" Storm

Standard RoCE relies on **PFC (Priority Flow Control)**. When a switch buffer is full, it sends a "PAUSE" frame to the sender.

The problem? At 24,576 GPUs, a single PAUSE frame can cause a "head-of-line blocking" cascade. Switch A tells Switch B to stop, Switch B tells Switch C, and suddenly, half your data center has ground to a halt. This is known as a **PFC Storm**.

Meta's solution involves a combination of:

- **Large switch buffers:** Using Arista 7800 series switches with deep packet buffers to absorb bursts.
- **Strict Priority Mapping:** Separating RoCE traffic from background management traffic into different hardware queues (Traffic Classes).

---

## Collective Communication: The Software Glue (NCCL)

Hardware is only half the battle. The software that coordinates the GPUs is **NCCL (NVIDIA Collective Communications Library)**. Meta didn't just use NCCL out of the box; they heavily optimized it for their specific RoCE topology.

### Custom NCCL Topology Detection

NCCL usually tries to guess the network topology. Meta provides NCCL with a **precise XML map** of the RoCE fabric. This allows NCCL to build "rings" and "trees" that perfectly align with the physical cabling, ensuring that data never crosses a switch hop unnecessarily.

### Tuning the "Max P2P" and "Shared Buffers"

To maximize the 400Gbps links, Meta engineers tuned the number of simultaneous connections (QP - Queue Pairs) per GPU.

```bash
# A simplified look at the environment variables used to tune NCCL for Meta's RoCE stack
export NCCL_IB_GID_INDEX=3               # Use RoCE v2
export NCCL_IB_HCA=mlx5_0,mlx5_1...     # Explicitly map NICs to GPUs
export NCCL_IB_RETRY_CNT=7               # Aggressive retry for stability
export NCCL_IB_ADAPTIVE_ROUTING=0        # Disabled in favor of software-level load balancing
export NCCL_IB_TIMEOUT=22                # Fine-tuned for large-scale fabric latency
```

---

## The Load Balancing Problem: ECMP vs. The World

In a standard network, we use **ECMP (Equal-Cost Multi-Pathing)** to spread traffic across multiple links. ECMP hashes packet headers (IPs, Ports) to decide which path to take.

But AI traffic is "heavy." A single `All-Reduce` might create a massive, long-lived flow between two GPUs. If ECMP accidentally hashes two of these heavy flows onto the same physical cable, you get **hash polarization**, a bottleneck where one link is at 100% and others are at 0%.

### Meta’s Solution: Packet-Level Load Balancing

Meta worked closely with switch vendors to implement more granular load balancing. Instead of hashing per _flow_, they can distribute traffic more evenly based on the real-time load of the egress ports. This ensures that the "Tail Latency" (the time it takes for the slowest packet to arrive) is kept to an absolute minimum.

---

## Reliability at Scale: The "Silent Killer"

When you have 24,576 GPUs, things break every single day. One of the most terrifying issues Meta faced is **Silent Data Corruption (SDC)**.

Imagine a bit flips in a network switch. It's not enough to crash the system, but it changes the weights of your model during training. After three weeks of training, your model starts outputting gibberish.

Meta's RoCE stack implements:

- **End-to-End CRC (Cyclic Redundancy Check):** Checking data integrity at the GPU memory level, the NIC level, and the Switch level.
- **Fuji & NetCheck:** Internal Meta tools that run "synthetic heartbeats" across the 24k GPUs every few seconds. If a single link shows a 1% drop in throughput, the scheduler automatically "drains" those nodes and reroutes training to healthy hardware.

---

## The Results: InfiniBand Parity

So, was it worth it? Meta’s data says **yes**.

In their benchmarking of Llama 3 training, the **RoCE v2 cluster** performed within **95-98% of the efficiency** of the InfiniBand cluster.

- **Training Throughput:** Both clusters maintained near-linear scaling up to 24,000 GPUs.
- **Job Stability:** Thanks to their custom monitoring, the RoCE cluster achieved a "Job Mean Time Between Failures" (MTBF) comparable to traditional HPC environments.

By opting for RoCE, Meta avoided being locked into a single vendor's proprietary ecosystem and proved that with enough engineering sweat, commodity Ethernet can power the most advanced AI on the planet.

---

## The Engineering Curiosity: Why 24,576?

You might wonder why such a specific number. It’s not just "big for the sake of big." It comes down to the **Radix** of the switches.

When you build a 3-stage Clos fabric using 400G switches (like the Arista 7800), the number of ports per switch determines how many "leaves" can connect to the "spine."

- 24,576 GPUs represents a perfectly balanced **Fat Tree** where there is zero oversubscription.
- Every single GPU has a dedicated, non-blocking 400Gbps path to every other GPU in the cluster.

If they had gone to 25,000, they would have had to add a 4th stage to the network, which would have increased latency and cost significantly. This is the art of **Infrastructure-Aware AI Architecture.**

---

## The Road to 100k GPUs

Meta isn't stopping at 24k. They are already talking about clusters with **hundreds of thousands of H100s and B200s**.

As we move toward those scales, the lessons learned from the custom RoCE stack will be foundational. We are moving away from a world where we "buy" a network, and into a world where we "program" the network specifically for the tensors it carries.

The boundary between the **Distributed Operating System** and the **Physical Network Fabric** has officially disappeared. For the engineers at Meta, the network _is_ the computer.

And based on the performance of Llama 3, that computer is running very, very fast.

---

**Are you working on scaling RDMA or RoCE in your own infrastructure? What’s your biggest bottleneck? Let’s geek out in the comments below.**
