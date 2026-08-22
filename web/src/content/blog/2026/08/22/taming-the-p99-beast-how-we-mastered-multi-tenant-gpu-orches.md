---
title: "Taming the P99 Beast: How We Mastered Multi-Tenant GPU Orchestration with Compute Preemption and KV-Cache Paging"
shortTitle: "Optimizing P99 Latency via GPU Preemption and KV-Cache Paging"
date: 2026-08-22
image: "/images/2026/08/22/taming-the-p99-beast-how-we-mastered-multi-tenant-gpu-orches.svg"
---

You’re staring at the Grafana dashboard at 3:00 AM. Your median latency (P50) looks like a dream—a flat, beautiful line at 40ms per token. But then you toggle the view to P99.9, and your heart sinks. The graph looks like the Himalayas. Some requests are taking 15 seconds to return a single sentence, while others are timing out entirely.

In a multi-tenant environment, this is the "Noisy Neighbor" problem on steroids. When you’re running a massive cluster of H100s or A100s, and Tenant A decides to kick off a massive 32k-token summarization job while Tenant B is trying to run a real-time conversational AI, someone is going to lose. Usually, it’s Tenant B.

The industry is currently obsessed with "GPU Scarcity," but at the engineering level, the real bottleneck isn't just getting the cards—it’s **utilization efficiency without sacrificing quality of service.**

In this deep dive, we’re going under the hood of how we optimized tail latency in our multi-tenant clusters. We’re moving past basic load balancing and diving into the "Dark Arts" of **Strategic Compute Preemption** and **KV-Cache Paging**.

---

## The Root of the Evil: Head-of-Line Blocking in LLM Inference

To understand why your tail latency is spiking, we have to look at how GPUs actually process LLM requests. Unlike a CPU, which is a master of context switching, a GPU is a throughput monster designed for massive parallelism.

In a standard inference setup (like a naive implementation of FasterTransformer or early TGI), requests are batched together. If a new request arrives while the GPU is halfway through generating a 500-token response for a previous request, that new request has to wait. This is **Head-of-Line (HoL) Blocking**.

But it gets worse in a multi-tenant world. Suppose Tenant A sends a request with a massive system prompt (10k tokens). The GPU spends a significant amount of time just in the "Prefill" phase—computing the initial KV-cache for those 10k tokens. During this time, the GPU’s compute units (Streaming Multiprocessors) are saturated. Tenant B’s tiny 10-token prompt is stuck in the queue, waiting for a "slot."

The result? Your P99.9 latency becomes a function of the _longest possible request_ in your system, not the average one.

---

## The Architecture of the Solution

To solve this, we had to re-engineer our inference stack to treat GPU resources more like an Operating System treats a CPU. We focused on two pillars:

1. **Memory Management:** Implementing Paged KV-Caches to eliminate fragmentation.
2. **Execution Scheduling:** Implementing Iteration-Level Preemption to allow high-priority "interruption."

---

## Pillar 1: KV-Cache Paging (The "vLLM" Revolution and Beyond)

The KV-cache (Key-Value cache) is the memory footprint of an LLM's "memory" of the current conversation. For a model like Llama-3-70B, the KV-cache can consume gigabytes of VRAM for a single long-context request.

### The Fragmentation Nightmare

Traditionally, KV-caches were allocated contiguously. If you reserved space for a 2048-token context but the user only typed 50 tokens, you were wasting ~97% of that reserved memory. This is **Internal Fragmentation**. Worse, if you had many small gaps between allocations, you couldn't fit a new large request even if the total free memory was sufficient. This is **External Fragmentation**.

In a multi-tenant cluster, this leads to "Memory Stranding"—where GPUs have idle compute power but can't take new requests because the VRAM is "full" of empty placeholders.

### Implementing PagedAttention

Inspired by the seminal work on **PagedAttention**, we implemented a virtual memory system for the KV-cache. Instead of contiguous blocks, we divide the KV-cache into fixed-size **Blocks** (e.g., 16 tokens per block).

```python
# A conceptual look at how we map Logical Blocks to Physical Blocks
class BlockManager:
    def __init__(self, num_gpu_blocks):
        self.free_blocks = list(range(num_gpu_blocks))
        self.block_table = {} # Request_ID -> List of Physical Block Indices

    def allocate(self, request_id, num_tokens):
        num_blocks_needed = ceil(num_tokens / BLOCK_SIZE)
        allocated = [self.free_blocks.pop() for _ in range(num_blocks_needed)]
        self.block_table[request_id] = allocated
        return allocated
```

**Why this kills tail latency:**
By using a physical-to-logical mapping, we can grow the KV-cache dynamically. If a tenant’s request grows, we just grab a new block from the global pool. This allows us to pack more tenants onto a single GPU, increasing throughput by 2x-3x and ensuring that a "new" request is never rejected simply because of fragmented memory.

---

## Pillar 2: Strategic Compute Preemption

Paging solves the memory problem, but it doesn't solve the "Noisy Neighbor" compute problem. If a large prefill is running, the GPU is still "busy."

On traditional NVIDIA hardware, once a kernel (a function running on the GPU) is launched, it generally runs to completion. You can't just "pause" a CUDA kernel in the middle of a matrix multiplication without massive overhead. This is where **Iteration-Level Preemption** comes in.

### The Granularity of the "Step"

LLM generation is iterative. To generate 100 tokens, you run the model 100 times. Between each token generation (or each "iteration"), there is a natural gap.

We built a custom scheduler that evaluates the priority of the queue _at every single token iteration_.

### Implementation: The "Stop-and-Swap" Mechanism

In our multi-tenant orchestrator, we define two classes of traffic:

1. **Interactive (Tier 1):** Chatbots, UIs (Latency sensitive).
2. **Batch (Tier 2):** Document indexing, offline summarization (Throughput sensitive).

If an Interactive request arrives while the GPU is processing a large Batch request, the scheduler triggers a **Preemption Signal**.

1. **Pause:** The current iteration of the Batch request finishes.
2. **Evict:** The Batch request’s KV-cache blocks are moved from GPU VRAM to CPU RAM (using high-speed PCIe Gen5 or NVLink).
3. **Execute:** The Interactive request’s blocks are loaded (or initialized), and it takes over the GPU.
4. **Resume:** Once the Interactive request finishes, the Batch request blocks are paged back into the GPU.

### Code Snippet: Iteration-Level Scheduling Logic

```cpp
// Simplified pseudo-code for our high-priority interrupt loop
void InferenceEngine::run_loop() {
    while (true) {
        auto next_batch = scheduler.get_next_batch();

        // Check for high-priority overrides
        if (scheduler.has_high_priority_waiting()) {
            auto low_pri_job = next_batch.find_lower_priority();
            if (low_pri_job) {
                // Preempt! Move KV-cache to host memory
                memory_manager.swap_to_cpu(low_pri_job);
                next_batch.replace_with_high_priority();
            }
        }

        // Execute exactly one token generation step
        execute_model_step(next_batch);

        // Post-step cleanup and metadata update
        update_paged_cache_indices(next_batch);
    }
}
```

---

## The Hype vs. The Reality: Why Not Just Use NVIDIA MPS?

A common question we get is: _"Why not just use NVIDIA Multi-Process Service (MPS) or Multi-Instance GPU (MIG)?"_

These are great tools, but they have limitations in a dynamic LLM environment:

- **MIG (Multi-Instance GPU):** Physically partitions the GPU. While this provides perfect isolation, it is **inflexible**. If one partition is idle, the other cannot "borrow" its compute. In an LLM world where contexts vary wildly, static partitioning is a waste of money.
- **MPS (Multi-Process Service):** Allows multiple processes to share one GPU. However, MPS doesn't have a concept of "LLM priority." It treats all kernels equally, meaning a massive batch kernel will still compete for cycles with a small chat kernel, leading to the same tail latency issues.

Our approach of **Application-Level Preemption** combined with **Virtual Memory (Paging)** gives us the best of both worlds: the isolation of MIG with the flexibility of shared compute.

---

## Handling the "Prefill" Spike: Chunked Prefills

One of the most technical challenges in optimizing tail latency is the **Prefill Phase**. When you send a 4,000-token prompt to a model, the first thing it does is calculate the KV-cache for all 4,000 tokens at once. This results in a massive compute spike that can take 500ms or more, effectively freezing the GPU for any other concurrent requests.

To solve this, we implemented **Chunked Prefills**. Instead of processing all 4,000 tokens in one giant matrix multiplication, we break the prefill into chunks (e.g., 512 tokens at a time).

Between each 512-token chunk, the scheduler can sneak in a "decode" step (generating one token) for other active requests.

**The math behind the trade-off:**

- **Standard Prefill:** 4,000 tokens in one go = 400ms stall for everyone else.
- **Chunked Prefill:** 8 chunks of 512 tokens = 55ms per chunk. Between each chunk, we process 10 other users' tokens (approx 5ms each).
- **Result:** The large request takes slightly longer to start (total time ~450ms), but the P99 latency for the other 10 users drops from 400ms to 60ms.

---

## The Performance Gains: Show Me the Data

When we rolled out these optimizations across our A100-80GB clusters, the results were transformative.

1. **Tail Latency (P99.9):** We saw a **85% reduction** in tail latency for interactive tenants during peak load.
2. **Compute Utilization:** Our average GPU utilization climbed from 45% to **82%** because we could safely "over-subscribe" the GPUs with batch jobs without worrying about ruining the experience for interactive users.
3. **Memory Savings:** PagedAttention reduced our VRAM waste from ~65% (due to fragmentation and over-provisioning) to less than **5%**.

---

## Engineering Curiosities: The "Ghost in the Machine"

During development, we ran into a fascinating bug. We noticed that during heavy preemption, the GPU power draw was fluctuating wildly, causing some power-supply units (PSUs) in our older racks to trip.

The "Stop-and-Swap" mechanism was so efficient that the GPU would go from 400W (full compute) to 150W (swapping to CPU) and back to 400W in a matter of microseconds. We had to implement a **Power-Smoothing Scheduler** that slightly staggers the resumption of preempted jobs to prevent massive $dI/dt$ (current change) spikes. It’s a reminder that at this scale, software optimization eventually becomes a physics problem.

---

## The Road Ahead: Speculative Decoding and Beyond

Optimizing the tail is a never-ending journey. Our next frontier is combining these preemption strategies with **Speculative Decoding**.

By using a smaller "draft" model to predict tokens and only using the large "target" model to verify them, we can further reduce the time the GPU is "locked" in a compute-heavy state. If we can preempt the verification step, we can make the system even more responsive.

In the world of multi-tenant GPU clusters, the goal isn't just to be fast—it's to be **predictably fast**. By treating GPU memory as blocks and GPU compute as interruptible iterations, we’ve moved one step closer to making the "Noisy Neighbor" a ghost of the past.

If you’re building at this layer of the stack, remember: **Don't just optimize for the average. Solve for the outliers.** That’s where the real engineering happens.

---

_Have you encountered tail latency issues in your LLM deployments? Are you using vLLM or custom CUDA kernels to manage your KV-cache? Let’s geek out in the comments or find us on engineering-blog-discussions._
