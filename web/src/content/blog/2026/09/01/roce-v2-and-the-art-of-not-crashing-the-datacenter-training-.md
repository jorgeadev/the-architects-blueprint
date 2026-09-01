---
title: "RoCE v2 and the Art of Not Crashing the Datacenter: Training 100T Parameter Models at Meta Scale"
shortTitle: "Scaling 100T Parameter AI: RoCE v2 Networking at Meta Scale"
date: 2026-09-01
image: "/images/2026/09/01/roce-v2-and-the-art-of-not-crashing-the-datacenter-training-.svg"
---

**Subtitle: How we turned a network into a supercomputer—and why your TCP stack is crying.**

---

**The Hook: The 10,000 GPU Starvation Problem**

Imagine you’re building a model that has more parameters than the number of synapses in the human brain—or roughly 10 times the number of stars in the Milky Way. Now imagine you have to train that model in a reasonable amount of time. You don't have a few years; you have weeks.

You throw 25,000 NVIDIA H100s at it. You dice the model across them in 3D space (tensor, pipeline, and data parallelism). You’re feeling good. Then you run the training loop, and your GPU utilization drops to 30%.

Why? **Because your network is the bottleneck.** Specifically, the _collective communication_—the `AllReduce` and `AlltoAll` operations that require every GPU to talk to every other GPU—is slower than a glacier. Your Terabytes of data are struggling to travel across a fabric built for web traffic, not for synchronized math.

This is the exact problem Meta faced (and solved) when scaling to 100T parameter models. The solution isn't just "buy faster switches." It’s a deep, cynical re-architecture of your transport layer. We’re talking about **RoCE v2** (RDMA over Converged Ethernet version 2) and a bespoke **Hierarchical Congestion Control** algorithm that treats packet loss like a nuclear meltdown.

Buckle up. We’re going layer-by-layer.

---

## Why TCP is Dead to Us (The "Take My Breath Away" Packet)

Let’s get one thing straight: TCP is a miracle of engineering that is wildly unsuitable for distributed AI training.

In a typical datacenter, TCP does a fantastic job. It handles packet loss, reordering, and congestion by slowing down. But for AI, we need _deterministic latency_. When a GPU is waiting for a tensor to arrive to perform a matrix multiplication, a 1-millisecond TCP backoff due to a dropped packet means the GPU sits idle. If you have 25,000 GPUs, that idle time compounds exponentially. It’s not a linear slowdown; it’s a cascading failure of utilization.

**Enter RoCE v2.**

RoCE v2 allows us to read and write memory directly from one GPU to another **without involving the CPU or the kernel**. It’s a User Datagram Protocol (UDP) encapsulated packet with a special header that tells the NIC (Network Interface Card) exactly where in memory to place the data.

### The PFC Problem (Priority Flow Control)

The original implementation of RoCE was naive. It relied on **Priority Flow Control (PFC)** to ensure zero packet loss. PFC is a "stop-the-world" mechanism. If a switch port is congested, it sends a PAUSE frame back to the sender.

- **The Good:** No packets dropped.
- **The Bad:** PFC can cause head-of-line blocking and deadlocks. If a switch is congested, it pauses _all_ traffic on that lane, even traffic heading to uncongested destinations. It’s a traffic jam on the Autobahn that stops the entire highway because one driver sneezed.

At 100T parameter scale, PFC is a poison pill. We need to move data with the speed of RDMA but the grace of a ballet dancer. We need **Congestion Control** that operates at the _end-host_ level, not just the switch level.

---

## The "Meta Scale" Fabric: Not Your Grandpa's Clos

Before we discuss the algorithm, let’s map the battlefield.

Training a 100T model isn't a single job. It’s a symphony of redundant shards. Meta’s architecture typically involves a **Frontend** and **Backend** network structure.

- **Backend Network (The Intra-Cluster Fabric):** This is where the heavy lifting happens. We use a **spine-and-leaf** topology with high radix switches.
- **Racks:** Each rack has 8 GPUs connected to a Top-of-Rack (ToR) switch.
- **Spine:** ToRs connect to 128-port spine switches.

For a cluster with ~10,000+ GPUs, we are looking at a fat-tree topology with _multiple_ paths between any two endpoints. This is crucial for **ECMP (Equal-Cost Multi-Path)** .

**The Catch with ECMP:** RoCE v2 uses UDP hashing to balance flows across the fabric. If you have a massive `AllReduce` operation, you create hundreds of thousands of micro-flows. ECMP hashes these to different paths. But if the hash is bad, or if multiple large flows collide on the same path, you get **micro-bursts**.

Micro-bursts are the silent killers. They create buffer overflow at the switch ASIC. And because we are running RoCE, buffer overflow usually triggers PFC, which triggers the pause storm.

To fix this, we need to know exactly when and where congestion is building. We need a **quantum entangled** view of the network.

---

## Deep Dive: The Hierarchical Congestion Control Algorithm

Standard algorithms like DCTCP (Data Center TCP) or DCQCN (Data Center Quantized Congestion Notification) rely on ECN (Explicit Congestion Notification) marks from the switch. They work, but they are _reactive_ and _end-to-end_.

At Meta scale, we need **Hierarchical** control. We can't just look at the source and destination; we need to look at the _intermediate_ paths.

Here is the conceptual breakdown of the algorithm that makes this work:

### 1. The Congestion Point Detection (CP)

The ToR switch and Spine switch ASICs are configured to monitor queue depth. When a queue exceeds a threshold, they mark the packet with **ECN** or generate a **CNP (Congestion Notification Packet)** back to the sender. This is standard DCQCN behavior.

**But here’s the twist:** We don't just send one CNP. We send _hierarchical_ feedback.

The algorithm breaks the network into **Congestion Domains** (CDs). For example, a CD could be a set of racks connected to a specific spine.

### 2. The NPU (Network Processing Unit) Offload

The CNP is not processed by the OS. It is processed directly by the **NIC** (specifically, a BlueField DPU or a state-of-the-art NVIDIA NIC). The NIC maintains a "rate" for each flow.

- **The DCTCP approach:** The NIC reduces the rate by a fixed factor on every ECN mark.
- **The Hierarchical approach:** The NIC tracks _which_ CD the CNP came from. If a CNP comes from Spine A (CD-1), we reduce the rate for flows traversing CD-1 specifically, while keeping flows on CD-2 unaffected.

### 3. The "Multiplier" Rate Adaptation

This is where it gets technical. The formula we use is a variant of the **AIAD** (Additive Increase, Multiplicative Decrease) but with a _congestion factor_.

Let’s denote:

- `R_c`: Current sending rate.
- `C_f`: Congestion Factor (0 to 1).
- `C_ECN`: Number of ECN marked packets in the last `W` window.
- `C_Total`: Total packets in the window.

We compute the probability of congestion:

```
P_c = C_ECN / C_Total
```

If `P_c` is higher than a per-domain threshold `T_d` (which is much higher than the global threshold `T_g`), we trigger a _domain-specific_ rate limit.

The rate update law is:

- **Increase:** If no CNPs received in the last `T` microseconds, `R_c = R_c + Increase_Slope` (where `Increase_Slope` is proportional to the bandwidth-delay product of the specific path).
- **Decrease:** On CNP, `R_c = R_c * (1 - α * P_c)`.

**The Magic Sauce:** The alpha value (`α`) is _not_ static. In traditional DCQCN, alpha is updated every CNP. In our hierarchical model, alpha is learned based on the _distance_ to the congestion point.

If the CNP comes from the ToR (short hop), alpha is high (aggressive reduction). If it comes from the Spine (long hop), alpha is lower. Why? Because a CNP from the spine indicates _aggregate_ congestion across many racks, whereas a ToR CNP indicates a hotspot. Reacting aggressively to a spine CNP would cause a global network collapse. Reacting mildly allows the fabric to drain.

### 4. Pacing and Burst Shaping

Thundering herds are bad. If 100 flows all reduce their rate simultaneously and then all increase simultaneously, they create massive synchronized waves.

We implement **TDM (Time Division Multiplexing) Pacing**. This isn't just injecting packets; it's smoothing them out.

In pseudo-code, the NIC pacing logic looks like this:

```python
def send_packet(flow):
    # Calculate next send time based on rate and congestion domain
    target_rate = flow.rate[flow.congestion_domain]
    interval = 1 / target_rate  # in nanoseconds

    # Add jitter based on a hash of the flow ID to break synchronization
    interval += (hash(flow.id) % 50)  # 50 nanosecond jitter
    wait(interval)
    transmit(flow.packet)
```

This ensures that even under extreme load, we do not have bursts of packets hitting a switch buffer simultaneously.

---

## The 3D Parallelism Nexus: Why the Network is the Math

Now, let’s talk about why this matters for the 100T model specifically.

A 100T model cannot fit in the 80GB HBM of a single H100. You have to shard it. We use a combination of:

1.  **Tensor Parallelism (TP):** Splitting the matrix multiplication across GPUs _within a node_. This requires the fastest possible interconnect (NVLink). RoCE is _not_ good enough for this—we use NVSwitch.
2.  **Pipeline Parallelism (PP):** Splitting the model by layers across nodes. This creates a dependency chain.
3.  **Data Parallelism (DP):** Replicating the model across different nodes and averaging gradients.

Here’s the kicker: **The Gradient AllReduce**.

After the forward pass, you need to average the gradients across _all_ 25,000 GPUs. This is where RoCE v2 shines.

- We use a **Hierarchical AllReduce** algorithm (like the one in NCCL).
- Phase 1: GPUs in a rack (within a node) communicate over NVLink to reduce gradients.
- Phase 2: The "rack leader" GPU communicates with other rack leaders via RoCE v2 over the Ethernet fabric.

This is a classic **reduce-scatter** and **all-gather** pattern. The volume of data transferred is massive—teraBYTES per iteration.

**The Bottleneck:** In Phase 2, if we have 100 racks, we need a topology that allows all 100 rack leaders to talk to each other. This requires a full bisection bandwidth fabric. If the fabric is oversubscribed (which happens in cheaper clusters), you get concurrency collapse.

**The Meta Hierarchical Solution:**
We do not do a single global AllReduce. We do a _tiered_ one.

- **Stage 1 (Intra-Rack):** NVLink.
- **Stage 2 (Intra-Pod):** 100G RoCE to a central "high-radix" switch (the Pod Spine).
- **Stage 3 (Inter-Pod):** 400G RoCE to a "Super-Spine" connecting all Pods.

We apply **Hierarchical Congestion Control** at each stage. The key insight: The congestion control parameters for Stage 2 are _different_ from Stage 3.

- Stage 2 has a short distance. Latency is ~1 microsecond. We want high bandwidth and fast reaction.
- Stage 3 has longer distance. Latency is ~5 microseconds. We need to be more cautious.

If we used the same parameters for both, we’d either overreact to Stage 2 noise or underreact to Stage 3 congestion, causing severe packet loss.

---

## The "Bufferbloat" Nemesis: Shared Memory vs. Headroom

Let’s talk about switch buffers.

Modern switch ASICs (like the Tomahawk 5 or Spectrum-4) have finite buffer memory—usually around 64MB-128MB per chip. When you have 128 ports, that’s roughly 0.5MB per port.

When a burst of traffic arrives, it fills this buffer. If it overflows, we get packet drops.

**RoCE v2 is unforgiving:** A drop means a timeout (if using RC—Reliable Connection). The timeout in RDMA is often in milliseconds. That’s an eternity for a GPU pipeline.

**Our secret weapon:** We reserve **Headroom** on the switch.

For every port, we configure a specific amount of buffer that _cannot_ be used by standard traffic. It's reserved specifically for absorbing micro-bursts during congestion control reaction.

The formula for network-wide buffer requirements `B` is:

`B = Total_Flows * Max_RTT * Rate_per_Flow`

If `Max_RTT` is 10 microseconds and we have 10,000 flows at 100Gbps, we need a LOT of buffer. To avoid this, we use **PFC only as a last resort**—we enable it only to protect the headroom, not to manage congestion.

---

## Real-World Impact: The Numbers

What does this get us? When Meta deployed this system (utilizing RoCE v2 with this hierarchical control for training LLAMA-scale models), they measured the **Network Utilization** at **~95%** of line rate.

- **Without HCC:** We saw PFC storms causing utilization drops to 60%, with "spiky" performance.
- **With HCC:** The traffic pattern is smooth. The CNP rate drops to nearly zero during steady-state training.

We also achieved a **Zero-Packet-Loss** objective. The key metric in ML networking is **Time to Data (TTD)** —how long does it take for a tensor to go from the source GPU memory to the destination GPU memory?

- **TCP/TCP-RDMA:** TTD is variable. Jitter is high.
- **RoCE v2 w/ HCC:** TTD is deterministic. The standard deviation is less than 1% of the mean latency.

---

## The Engineering Curiosities and Gotchas

Let’s get into the nitty-gritty. If you’re implementing this at home (on your 24-GPU homelab), here’s what will bite you.

### Routing hashing

We use **Dynamic Load Balancing (DLB)** on the switch. Standard ECMP is static. If a flow is stuck on a congested path, it stays there. DLB (like on Arista/Mellanox switches) re-evaluates the hash every few microseconds and moves flows to less congested links. This works _fantastically_ with RoCE, but you must ensure your RoCE v2 packet UDP Source Port is hashed correctly. If it isn't, all packets from a single GPU will hash to the same link, causing a singularity of congestion.

### PFC Watchdog

If PFC pauses become too frequent, the switch will eventually drop them. This causes a "PFC Deadlock." Your whole cluster hangs. You need software to monitor PFC counter deltas. A sudden spike in PFC on a port is an immediate red flag that your congestion control is failing.

### The Cable Length Paradox

RoCE v2 is sensitive to cable length because of the round-trip time. If your cluster has racks with 2m cables vs 50m cables, the RTT varies. The NIC's rate recovery timer must be tuned to the _maximum_ RTT in the fabric, otherwise the sender will increase its rate before the packet actually reaches the congested switch, causing another burst.

---

## Why This Matters Beyond Meta

This isn't just about training one massive model. This is about the **democratization of AI infrastructure**.

The architecture I just described—RDMA over Ethernet, preventing drop with host-based congestion control—is the blueprint for the next decade of AI datacenters.

**NVLink** is amazing, but it’s shackled to a single chassis. Ethernet is the only technology that scales to a million GPUs.

By mastering RoCE v2 and moving away from PFC, we prove that Ethernet _can_ be a lossless fabric without the pain of InfiniBand. InfiniBand has a tight coupling of hardware and software. RoCE v2 on standard switches allows us to use commoditized hardware (ASICs from Broadcom, etc.) and open-source control planes.

### The Future: Telemetry and "In-Band" Control

My final point is on the _next_ evolution.

Currently, our congestion control relies on feedback (CNP) sent from the switch to the NIC. This adds latency.

The future is **In-Network Telemetry (INT)** . In INT, the packet itself carries a header that gets stamped by every switch it traverses with the queue depth. The receiver then reads this data and sends a _highly precise_ feedback packet to the sender. This allows the sender to know _exactly_ where the congestion is—not just "somewhere on the path."

At Meta scale, we are exploring using this telemetry to **pre-emptively** route traffic. Think of it as an oracle that tells you the fastest route _before_ you send the data, rather than reacting to a traffic jam after you’re stuck in it.

---

## The Takeaway

Training a 100T parameter model is not a software problem. It is a **physics problem**.

We are moving petabytes of data at the speed of light, orchestrating hundreds of thousands of endpoints to move in perfect lockstep. The success of the training run hinges on the humble network switch and the elegance of the congestion control algorithm.

RoCE v2 isn't just "Remote DMA over Ethernet." It's the nervous system of the AI brain. And by implementing Hierarchical Congestion Control, we’ve ensured that the nervous system doesn’t get a tremor when the brain thinks 100 trillion thoughts at once.

So, the next time you see a GPU utilization graph at 98% during training, don't pat the GPU on the back. Nod at the NIC. It’s doing the hard work.

---

_Are you dealing with RDMA performance issues in your cluster? Have you thrown away PFC yet? Let me know in the comments—I’d love to hear your horror stories._
