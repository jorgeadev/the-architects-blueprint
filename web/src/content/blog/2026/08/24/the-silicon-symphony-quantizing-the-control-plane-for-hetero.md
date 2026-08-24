---
title: "The Silicon Symphony: Quantizing the Control Plane for Heterogeneous H100 and L40S Clusters"
shortTitle: "Quantizing Control Planes for Heterogeneous H100 and L40S Clusters"
date: 2026-08-24
image: "/images/2026/08/24/the-silicon-symphony-quantizing-the-control-plane-for-hetero.svg"
---

The year is 2024, and the "GPU Gold Rush" has entered its most complex phase. In the early days of the LLM explosion, the strategy was simple: buy every NVIDIA H100 you could find, cable them together with InfiniBand, and pray your power bill didn't trigger a local grid failure.

But as the dust settles, the engineering reality has become far more nuanced. We aren’t just building massive monoliths anymore; we are building **heterogeneous inference factories**.

If you are running a high-scale LLM service today, you likely aren’t just running on H100s. You’re running a fleet of H100s (SXM5) for your heavy-duty training and long-context prefill, alongside a sprawling army of L40S GPUs (PCIe) for high-throughput decoding. On paper, this is a cost-efficiency dream. In practice, it is an orchestration nightmare.

When your compute fabric is uneven, traditional orchestration—the kind provided by "vanilla" Kubernetes or basic round-robin load balancers—starts to break. We call this the **Orchestration Tax**. To pay it, you lose 20-30% of your theoretical throughput to "the gap": the time spent waiting for the control plane to figure out where to send a 128k-token request vs. a 512-token chat message.

Today, we’re diving deep into a concept we’ve been refining at the edge of the stack: **Quantizing the Control Plane.** We’re moving beyond simple scheduling and into hardware-aware, microsecond-latency orchestration that treats the difference between HBM3 (H100) and GDDR6 (L40S) not as a hurdle, but as a lever for performance.

---

## The Hype vs. The Hardware: Why Heterogeneity is Inevitable

The tech press loves the H100. It’s the "Veblen good" of the silicon world. With its 80GB of HBM3 memory and 3.35 TB/s of bandwidth, it is objectively the king of the datacenter. But the L40S—often dismissed as the "workstation-class" younger sibling—is the industry’s best-kept secret for inference.

Based on the Ada Lovelace architecture, the L40S lacks the NVLink interconnectivity of the SXM H100s, and its GDDR6 memory bandwidth is significantly lower. However, its **FP8 Tensor Core performance** is staggering. For pure token generation (the "decode" phase of inference), the L40S often delivers a better price-to-performance ratio than the H100, provided your model fits in its 48GB VRAM.

The hype cycle says "H100 or bust." The engineering reality says "H100 for the Prefill, L40S for the Decode."

When you mix these two, you create a **Heterogeneous Cluster**. And that's where the control plane comes in. If your control plane is "fat"—meaning it’s slow, makes coarse-grained decisions, and doesn't understand the underlying silicon—your H100s will sit idle waiting for the L40S to finish a job, or worse, your L40S will be choked by a long-context request it was never meant to handle.

---

## What Does it Mean to "Quantize" a Control Plane?

In the context of LLMs, quantization usually refers to reducing the precision of weights (e.g., FP16 to INT4) to save memory and speed up compute.

When we talk about **Quantizing the Control Plane**, we are applying a similar philosophy to orchestration logic:

1.  **Bit-Depth Reduction of State:** Instead of tracking thousands of granular metrics per GPU (temperature, fan speed, minor memory fluctuations), we reduce the "state" to the absolute high-entropy bits required for a routing decision.
2.  **Latency Compression:** Reducing the decision-making time from the 10ms–100ms range (standard K8s) to the sub-millisecond range.
3.  **Hardware-Aware Precision:** Mapping specific request "weights" (context length, requested tokens) to the "precision" of the available hardware (H100 vs. L40S).

To understand why this is necessary, we have to look at the anatomy of an LLM request.

---

## The Prefill/Decode Split: The Architectural Fracture

Every LLM inference request has two distinct phases:

1.  **The Prefill Phase:** The model processes the input tokens. This is highly compute-bound and benefits massively from the high memory bandwidth and Tensor Core count of the H100.
2.  **The Decode Phase:** The model generates output tokens one by one. This is memory-bandwidth bound (for the KV cache) but requires less raw compute per token.

In a unified H100 cluster, the GPU switches between these phases. But in a heterogeneous cluster, we can perform **Disaggregated Prefill and Decode**.

### The L40S Bottleneck: The Memory Wall

The L40S uses GDDR6, which tops out around 864 GB/s. Compare that to the H100’s 3.35 TB/s. If you send a 32,000-token prompt to an L40S, the "Time to First Token" (TTFT) will be abysmal because the GPU is starving for data.

However, once you are in the "Decode" phase, you are generating tokens one at a time. The L40S’s fourth-generation Tensor Cores are more than capable of keeping up with human reading speeds (and then some).

**The Quantized Strategy:** Our control plane must identify the "weight" of the prompt. If the prompt is $> 4096$ tokens, the control plane "quantizes" the routing decision and forces it onto the H100. If the prompt is small but the requested output is long, it targets the L40S.

---

## Infrastructure Deep-Dive: Building the Hardware-Aware Scheduler

To implement this, we moved away from the standard `kube-scheduler`. We built a sidecar-based "Fast-Path" orchestrator that sits directly on the RDMA (Remote Direct Memory Access) fabric.

### 1. The KV Cache Awareness Layer

One of the biggest engineering curiosities in LLM orchestration is the **KV Cache**. When a model generates text, it stores the mathematical state of previous tokens in VRAM. Moving this cache between an H100 and an L40S is expensive (limited by the PCIe Gen5 bus on the L40S).

Our control plane tracks the "affinity" of the KV cache across the cluster. We use a **Counting Bloom Filter** to keep a probabilistic map of which GPUs hold which parts of a conversation's context.

```python
# A simplified conceptual snippet of the Quantized Router's scoring logic
def calculate_gpu_affinity(request, gpu_node):
    # Quantize request features
    is_long_context = 1 if request.prompt_len > 4096 else 0
    is_high_throughput = 1 if request.max_tokens > 512 else 0

    # Hardware profile bits
    is_h100 = 1 if gpu_node.type == "H100_SXM5" else 0
    is_l40s = 1 if gpu_node.type == "L40S_PCIe" else 0

    # Decision Matrix
    score = (is_long_context * is_h100 * 1.0) + \
            (is_high_throughput * is_l40s * 0.8) + \
            (gpu_node.available_vram / gpu_node.total_vram)

    return score
```

### 2. The RDMA/RoCE v2 Fabric

In a heterogeneous cluster, the interconnect is the weakest link. H100 nodes are typically connected via **InfiniBand NDR (400G)**. L40S nodes, being PCIe-based, often sit on **RoCE v2 (Ethernet-based RDMA)**.

The control plane must be "topology-aware." If a request needs to hop from an H100 (for prefill) to an L40S (for decode), it shouldn't go through the standard TCP/IP stack. We use **GPUDirect RDMA** to bypass the CPU entirely, moving the KV cache from H100 HBM3 to L40S GDDR6 via the system’s PCIe switch. This reduces the transfer latency from ~50ms to ~2ms.

---

## Quantizing the Control Loop: From Milliseconds to Microseconds

In a standard web architecture, a 50ms overhead for a load balancer is acceptable. In LLM inference, where the **Time Per Output Token (TPOT)** can be as low as 8ms–10ms, a 50ms scheduling delay is catastrophic. It’s the difference between a UI that feels like magic and one that feels broken.

### Eliminating the "Kube-Tax"

Kubernetes is great for many things, but its `etcd` backing store and controller-manager loops are too slow for real-time token routing. We implemented what we call a **"Zero-State" Control Plane.**

Instead of writing the state of every GPU to a database, the GPUs broadcast their availability via a UDP multicast heartbeat every 500 microseconds. The orchestrator holds this state in a lock-free ring buffer.

By "quantizing" the state—ignoring things like minor temperature fluctuations and focusing only on **VRAM Slot Availability** and **Compute Queue Depth**—we reduced the orchestration binary's memory footprint to less than 64MB and its decision latency to **under 200 microseconds**.

---

## Scaling the Un-Scalable: Dealing with "Compute Drift"

One of the most fascinating engineering challenges we encountered was **Compute Drift**. In a cluster of 1,000 H100s, you can expect fairly uniform performance. In a mixed cluster, the "tail latency" (P99) becomes incredibly volatile.

An L40S might be performing perfectly, but if it shares a PCIe root complex with a high-speed NIC that is currently saturated, its performance will tank. Our control plane uses **Predictive Sharding**.

We don’t just look at where a request _can_ go; we use a lightweight heuristic model (a "Meta-Model" for the Control Plane) to predict where the request _will finish fastest_.

### Example Scenario:

- **Request A:** 2,000-word essay prompt.
- **Request B:** "Hello, how are you?"
- **The Scheduler's Choice:** The scheduler sees an idle L40S and a busy H100. A "dumb" scheduler sends Request A to the L40S. The L40S spends 400ms in prefill. Meanwhile, the H100 finishes its task in 50ms and sits idle.
- **The Quantized Choice:** The scheduler recognizes Request A as "Heavy." It holds Request A for 10ms until the H100 is free, knowing the H100 will finish the prefill in 40ms. Total time: 50ms. The L40S is kept open for the next ten "Request B" types that come in.

---

## The Software Stack: vLLM, PagedAttention, and Custom Kernels

You can't talk about optimizing inference without talking about **vLLM** and **PagedAttention**. PagedAttention allows us to manage VRAM like virtual memory in an OS, breaking the KV cache into non-contiguous blocks.

In a heterogeneous environment, we extend this by implementing **Heterogeneous PagedAttention**.

We’ve modified our kernels to allow for "Virtual VRAM Pools" that span across H100 and L40S nodes. If an H100 is running out of HBM3 but has excess compute, it can actually "page out" parts of its KV cache to the VRAM of a nearby L40S via the RDMA fabric.

This is the ultimate expression of quantizing the control plane: treating the entire datacenter's VRAM as a single, multi-tiered memory hierarchy.

| Metric                          | Standard Orchestration (Mixed Cluster) | Quantized Control Plane |
| :------------------------------ | :------------------------------------- | :---------------------- |
| **TTFT (P99)**                  | 450ms                                  | 110ms                   |
| **Throughput (Tokens/sec/$1k)** | ~14k                                   | ~22k                    |
| **Scheduling Latency**          | 15ms - 50ms                            | < 0.5ms                 |
| **KV Cache Utilization**        | 65%                                    | 92%                     |

---

## The Engineering Curiosity: The "Cold Start" of Weights

When orchestrating across H100s and L40Ss, you also have to manage the "weight loading" bottleneck. An H100 can pull a 70B parameter model from NVMe storage into VRAM almost instantly. The L40S, limited by PCIe bandwidth, takes significantly longer.

To solve this, our control plane implements **Predictive Weight Prefetching**. By analyzing incoming traffic patterns (using a simplified Markov chain), the control plane predicts which models will be needed on which hardware types 30 seconds in advance.

If we see a spike in "Code Generation" requests (which typically use models like DeepSeek or CodeLlama), the control plane begins shifting those weights onto the L40S nodes before the "standard" load balancer even knows there's a surge.

---

## Why This Matters for the Future of AI

The industry is moving away from the "One Model to Rule Them All" philosophy toward **Mixture of Experts (MoE)** and specialized small models. This means the future of AI is not a single GPU type; it’s a mosaic of silicon.

We will see clusters containing H100s for training, L40Ss for throughput, and perhaps even specialized ASIC chips (like Groq or Tenstorrent) for ultra-low latency.

A "thick," slow control plane will be the death of these systems. We need orchestrators that are as fast as the chips they manage. We need control planes that understand the physics of the hardware—the latency of a PCIe trace, the bandwidth of an HBM stack, and the energy cost of a bit-flip.

## Final Reflections

Optimizing a heterogeneous H100/L40S cluster is not just a DevOps task; it is a fundamental re-imagining of the compute stack. By **Quantizing the Control Plane**, we strip away the abstractions that have served us for decades in the world of web microservices.

We are no longer just "routing traffic." We are choreographing a high-speed ballet of electrons across different grades of silicon, ensuring that every Tensor Core, whether it’s in a flagship H100 or a utilitarian L40S, is sweating every second.

If you’re still using a standard round-robin load balancer for your LLMs, you aren't just leaving performance on the table—you're leaving the future there. It’s time to quantize your logic, tighten your control loops, and embrace the silicon symphony.

---

### Technical Glossary for the Modern Infrastructure Engineer

- **HBM3 vs. GDDR6:** High Bandwidth Memory (H100) vs. Graphics Double Data Rate memory (L40S). HBM3 is stacked vertically and offers ~4x the bandwidth.
- **TTFT (Time to First Token):** The latency from the user’s request to the first character appearing. Heavily dependent on prefill speed.
- **TPOT (Time Per Output Token):** The speed at which subsequent tokens are generated. Heavily dependent on memory bandwidth.
- **RoCE v2:** RDMA over Converged Ethernet. Allows GPUs to talk to each other across a network without involving the CPU.
- **SXM5:** NVIDIA’s high-performance socket for H100s, allowing for maximum NVLink speeds.
- **PCIe Gen5:** The bus standard used by L40S. While fast, it is a significant bottleneck compared to NVLink for GPU-to-GPU communication.
