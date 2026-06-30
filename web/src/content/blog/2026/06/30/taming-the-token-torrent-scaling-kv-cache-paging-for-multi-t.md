---
title: "Taming the Token Torrent: Scaling KV-Cache Paging for Multi-Tenant LLM Inference at TerToken Scales"
shortTitle: "Scaling KV-Cache Paging for TerToken Multi-Tenant LLM Inference"
date: 2026-06-30
image: "/images/2026/06/30/taming-the-token-torrent-scaling-kv-cache-paging-for-multi-t.jpg"
---

The generative AI revolution has shifted from "Can we build it?" to "Can we serve it at scale without going bankrupt?"

If you are running a single inference instance for a handful of users, the standard libraries work fine. But when you are operating at the **TerToken scale**—processing trillions of tokens across thousands of concurrent users and hundreds of distinct models—the game changes entirely. You aren't just managing compute; you are managing a massive, high-speed memory choreography.

At this level, the primary bottleneck isn't TFLOPS; it's **VRAM utilization and memory bandwidth.** Specifically, the management of the **Key-Value (KV) Cache**.

In this deep dive, we’re going to explore how we’ve evolved KV-cache architecture from naive contiguous buffers to sophisticated, multi-tenant paging mechanisms that allow us to squeeze every last drop of performance out of H100 and A100 clusters. We’ll look at the "fragmentation tax," the mechanics of paged attention, and how to architect a system that handles prefix sharing across thousands of tenants without breaking a sweat.

---

## The KV-Cache Tax: Why Memory is the New Gold

To understand why paging is necessary, we have to look at how Transformers work. During the "prefill" phase, the model processes the entire input prompt. During the "decoding" phase, it generates tokens one by one. To avoid recomputing the hidden states for every previous token at every step, we store the **Keys** and **Values** of the attention layers in memory.

This is the **KV-Cache**.

The size of this cache is not trivial. For a Llama-3 70B model using FP16 precision:

- **Formula:** $2 \times \text{layers} \times \text{heads} \times \text{head\_dim} \times \text{precision\_bytes}$
- For one token in Llama-3 70B, that’s roughly **1.28 MB per token**.
- With a context window of 128k tokens, a single request could require **160 GB of VRAM** just for the KV-cache—far exceeding the 80GB capacity of a single H100.

When you multiply this by a multi-tenant environment where you are serving 500 different customers simultaneously, you aren't just looking at a memory problem; you’re looking at a **resource orchestration crisis.**

---

## The Fragmentation Crisis: The Silent Throughput Killer

In early LLM serving implementations, memory for the KV-cache was allocated statically and contiguously. If a user requested a 2048-token limit, the system would pre-allocate space for 2048 tokens.

This led to two catastrophic inefficiencies:

1.  **Internal Fragmentation:** A user might only generate 10 tokens, but the system has reserved space for 2048. That reserved space is "dead" and cannot be used by other tenants.
2.  **External Fragmentation:** Even if there is enough total free memory, it might be scattered in small chunks. Because the system expects contiguous blocks, it can't fit a new, large request into those gaps.

In our production telemetry at TerToken scales, we observed that static allocation resulted in **60-80% VRAM waste**. In an industry where H100s are rented by the hour for significant sums, that waste represents millions of dollars in lost throughput.

---

## The Evolution to PagedAttention

The breakthrough came with the concept of **PagedAttention**, popularized by the vLLM project. It draws direct inspiration from **Virtual Memory** in operating systems. Instead of treating the KV-cache as one long string, we break it into fixed-size **blocks**.

### How Paging Works in the LLM Context

Imagine a block size of 16 tokens. When a prompt comes in, the system doesn't allocate the full context window. It allocates only the number of blocks needed for the current tokens. As the model generates more tokens, the "Block Manager" fetches a new physical block from a free pool and maps it to the logical sequence.

This architecture allows:

- **Non-contiguous storage:** Blocks can be scattered anywhere in VRAM.
- **Dynamic growth:** We only allocate memory as it is needed.
- **Zero internal fragmentation:** (Except for the very last block in a sequence).

### The "Block Table" Logic

The core of this system is the **Block Table**. Every request (or "sequence group") maintains a mapping between its logical token indices and physical block addresses on the GPU.

```python
# Simplified Conceptual Block Manager Mapping
logical_blocks = [0, 1, 2]
physical_blocks = [1024, 512, 2048] # These are actual addresses in VRAM

def get_physical_address(logical_index, block_size):
    block_idx = logical_index // block_size
    offset = logical_index % block_size
    return physical_blocks[block_idx] + offset
```

During the attention kernel execution, the GPU doesn't look for a single contiguous pointer. Instead, it iterates through the block table, fetching tokens from disparate memory locations and performing the dot-product attention on the fly.

---

## Multi-Tenancy at TerToken Scale: Shared Prefix Hashing

Paging solved the fragmentation problem, but it didn't solve the **Redundancy Problem**. In a multi-tenant environment, thousands of users often send prompts that start with the same instructions.

- "You are a helpful coding assistant..."
- "Summarize the following document..."
- Large system prompts with RAG (Retrieval-Augmented Generation) context.

If 100 users are using the same 2,000-token system prompt, why store it 100 times? At TerToken scale, storing redundant KV-caches is a cardinal sin.

### Implementing Radix Tree Prefix Caching

To optimize multi-tenancy, we implemented a **Radix Tree** (or Prefix Tree) to manage the KV-blocks.

1.  **Hashing:** Each block of tokens is hashed (SHA-256 or a faster MurmurHash).
2.  **Lookup:** Before allocating a new block, the system checks if a block with that specific hash (and its preceding sequence) already exists in the global cache.
3.  **Reference Counting:** If it exists, we don't allocate new memory. We simply point the new user's Block Table to the existing physical block and increment a reference count.

This is essentially **Copy-on-Write (CoW)** for LLM tokens. If one user starts generating unique tokens, they get their own new blocks, while the shared "system prompt" blocks remain common.

**The result?** We’ve seen VRAM requirements for RAG-heavy workloads drop by **up to 90%**, allowing us to increase request density per GPU by nearly an order of magnitude.

---

## The "Cold Start" and Offloading: Hierarchical Paging

Even with prefix sharing, VRAM is a finite, precious resource. What happens when the active KV-cache exceeds the total VRAM of the cluster?

In a standard OS, we swap to disk. In a TerToken LLM infrastructure, we use **Hierarchical Paging**.

We categorize KV-cache into three tiers:

1.  **L1 (GPU VRAM):** High bandwidth (TB/s), low capacity. For currently active sequences.
2.  **L2 (Host RAM):** Medium bandwidth (GB/s via PCIe Gen5), high capacity. For "warm" sequences that are paused or waiting for user input.
3.  **L3 (NVMe SSD):** Low bandwidth, massive capacity. For "cold" sessions that might resume later.

### The Swapping Mechanism

When the GPU reaches a memory pressure threshold (e.g., 95% utilization), the **Policy Engine** must decide which blocks to evict. We use a modified **Least Recently Used (LRU)** algorithm, but with a twist: we prioritize keeping "shared prefix" blocks in L1 because they have the highest ROI for future requests.

When a sequence is swapped to Host RAM, the Block Table remains, but its physical addresses now point to a "Swapped" state. When that user sends a new message, we perform an **Async CUDA Memcpy** to bring the blocks back to VRAM while the model is processing the first few layers of the new prompt. This overlap hides the latency of the swap.

---

## Engineering for Throughput: The CUDA Kernel Challenge

You might think, "If we are jumping around memory to find blocks, won't that kill the GPU's memory coalescing?"

You’re absolutely right. Writing a standard attention kernel for paged memory is a recipe for a performance nightmare. To make this work at TerToken scales, we had to optimize the **Triton or CUDA kernels** specifically for block-aware loading.

### Custom PagedAttention Kernels

The secret sauce lies in how we handle the "Query" and "Key/Value" interaction. By ensuring that our block size (e.g., 16 or 32 tokens) aligns with the GPU's **warp size (32)** and memory transaction boundaries, we can maintain high throughput.

```cpp
// Pseudocode for a PagedAttention Kernel logic
__global__ void paged_attention_kernel(
    float* out,
    const float* query,
    const int** block_table,
    const float* kv_cache_pool,
    int block_size) {

    int tid = threadIdx.x;
    int head_idx = blockIdx.y;
    int seq_idx = blockIdx.x;

    // Fetch the physical block pointer from the table
    int logical_block_idx = tid / block_size;
    int physical_block_number = block_table[seq_idx][logical_block_idx];

    // Load K and V from the specific block in the pool
    // Perform scaled dot-product attention...
    // Store back to global memory
}
```

By leveraging **Shared Memory (SRAM)** on the GPU, we can load an entire block into the fast-access area of the SM (Streaming Multiprocessor), perform the attention math, and then move to the next block. This minimizes the "pointer chasing" penalty.

---

## The Hype vs. The Reality: Is "Infinite Context" Real?

Recently, there has been massive hype around models with "1 Million+" or even "Infinite" context windows (like Gemini 1.5 Pro). The marketing suggests magic, but the engineering reality is **aggressive paging and linear scanning.**

The hype says: "The model remembers everything."
The reality says: "The engineering team built a massive, distributed KV-paging system that can swap blocks in and out of the GPU faster than the model can finish its prefill."

At TerToken scales, "infinite context" is actually a **distributed systems problem.** We aren't just paging within one GPU anymore; we are paging across a cluster. If a user’s KV-cache is 500GB, it is spread across a "KV-Cluster" and retrieved via **RDMA (Remote Direct Memory Access)** over InfiniBand or RoCE v2.

---

## Operational Excellence: Monitoring the "Fragmentation Tax"

You can't optimize what you can't measure. When running at this scale, we monitor several key metrics that define our infrastructure's health:

- **KV-Cache Utilization:** (Actual tokens stored) / (Total VRAM capacity allocated for KV). If this is below 90%, our paging isn't aggressive enough.
- **Prefix Hit Rate:** How often a new request uses existing blocks. This is our primary lever for lowering COGS (Cost of Goods Sold).
- **Swap Latency:** The time it takes to move blocks from Host RAM to GPU. If this exceeds the "Time to First Token" (TTFT) budget, the user perceives a lag.
- **Block Orchestration Overhead:** The CPU time spent managing the Radix Tree and Block Tables. At 10,000+ requests per second, the "Manager" can actually become a bottleneck.

### The Metadata Bottleneck

A curious engineering challenge we faced was the **CPU-side metadata bottleneck.** When you have millions of blocks, the Block Table itself starts to consume significant CPU memory and management cycles.

We solved this by moving the Block Table to the GPU as a **Tensor of Pointers.** The CPU only sends a "high-level" command (e.g., "Process Request X"), and the GPU looks up its own block addresses in a pre-allocated metadata buffer. This "zero-copy" control plane is essential for maintaining sub-10ms latencies.

---

## Summary of the Architecture

To serve LLMs at TerToken scales, we’ve moved from simple inference to a complex memory-centric architecture:

1.  **Block-Based Paging:** Eliminate fragmentation by treating VRAM like OS virtual memory.
2.  **Radix-Tree Caching:** Share common prefixes across tenants to reduce redundancy.
3.  **Hierarchical Offloading:** Use Host RAM and NVMe as an L2/L3 cache for KV-blocks.
4.  **Hardware-Aware Kernels:** Optimize CUDA code to handle non-contiguous memory without losing coalesced access speeds.
5.  **Distributed KV-Fabric:** Use RDMA to share cache blocks across a multi-node cluster.

## Looking Ahead: The Future of KV-Management

We are currently exploring **KV-Cache Compression** (quantizing KV-blocks from FP16 to 4-bit or even 2-bit) and **Learned Eviction Policies** (using a small neural network to predict which user will message next and pre-fetching their blocks to VRAM).

The goal of TerToken scaling isn't just to make LLMs faster; it's to make them **economically ubiquitous.** By perfecting the paging mechanism, we turn a "scarce resource" (GPU memory) into a highly efficient, elastic utility.

In the world of trillion-token workloads, the winner isn't the one with the biggest model—it's the one with the smartest memory manager.

**Are you ready to stop wasting VRAM and start scaling?** The transition from static buffers to dynamic, multi-tenant paging is the single most important architectural move you can make in the era of Generative AI.
