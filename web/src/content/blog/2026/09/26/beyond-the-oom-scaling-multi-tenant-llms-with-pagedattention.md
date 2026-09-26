---
title: "Beyond the OOM: Scaling Multi-Tenant LLMs with PagedAttention and FlashInfer"
shortTitle: "Scaling Multi-Tenant LLMs with PagedAttention and FlashInfer"
date: 2026-09-26
image: "/images/2026/09/26/beyond-the-oom-scaling-multi-tenant-llms-with-pagedattention.jpg"
---

In the high-stakes world of Large Language Model (LLM) production, there is a recurring nightmare that keeps infrastructure engineers awake at 3:00 AM: the **Out-of-Memory (OOM) error.**

You’ve optimized your weights, you’ve quantized your model to 4-bit, and you’ve deployed on a cluster of H100s that costs more than a beachfront villa. Yet, as soon as your multi-tenant traffic spikes—hundreds of users hitting the API with varying prompt lengths—your throughput tanks, and the GPU memory enters a state of chaotic fragmentation. You're leaving 40% of your VRAM on the table, not because you’re using it, but because you _can’t_ use it.

This is the **KV-Cache Fragmentation Problem.** And if you’re serious about building a cost-effective, low-latency LLM platform, solving it isn't just an "optimization"—it's the entire game.

Today, we’re diving deep into the architecture of modern inference engines. We’re going to explore how the marriage of **PagedAttention** (the breakthrough from the vLLM team) and **FlashInfer** (the new gold standard in high-performance kernels) is redefining the limits of tokens-per-second per dollar.

---

## The Economics of the KV-Cache

To understand the solution, we have to respect the monster we’re fighting. When an LLM generates text, it doesn't just process the entire sequence at once. It generates one token at a time. To avoid recomputing the hidden states of every previous token in the sequence (which would be an $O(n^2)$ computational disaster), the model stores the **Key (K)** and **Value (V)** tensors in a buffer called the **KV-Cache**.

Here is the technical reality: in a production environment, **the KV-Cache is your primary bottleneck.**

For a Llama-3 70B model running in FP16, the KV-cache requires:
$$2 \times \text{layers} \times \text{num\_heads} \times \text{head\_dim} \times \text{precision\_bytes}$$
per token. For a single sequence of 4096 tokens, you’re looking at several gigabytes of VRAM. Now, multiply that by a batch size of 128 concurrent users. Your 80GB H100 is suddenly looking very small.

### The "Fragmentation" Tax

In traditional inference setups (like early versions of Hugging Face Transformers or TGI), KV-caches were allocated as **contiguous blocks** of memory. If a user requested a max sequence length of 2048, the engine would pre-allocate space for 2048 tokens.

But what if the user only generates 50 tokens? The remaining 1998 slots are reserved but empty. This is **Internal Fragmentation.**

Furthermore, as sequences of different lengths start and finish, the GPU memory becomes a Swiss cheese of holes. You might have 10GB of total free memory, but if it's not in one contiguous block, you can't fit a new 8GB request. This is **External Fragmentation.**

Together, these forces often result in **60% to 80% memory waste.** In a multi-tenant world where every gigabyte of VRAM translates to margin, this is unacceptable.

---

## Enter PagedAttention: The Virtual Memory Revolution

The breakthrough came from the realization that we’ve solved this problem before—in the 1960s. Operating systems solve memory fragmentation using **Virtual Memory and Paging.**

**PagedAttention**, pioneered by the vLLM team at UC Berkeley, treats the GPU's KV-cache like a pool of "pages" (or blocks). Instead of allocating a single contiguous chunk of memory for a request, PagedAttention breaks the KV-cache into small, fixed-size blocks.

### The Architecture of the Block Manager

In a PagedAttention-enabled system, the physical memory is divided into a **Block Pool**. When a request comes in:

1. The engine doesn't allocate the full sequence length upfront.
2. It allocates one block (e.g., 16 tokens).
3. As the model generates more tokens and fills the block, the **Logical GPU Memory Manager** maps a new logical block to a free physical block from the pool.
4. These physical blocks do _not_ need to be contiguous.

This is a paradigm shift. Because the blocks can be scattered anywhere in VRAM, external fragmentation is virtually eliminated. Internal fragmentation only occurs in the very last block of a sequence, reducing waste to well under 4%.

```python
# Conceptual logic of a PagedAttention Block Manager
class BlockManager:
    def __init__(self, num_blocks, block_size):
        self.free_blocks = list(range(num_blocks))
        self.mapping = {} # Request_ID -> List of Physical Block Indices

    def allocate(self, request_id, num_tokens):
        needed = ceil(num_tokens / block_size)
        allocated = [self.free_blocks.pop() for _ in range(needed)]
        self.mapping[request_id] = allocated
        return allocated
```

But there’s a catch. Standard attention kernels (like those in vanilla PyTorch or even early FlashAttention) expect keys and values to be contiguous in memory. If your KV-cache is fragmented into blocks, how do you perform the attention calculation without the massive overhead of copying those blocks back into a contiguous buffer?

---

## FlashInfer: The Kernel-Level Speed Demon

This is where the "hype" meets the "substance." While PagedAttention solved the _memory allocation_ problem, it introduced a _computational_ challenge. You need a way to perform attention where the "Keys" and "Values" are fetched from non-contiguous memory addresses on the fly.

Initially, engines used custom CUDA kernels for PagedAttention, but as models moved toward **Grouped Query Attention (GQA)** and increasingly long context windows, these kernels hit a performance ceiling.

**FlashInfer** emerged as the answer. Developed as a high-performance library for LLM serving, FlashInfer provides highly optimized CUDA kernels specifically designed for the "Page" layout.

### Why FlashInfer is Different

FlashInfer doesn't just "support" pages; it optimizes for the hardware characteristics of the NVIDIA Hopper and Ampere architectures.

1.  **Prefill vs. Decode Optimization:** In LLM serving, there are two distinct phases. **Prefill** (processing the input prompt) is compute-bound. **Decode** (generating tokens one-by-one) is memory-bandwidth bound. FlashInfer provides distinct, hyper-optimized kernels for both, ensuring that the PagedAttention overhead is near zero.
2.  **Compressed KV-Cache Support:** As we push the limits, we start looking at FP8 or even 4-bit KV-caches. FlashInfer integrates dequantization directly into the attention kernel, so the data stays compressed until it hits the GPU registers.
3.  **Cross-Request KV-Sharing:** This is the "Holy Grail" for multi-tenancy. Imagine 100 users all asking questions about the same 50-page PDF. With FlashInfer and PagedAttention, you can store the KV-cache for that PDF _once_ and have all 100 requests point to those same physical blocks.

---

## Integration Deep Dive: How the Pieces Fit

When you integrate FlashInfer into a PagedAttention-based stack (like vLLM or a custom Rust-based inference engine), the data flow looks like a masterclass in systems engineering.

### 1. The Request Orchestrator

When a multi-tenant API receives a batch of requests, the orchestrator first checks the **Prefix Cache**. If Request A and Request B share the same system prompt ("You are a helpful assistant..."), the orchestrator assigns them the same physical memory blocks for that prefix.

### 2. Dynamic Scheduling (Continuous Batching)

Unlike traditional batching, where you wait for all requests in a batch to finish, we use **Continuous Batching**. As soon as Request A finishes, its physical blocks are returned to the free pool, and Request C can immediately start, even while Request B is still decoding.

### 3. The FlashInfer Kernel Execution

During the forward pass of the Transformer layer:

- The **Query (Q)** tensor is computed as usual.
- Instead of looking for a contiguous **KV** tensor, the model passes a **Block Table** (a pointer map) to the FlashInfer kernel.
- FlashInfer uses **asynchronous memory copies** (using `cp.async` on Hopper) to pull the required K and V blocks into Shared Memory while the GPU is still calculating the Q\*K scores.
- The kernel handles the GQA logic, where multiple Query heads share a single Key/Value head, further reducing the memory bandwidth required.

### Code Insight: The FlashInfer API

Using FlashInfer in a C++ backend looks something like this:

```cpp
// Setting up the Paged KV-Cache Wrapper
flashinfer::BatchDecodeHandler<uint16_t, uint16_t> handler;

// Define the mapping from batch index to page indices
handler.BeginForward(
    workspace_buffer,
    batch_size,
    num_qo_heads,
    num_kv_heads,
    head_dim,
    page_size
);

// The actual attention call - no contiguous KV-cache required!
flashinfer::BatchDecodeWithPagedKVCache(
    &handler,
    q_ptr,           // Current Query token
    paged_kv_ptr,    // Pointer to the block pool
    block_table_ptr, // The "map" from PagedAttention
    ...
);
```

---

## The Performance Payoff: By the Numbers

What does this actually get you in a production environment? We’re not talking about 5% or 10% improvements. We’re talking about **orders of magnitude.**

### 1. Throughput (Tokens per Second)

In a standard contiguous memory setup, once your VRAM is fragmented, the engine can no longer accept new requests, leading to "Inference Starvation." By switching to PagedAttention + FlashInfer, we've seen throughput increases of **2x to 4x** because we can fit significantly more concurrent requests into the same 80GB of VRAM.

### 2. Time to First Token (TTFT)

FlashInfer's prefill kernels are designed to saturate the GPU's Compute Units (CUs) more effectively. For long prompts (multi-thousand token contexts), the TTFT can drop by **30-50%** compared to unoptimized kernels.

### 3. Tail Latency (P99)

In multi-tenant systems, the biggest killer is the "noisy neighbor"—one user with a massive request slowing down everyone else. Because PagedAttention allows for fine-grained memory management and FlashInfer supports efficient preemption, the P99 latency becomes much more predictable.

---

## Engineering Curiosities: The "Ghost" of Memory Latency

One of the most fascinating aspects of this optimization is the battle against **TLB (Translation Lookaside Buffer) pressure.**

When you use PagedAttention, you are essentially creating a software-level memory management unit (MMU). Every time the GPU kernel wants to access a KV-pair, it has to look up the physical address in the block table. If your block size is too small (e.g., 1 or 2 tokens), your block table becomes massive.

This leads to a "TLB miss" at the software level. The GPU spends more time looking up _where_ the data is than actually _reading_ the data.

**The Sweet Spot:** Through extensive benchmarking, the community has found that a block size of **16 or 32 tokens** is the "Goldilocks zone." It’s large enough to keep the block table small and ensure memory coalescing, but small enough that internal fragmentation remains negligible.

---

## The Road Ahead: Speculative Decoding and Beyond

While PagedAttention and FlashInfer have solved the fragmentation crisis, the frontier is moving. We are now seeing the integration of **Speculative Decoding** into this stack.

In speculative decoding, a smaller "draft" model predicts the next 5-10 tokens, and the large model verifies them in a single parallel pass. This requires the KV-cache to be even more dynamic, as "rejected" tokens must be instantly pruned from the cache. The flexibility of the PagedAttention block manager is what makes this possible without massive memory reshuffling.

Furthermore, we are seeing the rise of **Hierarchical KV-Caching**, where inactive blocks are swapped out from VRAM to System RAM (CPU) or even NVMe SSDs, and swapped back in just-in-time. This essentially creates "infinite" context windows, limited only by the bandwidth of the PCIe bus.

---

## Final Thoughts: The New Standard

If you are building LLM infrastructure today, the days of simple, contiguous memory buffers are over. The complexity of multi-tenant demands and the sheer scale of modern models require a sophisticated memory orchestration layer.

By integrating **PagedAttention** to handle the logical mapping and **FlashInfer** to handle the high-speed kernel execution, you are effectively building a modern operating system for your GPU. This stack allows you to maximize your hardware utilization, minimize your costs, and provide a snappy, responsive experience for your users.

The "Memory Wall" is still there, but with these tools, we've finally learned how to climb it.

---

**Are you implementing PagedAttention in your stack?** We’d love to hear about your experience with block sizes and kernel performance. The transition from "working code" to "optimized infrastructure" is where the real engineering happens. Keep pushing the boundaries.
