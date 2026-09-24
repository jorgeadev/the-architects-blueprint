---
title: "The Ghost in the Ethernet: Scaling LLM Training Without the InfiniBand Tax"
shortTitle: "Scaling LLM Training via Ethernet Without the InfiniBand Tax"
date: 2026-09-24
image: "/images/2026/09/24/the-ghost-in-the-ethernet-scaling-llm-training-without-the-i.svg"
---

In the high-stakes world of Large Language Model (LLM) training, we are currently witnessing a hardware arms race that would make the Cold War look like a schoolyard skirmish. We talk endlessly about H100s, B200s, and the raw TFLOPS of specialized silicon. But there is a dirty secret in the data center: **Compute is easy; communication is hard.**

If you’re building a cluster with 16,384 GPUs to train the next GPT-5 competitor, you quickly realize that your GPUs spend an agonizing amount of time just waiting. Waiting for weights to sync, waiting for gradients to aggregate, and waiting for the network to stop choking on the sheer volume of data being shoved through it.

For a long time, the industry answer was simple: **InfiniBand.** It was the "easy button" for low-latency, lossless networking. But InfiniBand is expensive, proprietary, and currently has lead times that feel like they’re measured in geological epochs.

Enter the challenger: **RoCE v2 (RDMA over Converged Ethernet).** The promise is seductive—get InfiniBand-like performance using "standard" Ethernet hardware. But as many engineering teams are finding out the hard way, scaling RoCE v2 to 10,000+ nodes is not a "plug-and-play" affair. It is a brutal exercise in architectural gymnastics.

Today, we’re diving deep into the guts of **Zero-Copy data transfer**, the physics of **RoCE v2**, and the architectural bottlenecks that threaten to derail the dream of the InfiniBand-less GPU cluster.

---

## The Zero-Copy Holy Grail: Why We Can’t Afford the CPU

To understand why we need RoCE v2, we first have to understand the "Standard" networking path and why it’s a non-starter for LLMs.

In a traditional TCP/IP stack, moving data from Application A on Host 1 to Application B on Host 2 is a logistical nightmare. The data is copied from the application buffer to the kernel buffer, then to the NIC (Network Interface Card) buffer, then sent over the wire, and then the whole "copying" dance happens in reverse on the receiving end.

For a web server, this is fine. For training a 1.8-trillion parameter model, this is a catastrophe. Each "copy" operation involves the CPU. If you’re pushing 400Gbps of data, the CPU becomes a glorified traffic cop, burning cycles just moving bytes around instead of managing the training orchestration.

**Zero-Copy** (enabled by **RDMA**—Remote Direct Memory Access) changes the game. It allows the NIC to read data directly from the GPU memory (via PCIe) and place it directly into the memory of a remote GPU, bypassing the host CPU and the OS kernel entirely.

### The Mechanics of the "Invisible" Transfer

When we talk about Zero-Copy in a GPU context, we are specifically looking at **GPUDirect RDMA**. Here is the high-level flow of a single gradient sync:

1.  **Memory Registration:** The training framework (like PyTorch) registers a chunk of GPU memory with the NIC. This "pins" the memory, ensuring the OS doesn't swap it out to disk while we're not looking.
2.  **The Doorbell Ring:** The GPU sends a small "doorbell" signal to the NIC via the PCIe bus, saying, "Hey, I’ve got 4GB of gradients ready at this memory address."
3.  **The PCIe Direct Path:** The NIC initiates a DMA (Direct Memory Access) read across the PCIe switch. The data flows from the HBM (High Bandwidth Memory) on the GPU, through the PCIe complex, straight into the NIC's transmit buffer.
4.  **Network Transit:** The NIC wraps this data in RoCE v2 headers and blasts it onto the wire.
5.  **Remote Write:** The receiving NIC strips the headers and writes the data directly into the remote GPU's memory.

The CPU never touches the data. This is how we achieve sub-microsecond latencies. But, as we’re about to see, doing this over Ethernet introduces a world of pain.

---

## RoCE v2: The "Converged" Compromise

InfiniBand is "lossless" by design. It uses credit-based flow control at the link layer. A sender won't send a packet unless it _knows_ the receiver has a buffer ready to catch it. Ethernet, by contrast, was born to be "lossy." If a switch gets full, it just drops packets and expects TCP to figure it out 10 milliseconds later.

In LLM training, a single dropped packet is a disaster. Because we use **Collective Communications** (like `All-Reduce`), the entire cluster moves in lockstep. If Node 432 drops a packet, Nodes 1 through 16,384 all stop and wait for a retransmission.

**RoCE v2** attempts to fix this by wrapping RDMA payloads inside UDP/IP packets. This allows RDMA to be routed across standard Layer 3 networks. But to make it work for LLMs, we have to force Ethernet to act like InfiniBand. This is where **PFC (Priority Flow Control)** and **ECN (Explicit Congestion Notification)** come in.

### The Fragility of Lossless Ethernet

To prevent packet loss, RoCE v2 clusters rely on **PFC**. When a switch's buffer starts filling up, it sends a "PAUSE" frame to the upstream neighbor.

It sounds simple, but at scale, this creates a "Congestion Spreading" nightmare. Imagine a single slow receiver on your network. The switch connected to it sends a PAUSE frame to its neighbor. That neighbor then sends a PAUSE frame to _its_ neighbor. Within microseconds, a localized bottleneck has paralyzed a massive tree of your network. This is known as **Head-of-Line (HoL) Blocking**, and it is the primary reason why InfiniBand-less clusters are notoriously difficult to tune.

---

## The Architectural Bottlenecks: Where Scaling Breaks

You’ve spent $500 million on GPUs and another $50 million on 400G switches. You’ve configured PFC and ECN. You start the training job. Why is your MFU (Model Flops Utilization) sitting at 35% instead of 70%?

### 1. The Incast Problem and the "Buffer Bloat" Paradox

LLM training involves **Heavy Incast**. During an `All-Reduce` operation, hundreds of nodes might try to send data to a single node simultaneously. Even with 400Gbps links, the switch buffers simply cannot handle the burst.

In a standard Ethernet environment, we use large buffers to handle bursts. But in RDMA, **buffers are the enemy of latency.** If a packet sits in a switch buffer for 50 microseconds, it’s already "late" for the GPU’s synchronization barrier. Finding the "Goldilocks" zone of switch buffer depth—enough to handle the incast, but small enough to maintain low latency—is one of the most significant engineering hurdles in RoCE v2 deployment.

### 2. The PCIe Bottleneck: The Hidden "Middleman"

We often blame the network, but the bottleneck is frequently inside the server. In a typical H100 HGX node, you have 8 GPUs connected via NVLink, but only 4 or 8 NICs connecting that node to the outside world.

Data moving between nodes must pass through the **PCIe Switch**.

- **The Contention:** The NIC is competing with other NICs and the NVLink fabric for PCIe bandwidth.
- **The Topology:** If your NIC is connected to PCIe Root Complex A, but it needs to pull data from a GPU connected to PCIe Root Complex B, the data has to hop through the CPU's internal bus (like Intel's UPI or AMD's Infinity Fabric).
- **The Result:** This "cross-socket" hop adds latency and introduces jitter. In the world of billions of parameters, **jitter is a silent killer.** If your P99 latency is 10x your P50, your entire cluster will eventually synchronize to that P99 speed.

### 3. Entropy and Load Balancing: The ECMP Trap

Ethernet typically uses **ECMP (Equal-Cost Multi-Pathing)** to spread traffic across multiple links. ECMP hashes packet headers (IPs, Ports) to decide which path a packet takes.

The problem? RoCE v2 flows are "Elephant Flows"—long-lived, high-bandwidth streams. If the ECMP hash happens to put two 400Gbps flows on the same physical 400Gbps link while another link sits idle, you get a collision. In a standard TCP world, this is fine. In a RoCE v2 world, this triggers PFC PAUSE frames, which triggers congestion spreading, which kills your training throughput.

**The Solution?** Engineers are now moving toward **Adaptive Routing** or **Packet Spraying**. This requires specialized NICs and switches (like those from Broadcom’s Tomahawk 5 series) that can look at the actual load of a link in real-time and steer packets to the least-congested path.

---

## Engineering the Solution: The "Ultra Ethernet" Rebellion

The industry has realized that RoCE v2, while a valiant effort, is essentially "hacking" Ethernet to do something it wasn't meant to do. This has led to the formation of the **Ultra Ethernet Consortium (UEC)**.

Companies like Meta, Microsoft, Broadcom, and AMD are essentially trying to rebuild the Ethernet transport layer specifically for AI. Here is what the "next-gen" InfiniBand-less architecture looks like:

### Flexible Ordering

Traditional RDMA requires packets to arrive in the exact order they were sent. If packet #5 is delayed, packets #6 through #1000 can't be processed. UEC is moving toward **out-of-order delivery**, allowing the NIC to process whatever arrives and reassemble the "puzzle" at the end. This allows for much more aggressive load balancing across the network fabric.

### Hardware-Level Congestion Control (DCQCN and Beyond)

We are moving away from the blunt instrument of PFC (PAUSE frames). Instead, we use **DCQCN (Data Center Quantized Congestion Notification)**.

DCQCN uses a combination of ECN (Explicit Congestion Notification) and hardware-based rate limiters on the NIC. When a switch sees congestion, it marks a bit in the packet header. The receiver sees this bit and sends a "Congestion Notification Packet" back to the sender. The sender’s hardware then instantly throttles the flow.

```python
# Conceptual representation of NCCL tuning for RoCE v2
# We often have to manually tune the number of rings and
# the maximum communication channels to avoid saturating
# specific PCIe lanes.

import os

# Set NCCL to use RoCE v2 specifically
os.environ['NCCL_IB_GID_INDEX'] = '3' # Points to the RoCE GID
os.environ['NCCL_IB_HCA'] = 'mlx5_0,mlx5_1' # Specific NICs
os.environ['NCCL_IB_RETRY_CNT'] = '7' # High retry for lossy nets

# Tune the number of channels to match the PCIe topology
# Too many channels = more contention; too few = underutilization
os.environ['NCCL_MIN_NCHANNELS'] = '32'
```

---

## The "Tail Latency" Tax: Why Your Cluster is Only as Fast as Its Slowest Link

In a distributed training environment, the communication pattern is often a "Barrier."

1. Compute (GPU calculates gradients).
2. Communicate (GPUs swap gradients).
3. Update (GPUs update weights).

If you have 2,048 GPUs, the "Communicate" phase doesn't finish until the **very last** packet from the **very slowest** NIC has arrived.

On a standard Ethernet network, you might have "flapping" links, or a switch that is doing a background management task, or a slight thermal throttling on a single optics module. In a web app, a 2ms delay on one request is invisible. In an LLM training run, if that 2ms delay happens every iteration (and there are millions of iterations), it adds **weeks** to your training time.

Engineering teams at places like Meta have built entire observability stacks just to monitor **RDMA Retransmission Rates**. If a single link shows a 0.001% increase in retransmits, it is immediately cordoned off and the training job is restarted. This level of operational rigor is the "hidden cost" of going InfiniBand-less.

---

## The Verdict: Is RoCE v2 Ready for the "God Model"?

So, can you scale to 100,000 GPUs without InfiniBand?

The answer is **yes, but it’s an engineering nightmare.**

Meta’s recent unveiling of their two 24,576-GPU clusters showed one cluster built on InfiniBand and the other on RoCE v2 (using the Arista 7800 platform). They proved that with enough custom tuning of the **NCCL (Nvidia Collective Communications Library)** and a carefully designed **Clos topology**, RoCE v2 can match InfiniBand’s performance.

But here is the takeaway for most engineering teams: **RoCE v2 isn't "Standard Ethernet."** It is a high-performance, fragile, and complex transport protocol that just _happens_ to run on Ethernet cables.

### To build a successful InfiniBand-less cluster, you must:

- **Design for Rail-Optimization:** Ensure that GPUs in different nodes can talk to each other through the same "rail" of switches to minimize hops.
- **Master the PCIe Map:** Know exactly which NIC talks to which GPU and ensure your NCCL topology awareness is perfectly tuned.
- **Aggressively Manage Congestion:** Move beyond PFC and embrace DCQCN with hardware-level rate-limiting.
- **Invest in Observability:** If you can't see a micro-burst in your switch buffer, you can't train a frontier model.

The "InfiniBand Tax" is real, but so is the "Ethernet Engineering Tax." Choosing RoCE v2 doesn't save you from complexity; it just shifts that complexity from your procurement budget to your systems engineering team.

As we move toward the next generation of 800G and 1.6T networking, the battle between the proprietary elegance of InfiniBand and the open-source chaos of Ethernet will only intensify. For those of us building the infra, it’s the most exciting—and frustrating—time to be an engineer.

**The compute is the brain, but the network is the nervous system. And right now, we’re all trying to figure out how to keep that nervous system from collapsing under the weight of a trillion parameters.**
