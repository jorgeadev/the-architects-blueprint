---
title: "Taming the Tail: How PagedAttention Solves the KV-Cache Fragmentation Crisis in Multi-Tenant LLM Serving"
shortTitle: "PagedAttention: Solving KV-Cache Fragmentation in LLM Serving"
date: 2026-09-13
image: "/images/2026/09/13/taming-the-tail-how-pagedattention-solves-the-kv-cache-fragm.svg"
---

You’ve built a state-of-the-art LLM application. Your RAG pipeline is tight, your prompts are optimized, and your Llama-3-70B model is quantized to perfection. But as soon as you move from a single-user demo to a high-concurrency production environment, the nightmare begins: **P99 tail latency spikes.**

While your average response time looks okay, a significant chunk of your users are waiting 10, 20, or even 60 seconds for a response. You look at your GPU utilization, and it's a paradox—your VRAM is 95% full, but your actual compute throughput is abysmal. You’re hitting Out-of-Memory (OOM) errors even though, mathematically, you should have enough space for more requests.

Welcome to the world of **KV-Cache fragmentation.**

In this deep dive, we’re going to dissect why traditional memory management fails for Large Language Models (LLMs), how the industry shifted toward **PagedAttention**, and the architectural wizardry required to keep tail latencies low in a multi-tenant world where request lengths are unpredictable and GPU memory is more precious than gold.

---

## The Hidden Tax: Why the KV-Cache is a Memory Hog

To understand the solution, we have to understand the bottleneck. In an autoregressive Transformer model, generating a response is a sequential process. To generate token $N$, the model needs the "Keys" and "Values" (KV) of all previous tokens ($1$ to $N-1$) to calculate the attention mechanism.

If we re-calculated these KV pairs for every new token, the computational cost would be $O(N^2)$, making long-form generation impossibly slow. To fix this, we use a **KV-Cache**. We store the KV tensors in the GPU VRAM so that each step only needs to calculate the KV pair for the _current_ token.

### The Math of the Cache

Let’s look at the scale. For a model like Llama-3-70B (using Grouped Query Attention):

- **Hidden Dimension:** 8192
- **Layers:** 80
- **Precision:** FP16 (2 bytes per element)
- **Number of KV heads:** 8

For a single token, the KV cache size is:
$2 \times \text{layers} \times \text{hidden\_dim} \times \text{bytes} = 2 \times 80 \times 8192 \times 2 \approx 2.6 \text{ MB per token.}$

This doesn't sound like much until you consider a context window of 8,192 tokens. That’s **21 GB of VRAM for just one user's history.** In a multi-tenant environment serving 50 concurrent users, you’re looking at over 1 Terabyte of VRAM—far exceeding the 80GB capacity of an NVIDIA H100.

---

## The Fragmentation Crisis: Internal vs. External

Before the era of vLLM and PagedAttention, frameworks like HuggingFace `transformers` or early versions of NVIDIA FasterTransformer treated the KV-cache as a **contiguous block of memory.**

When a request came in, the system would pre-allocate a chunk of VRAM based on the **maximum possible sequence length** (e.g., 2048 tokens). This led to three types of catastrophic memory waste:

1.  **Internal Fragmentation:** A user asks a question that requires only 100 tokens of generation. However, the system has reserved space for 2048 tokens. The remaining 1948 slots sit empty, reserved but unusable by any other request.
2.  **External Fragmentation:** As requests of different lengths start and stop, the VRAM becomes a "Swiss cheese" of small, non-contiguous free blocks. You might have 10GB of total free VRAM, but if it's not in one continuous chunk, the allocator can't fit a new 8GB request.
3.  **Reservation Waste:** Even if you don't pre-allocate the full length, you often have to over-provision memory to account for the _potential_ growth of a sequence.

In production, this meant that **up to 60-80% of GPU memory was wasted.** This waste directly correlates to P99 latency. Why? Because when memory is fragmented, the "Continuous Batching" scheduler cannot fit new requests into the GPU. Requests sit in a queue, waiting for a large enough memory block to open up. This queuing delay is the primary driver of tail latency.

---

## Enter PagedAttention: The OS-Inspired Revolution

In 2023, researchers from UC Berkeley introduced **vLLM** and the **PagedAttention** algorithm. The core realization was brilliant in its simplicity: **Why are we treating GPU memory like a single tape when Operating Systems solved this exact problem 50 years ago with Virtual Memory?**

PagedAttention treats the KV-cache as a series of non-contiguous **blocks**. Instead of requiring a single large block of VRAM for a request, it breaks the KV-cache into small, fixed-size blocks (e.g., 16 tokens per block).

### How the Architecture Works

The system maintains a **Physical Block Table** and a **Logical Block Table**.

- **Logical Blocks:** These represent the sequence of tokens from the perspective of the LLM. They are contiguous.
- **Physical Blocks:** These are scattered across the GPU's VRAM. They are _not_ contiguous.
- **The Block Table:** A mapping layer that translates logical indices to physical addresses.

When the model generates a new token, the engine checks if the current physical block has room. If it’s full, the engine grabs a new block from the **Free Block Pool**. This block could be anywhere in memory. Because the GPU kernels for PagedAttention are designed to fetch these scattered blocks efficiently, there is virtually zero performance penalty for this non-contiguous access.

### Why This Crushes Tail Latency

1.  **Near-Zero Fragmentation:** Since blocks are small and fixed-size, the only waste is at the very last block of a sequence (Internal fragmentation is limited to < 16 tokens).
2.  **Dynamic Allocation:** You don't need to know the output length in advance. Memory is allocated on-demand, one block at a time.
3.  **Increased Throughput:** By eliminating waste, you can pack 2x to 4x more concurrent requests onto the same GPU. More requests in flight means fewer requests waiting in the queue, which drastically lowers the P99.

---

## The Multi-Tenant Advantage: Prefix Sharing and Beam Search

In a multi-tenant SaaS environment, you often have many users hitting the same "system prompt" or the same set of documents in a RAG setup.

In traditional architectures, if 100 users are chatting with a bot that has a 2000-token system prompt, you would store that same 2000-token KV-cache 100 times. That’s a massive waste of VRAM.

### Complex Memory Sharing

PagedAttention introduces the concept of **Copy-on-Write (CoW)** for the KV-cache. If multiple requests share a common prefix (e.g., a long legal document or a complex prompt template), the engine can map multiple logical blocks to the _same_ physical block.

- **Prefix Caching:** The first 500 tokens of a prompt are stored once. 100 different requests point to those same physical blocks.
- **Beam Search:** When the model explores multiple paths (beams), the common history is shared. Only when the paths diverge does the engine allocate new blocks for the differences.

This sharing is a game-changer for P99s in RAG applications. By caching the KV-cache of frequently used documents (the "context"), the "Time to First Token" (TTFT) drops significantly because the model doesn't have to re-compute the KV values for the context; it just points to the existing blocks.

---

## Under the Hood: The CUDA Kernel Engineering

Implementing PagedAttention isn't just about high-level logic; it requires deep-level CUDA optimization. The standard Attention kernels (like those in FlashAttention) assume that the KV-cache is stored in a contiguous layout (typically `[batch, head, seq_len, head_dim]`).

To make PagedAttention work, engineers had to write custom kernels where:

1.  The `Key` and `Value` pointers are updated dynamically by looking up the **Block Table**.
2.  Memory access is coalesced to ensure that the GPU's high bandwidth is actually utilized despite the fragmented nature of the blocks.
3.  The kernel handles the "un-aligned" nature of the last block in a sequence.

The result is a kernel that manages to achieve nearly the same **Memory Bandwidth Utilization (MBU)** as contiguous kernels while offering the flexibility of paging.

```cpp
// Simplified conceptual view of a PagedAttention kernel access
__global__ void paged_attention_kernel(
    float* out,
    const float* query,
    const float* k_cache, // This is now a collection of blocks
    const int* block_table,
    const int block_size,
    ...) {

    // Calculate which logical block we are in
    int logical_block_idx = threadIdx.x / block_size;

    // Map logical to physical via the block table
    int physical_block_idx = block_table[batch_id * max_blocks + logical_block_idx];

    // Fetch from the specific physical block
    float k = k_cache[physical_block_idx * block_size + ...];

    // ... Perform attention math ...
}
```

---

## Infrastructure Scale: Managing 100s of GPUs

When you scale this to a cluster (using tools like vLLM, TensorRT-LLM, or TGI), the complexity shifts to the **Scheduler**.

In a multi-tenant setup, you have to decide:

- **Preemption Policy:** What happens if the GPU actually runs out of physical blocks? Do you pause a request and swap its KV-cache to CPU RAM (high latency)? Or do you "recompute" it later?
- **Continuous Batching:** Unlike old-school batching where you wait for all requests in a batch to finish, continuous batching (also known as iteration-level scheduling) inserts new requests as soon as a single request finishes.

### The "Straggler" Problem

In a multi-tenant environment, one user might request a 10-token summary, while another requests a 2000-token creative writing piece. Without PagedAttention and Continuous Batching, the 10-token user is stuck waiting for the 2000-token user to finish. This is the definition of a tail latency nightmare.

By combining **PagedAttention** (memory efficiency) with **Continuous Batching** (scheduling efficiency), the scheduler can squeeze the 10-token request into the tiny "holes" of compute and memory left by the 2000-token request. The P99 for the short request drops from seconds to milliseconds.

---

## The Actual Substance Behind the Hype

There has been a lot of hype around "Infinite Context" and "1M token windows." While PagedAttention makes these long contexts _possible_ to manage without crashing, it doesn't solve the underlying $O(N^2)$ computational complexity of the attention mechanism itself.

However, the technical substance of PagedAttention is that it **decouples the maximum context window from the physical VRAM limits.**

Before PagedAttention, if you wanted to support a 32k context window, you had to reserve that memory upfront for every user. Now, you only use the memory the user _actually_ consumes. This allows infrastructure providers to offer 128k context windows to users without having to buy 8x more GPUs just to handle the "worst-case" memory allocation.

---

## Deep-Dive Curiosity: The Performance Trade-off

Is PagedAttention a free lunch? Not entirely.

There is a slight overhead in managing the block table and the kernel's non-contiguous memory access. In extremely low-concurrency scenarios (batch size = 1), a perfectly optimized contiguous kernel might be 1-2% faster.

But in **production scale**, where batch sizes are high and memory is the constraint, PagedAttention is overwhelmingly superior. It’s the difference between a system that serves 10 users with 200ms latency and a system that serves 100 users with 250ms latency. For any engineering team looking at the bottom line (cost per 1k tokens), the trade-off is an easy choice.

## The Future: Speculative Decoding and Beyond

Reducing P99 latency is a moving target. The next frontier involves combining PagedAttention with **Speculative Decoding**.

In speculative decoding, a smaller "draft" model predicts multiple tokens at once, and the larger "target" model verifies them in a single forward pass. This creates even more complex memory patterns, as the KV-cache must be able to "roll back" if the draft model is wrong. PagedAttention’s block-based architecture is the perfect foundation for this, allowing the system to simply discard "speculative blocks" without re-shuffling the entire memory space.

---

## Summing it Up: The Engineering Takeaway

If you are seeing erratic tail latencies in your LLM services, the culprit is likely not your model’s compute time, but your **memory management strategy.**

1.  **Stop using static allocation.** If your framework doesn't support paging, you are leaving 50% of your hardware performance on the table.
2.  **Implement Prefix Caching.** For multi-tenant apps with shared prompts, this is the single biggest "quick win" for reducing TTFT.
3.  **Monitor your Block Table utilization.** Just like you monitor CPU/RAM, you should be monitoring your "Physical Block Pool" saturation to know when it’s time to scale your GPU cluster.

The move from contiguous memory to paged memory was a turning point for general-purpose computing in the 70s. We are seeing that same evolution play out in the GPU space today. PagedAttention isn't just a clever trick—it’s the fundamental architecture that makes LLMs economically viable for the masses.

By understanding the interplay between the KV-cache, VRAM fragmentation, and block-level scheduling, you can move your P99s from "unreliable" to "gold standard," ensuring that your users get their tokens exactly when they need them—no matter how many other tenants are sharing the silicon.
