---
title: "Scaling the Infinite Memory: Dynamic KV Cache Compression and Tiered PagedAttention for the 100k Token Era"
shortTitle: "Scaling Infinite Memory: Dynamic KV Cache Compression and Tiered PagedAttention"
date: 2026-08-29
image: "/images/2026/08/29/scaling-the-infinite-memory-dynamic-kv-cache-compression-and.svg"
---

We’ve all been there. You’re deploying a state-of-the-art Llama 3 or Mistral Large model, and the product team drops the "requirement" bombshell: **"We need it to handle 100k+ context windows for document analysis."**

You look at your H100 cluster. You look at the VRAM consumption. You do the back-of-the-envelope math. And then you realize that for a single request with a 128k context window, the Key-Value (KV) cache alone—just the memory required to store the "memory" of the conversation—can balloon to over 30GB per user.

In a multi-tenant environment, that isn't just expensive; it’s an architectural suicide mission.

The "Context Window Arms Race" has shifted the bottleneck of LLM inference from compute-bound (TFLOPS) to memory-bound (GB/s and capacity). To survive in a world where "long context" is the baseline, we have to rethink how we store, access, and compress the hidden states of our models.

Today, we’re going under the hood of the next generation of inference infrastructure. We’re talking about **Dynamic KV Cache Compression** and **Tiered PagedAttention**—the two technologies making "infinite" context windows commercially viable in distributed clusters.

---

## The Context Hype vs. The VRAM Reality

Over the last 18 months, context windows have exploded. We went from the "puny" 4k limits of GPT-3 to the 128k of GPT-4 Turbo, 200k of Claude 3, and the staggering 1M+ tokens of Gemini 1.5.

The hype is real because the utility is undeniable. Long context allows for "needle-in-a-haystack" retrieval, entire codebase reasoning, and complex document synthesis without the lossy nature of traditional RAG (Retrieval-Augmented Generation).

**But here is the technical substance behind the hype:** The Transformer’s greatest strength—its global attention mechanism—is also its greatest scaling weakness. In a standard Transformer, every new token generated must attend to every previous token. This means we store the Key and Value vectors for every single token in every layer of the model.

For a 70B parameter model:

- **Precision:** FP16 (2 bytes per element).
- **Layers:** 80.
- **Heads:** 64.
- **Head Dim:** 128.
- **Formula:** $2 \times \text{layers} \times \text{num\_heads} \times \text{head\_dim} \times \text{context\_length}$

At 100k tokens, you’re looking at ~160GB of KV cache. That’s two H100 GPUs fully saturated just to hold the _memory_ of one request, with zero room left for the model weights themselves. If we want to serve thousands of users, we need a smarter play.

---

## The Foundation: Why PagedAttention Wasn't Enough

Before we get to the "Tiered" part, we have to acknowledge the giant whose shoulders we’re standing on: **vLLM’s PagedAttention**.

In early inference servers, KV caches were stored in contiguous memory. This led to massive **external fragmentation**. If a request grew, you’d have to pre-allocate a massive chunk of VRAM, most of which sat empty, or risk a costly re-allocation.

PagedAttention solved this by borrowing an idea from operating systems: **Virtual Memory.** It breaks the KV cache into small, non-contiguous blocks (pages). This allows us to:

1.  **Eliminate internal fragmentation:** We only allocate blocks when tokens are actually generated.
2.  **Enable complex sampling:** We can share KV blocks between different parallel outputs (like in Beam Search).

But as we push toward 100k and 1M tokens, even PagedAttention hits a wall. Why? Because it assumes all "pages" must live in the GPU’s High Bandwidth Memory (HBM). When you run out of HBM, you start dropping requests.

Enter **Tiered PagedAttention.**

---

## Tiered PagedAttention: Orchestrating the Memory Hierarchy

In a distributed inference cluster, we don't just have GPUs. We have massive amounts of System RAM (DDR5) and lightning-fast NVMe storage. Tiered PagedAttention treats the GPU's HBM as a L1 cache, the CPU's RAM as L2, and NVMe as L3.

### The Swap-In/Swap-Out Logic

The core idea is simple: **Not all tokens in a 100k context are equally important at all times.**

When a model is decoding token #100,001, it may not need the KV blocks from token #5,000 with high urgency. Tiered PagedAttention implements an asynchronous swapping mechanism. While the GPU is busy computing the attention for the current block, the orchestrator is proactively moving "cold" blocks (older tokens) from HBM to CPU RAM.

```python
# Conceptual logic for a Tiered Block Manager
class TieredBlockManager:
    def __init__(self, hbm_limit, cpu_limit):
        self.gpu_blocks = {} # Fast access
        self.cpu_blocks = {} # "Warm" storage
        self.lru_evictor = LRUPolicy()

    def allocate_or_swap(self, request_id, block_id):
        if self.gpu_full():
            # Evict Least Recently Used block to CPU RAM
            victim_block = self.lru_evictor.get_victim()
            self.move_to_cpu(victim_block)

        return self.allocate_in_gpu(request_id, block_id)

    async def prefetch_to_gpu(self, block_ids):
        # Asynchronously pull from CPU to GPU before the decode step
        await self.transfer_engine.move_many(source=self.cpu_blocks, dest=self.gpu_blocks)
```

### The Engineering Hurdle: Latency vs. Throughput

The challenge here is PCIe bandwidth. Moving blocks between CPU and GPU over PCIe Gen5 is fast, but it’s not HBM3 fast. To make this invisible to the user, we use **Double Buffering**. While the GPU is processing "Block N," we are already streaming "Block N+1" from CPU RAM.

This orchestration requires a sophisticated **Global Scheduler** that knows the state of every GPU in the cluster and the network topology (RDMA/RoCE) connecting them.

---

## Dynamic KV Cache Compression: Pruning the Noise

Even with tiered memory, storing 1M tokens is expensive. But what if we didn't have to store them all?

Recent research (and our production implementations) shows that LLM attention maps are incredibly sparse. In a 100k window, the model often focuses on "Attention Sinks" (initial tokens), the most recent tokens, and a handful of "Heavy Hitter" tokens in between.

**Dynamic KV Cache Compression** isn't just static quantization; it's an adaptive strategy that happens _during inference_.

### 1. Heavy Hitter Oracle (H2O)

Instead of keeping all $K$ and $V$ vectors, we maintain a "budget" for each request. We track the cumulative attention scores of every token. If a token consistently receives low attention, we prune it from the cache entirely. This can reduce the KV cache size by **5x to 10x** with less than a 1% drop in perplexity.

### 2. Adaptive Quantization (FP8 to INT4)

Not all layers require the same precision. We’ve found that the "middle" layers of deep models are more resilient to noise than the early and late layers.

- **Static Layers:** Keep in FP16.
- **Compressed Layers:** Dynamically quantize KV blocks to **INT4** or **FP8** based on the distribution of values (activation outliers) in that specific sequence.

### 3. GQA and MQA (The Structural Shortcuts)

Modern architectures like Llama 3 use **Grouped-Query Attention (GQA)**. Instead of every Query head having its own Key and Value head, multiple Query heads share a single KV head. This reduces the cache footprint by a factor of 8x out of the box. Combined with dynamic pruning, we are seeing 100k contexts that occupy the space previously required for 8k contexts.

---

## Infrastructure at Scale: Distributed KV Orchestration

In a distributed cluster, the KV cache is no longer local to a single GPU. If a request is preempted and restarted on a different node (common in spot-instance clusters), we don't want to re-compute the entire 100k "prefill" phase. That's a massive waste of TFLOPS.

### The Global KV Store (Disaggregated Cache)

We are moving toward an architecture where the KV cache is **disaggregated**. Imagine a high-speed "Cache Layer" (built on top of something like Redis or a custom RDMA-based store) that sits alongside the "Compute Layer."

- **Prefill Phase:** GPU Node A processes the 100k token prompt. It streams the resulting KV blocks to the Global KV Store.
- **Decode Phase:** GPU Node B (which might have more free capacity) takes over the generation. It pulls only the necessary KV blocks from the Global Store.

This allows for **Elastic Inference**. We can scale the number of GPUs performing "Prefills" independently of the GPUs performing "Decodes." Since Prefills are compute-bound and Decodes are memory-bound, this separation is the holy grail of inference efficiency.

---

## The Technical "Gotchas": What They Don't Tell You

When you’re implementing this at the 100k+ scale, you run into "fun" engineering curiosities that don't show up in research papers:

1.  **The "First Token" Latency Peak:** Processing 100k tokens in the prefill phase takes significant time. If you don't use **Chunked Prefill**, your Time To First Token (TTFT) will be measured in seconds, not milliseconds. You have to interleave the long prefill of one user with the short decodes of another to keep the pipeline full.
2.  **The Numerical Stability of Long Context:** As the sequence grows, the attention scores ($QK^T$) can grow, leading to softmax saturation. Dynamic compression needs to be "outlier-aware" to ensure that the most significant vectors (the ones that prevent the model from hallucinating) are never pruned or overly quantized.
3.  **The Metadata Overhead:** Managing pointers to millions of KV pages across a cluster is itself a memory and CPU bottleneck. We’ve had to rewrite our block managers in Rust with custom lock-free data structures to handle the management overhead of a 1M token context window.

---

## Looking Ahead: The End of the "Memory Wall"?

The transition to **Dynamic KV Cache Compression** and **Tiered PagedAttention** represents a fundamental shift in AI infrastructure. We are moving away from the "Brute Force VRAM" era into the "Intelligent Memory Management" era.

By treating the KV cache as a dynamic, tierable, and compressible resource, we’re doing more than just saving money on H100s. We’re enabling a new class of applications—AI researchers that can read every paper on PubMed, legal assistants that can parse thousands of pages of discovery, and coding agents that understand the entire history of a repository.

The memory wall hasn't been torn down yet, but we've certainly found the way over it.

If you’re building in this space, remember: **The best VRAM is the VRAM you don't use.**

---

### Key Takeaways for the Engineering Lead

- **PagedAttention is the baseline:** If your stack doesn't support it, start there.
- **Tiering is the future:** Leverage CPU RAM for "cold" context; don't let HBM be your only ceiling.
- **Pruning works:** LLMs are redundant. Use Heavy Hitter (H2O) policies to keep your KV cache lean.
- **Disaggregate your cache:** In a distributed world, the KV cache should be a first-class citizen, independent of the GPU that created it.

**Are you ready for the 1M token era? Because the infrastructure is already being built.**
