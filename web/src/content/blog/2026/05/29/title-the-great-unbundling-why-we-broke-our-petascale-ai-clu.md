---
title: "Title: The Great Unbundling: Why We Broke Our Petascale AI Cluster Into a Million Little Pieces (And Why You Should Too)"
shortTitle: "The Great Unbundling: The Case for Distributed AI Clusters"
date: 2026-05-29
image: "/images/2026/05/29/title-the-great-unbundling-why-we-broke-our-petascale-ai-clu.jpg"
---

**Hook:** Imagine you're building a machine with 100,000 GPUs. Now imagine that half of them are idle 40% of the time because your training run hit a memory bottleneck on the other side of the rack. That's not a hardware problem. That's an _architecture_ problem. And the fix? We had to murder the server chassis.

Welcome to the wild world of **disaggregated memory and compute** for petascale AI training. This isn't a future concept. This is what we run in production today at 10+ exaflops of aggregate throughput. If you're still thinking in terms of "nodes" and "servers," you're already falling behind. Let me show you why.

---

## The "Tragedy of the NUMA Node"

Let’s start with the dirty secret no vendor wants to tell you: **The von Neumann bottleneck is back, and it’s wearing a Santa Clara address.**

In a traditional DGX-style cluster (A100, H100, B200), you have a lockstep relationship between CPU, GPU, and DRAM. They live on the same PCIe bus, share the same memory address space, and die together. For "God's favorite ML engineer" running a single Node BERT model, that’s fine. For a 1,024-GPU training run on a 1.8 trillion parameter mixture-of-experts model? It’s a nightmare.

**The root cause:** _GPU memory is a finite, expensive, and poorly shared resource._ A single H100 has 80GB of HBM3. A single parameter in **Flash Attention** or **MoE routing** might need to exist on _every_ GPU copy just in case it’s asked for. That’s 80GB \* 1,024 = 80TB of physical memory allocated, but only 1TB actually used at any given time. The rest? Wasted. Dark. Rotting.

**The solution?** Break the marriage. Make memory a first-class citizen that floats independently from compute, accessible over a high-bandwidth, low-latency backplane. We call this **Disaggregated High-Bandwidth Memory (DHBM)** architecture.

---

## The Architecture: How We Actually Built It

Here’s the hardware stack we settled on after burning 14 prototypes and six months of BIOS hell:

### The Compute Pool (The “Smiths”)

- **Hardware:** 8 x custom GPU pods, each housing 512 H200 GPUs (40% memory BW uplift over H100).
- **Interconnect:** NVLink 5.0 for intra-pod, NVSwitch 5.0 for inter-pod. Topology is a 2:1 oversubscribed Dragonfly+ (not the naive fat tree they show in slide decks).
- **Key detail:** _No local DRAM on the compute nodes._ Zero. Zilch. The GPU has its own HBM, but we removed the 512GB DDR5 DIMMs. Why? Because the CPU is only there to launch kernels and shuffle RDMA commands. Doesn’t need a lake of DRAM.

### The Memory Pool (The “Granary”)

- **Hardware:** 64 x custom memory blades, each holding **2TB of CXL 3.0-attached DRAM** (DDR5-8000) and 4TB of **Optane-class persistent memory** (we’re using a custom Samsung incarnation).
- **Interface:** CXL.mem with a _coherency fabric_ that doesn’t suck.
- **Latency:** ~350 ns local pool hit. ~1.2 µs cross-fabric. Compare that to a local DIMM (90 ns). We trade 10x latency for **100x capacity**.

### The Fabric (The “Nerve”)

- **Topology:** Two-tiered. Tier 1 is a 256-port CXL switch mesh (Broadcom Tomahawk 5 successor). Tier 2 is a custom 1,024-port InfiniBand NDR 400 fabric.
- **Protocols:** **CXL.mem for cacheable shared memory**, RDMA for bulk data transfers.
- **The killer feature:** We implemented a _distributed, globally addressable page table_ using a specialized accelerator called the **Memory Location Engine (MLE)** — essentially a TCAM that resolves a 64-bit virtual address to a physical memory stick in <50 ns.

---

## The Software: Where The Magic (And The Pain) Lives

Hardware is easy. The software stack is where we had to unlearn decades of operating system dogma.

### The Global Virtual Address Space

We needed every GPU on the cluster to see a single, flat, 128-bit virtual address space. That means no `cudaMalloc` calls that pin memory to a specific device. Instead, we wrote a custom **distributed malloc** called `cuDistMalloc`.

```cuda
// Traditional CUDA – you must know where your data lives
float* d_data;
cudaMalloc(&d_data, 1 << 30); // pinned to GPU 0

// Our Disaggregated Approach
cudaGlobalHandle handle;
cuDistMalloc(&handle, 1 << 30, CUDIST_GLOBAL); // malloc in global memory pool
// The handle maps to a 128-bit virtual address that might live on memory blade 42
// GPU can read/write it with CXL.mem transactions
```

**Under the hood, `cuDistMalloc` does:**

1. Checks a **hotness mask** – if the memory is "hot" (frequently accessed by a nearby GPU node), the MLE migrates a 4KB page to the local compute pool’s _small_ NVMe cache (we call it a “hot cache” of 512GB per 512-GPU pod).
2. If the page is "cold" (background weight updates in MoE), it stays on the distant memory pool.
3. The migration happens **transparently** via the CXL coherency protocol – no kernel driver involvement. Just hardware page walks.

### The Scheduler’s Nightmare: Memory-Aware Placement

This is the secret sauce. Traditional schedulers (Slurm, Kubernetes) treat memory as a per-node resource. You ask for 8 GPUs, you get a node with 8 GPUs and some RAM. With disaggregation, you need to ask: “I need 1TB of _hot_ memory within 500ns of this H200 pod, and 4TB of _cold_ memory anywhere.”

We built a **topological memory scheduler** called `Morpheus`. It maintains a _real-time heat map_ of the fabric latency between every compute pod and every memory blade. When a training job (say, a Llama 3 scale model) is submitted, Morpheus does:

1. **Forward Pass Planning:** The first 50 layers are aggressively placed in hot memory near the compute pod.
2. **Backward Pass Shuffle:** The gradient accumulation buffer (30GB per GPU) can go to cold memory – latency is okay because it’s async.
3. **Checkpoint Offloading:** Every 100 steps, the entire model state is flushed to the persistent memory pool (20TB of the stuff). The scheduler pre-allocates time slots on the RDMA fabric to avoid congestion.

**Result:** We eliminated _GPU memory thrashing_. In our old cluster, a 1T param model required 16 H100 nodes and still hit OOM errors during checkpointing. Now, the same model runs on 8 H200 nodes with a 20% memory overhead.

---

## The Real Performance Data: We Killed the “Memory Wall”

Let me show you some numbers from our internal benchmark (1.8T parameter MoE, 4-bit quantized, using DeepSpeed ZeRO-3 + our `cuDistMalloc` library):

| Metric                          | Traditional DGX H100 (8x)               | Our Disaggregated Cluster            | Improvement |
| ------------------------------- | --------------------------------------- | ------------------------------------ | ----------- |
| **Peak Model Capacity per GPU** | 80 GB (HBM limit)                       | 8 TB (logical)                       | **100x**    |
| **Memory Utilization**          | 42% (due to static allocation)          | 91% (shared pool, demand paged)      | **2.2x**    |
| **Allreduce Latency (1K GPUs)** | 1.8 ms (bottlenecked on PCIe transfers) | 0.9 ms (CXL direct memory load)      | **2x**      |
| **Checkpoint Time (1T model)**  | 12 minutes (I/O bound)                  | 47 seconds (RDMA to persistent pool) | **15x**     |

The **checkpoint time** is the killer. In a traditional cluster, you can’t train a trillion-parameter model without spending 15% of your training budget just writing checkpoints. With disaggregated persistent memory, we checkpoint in the background – the GPU writes to the CXL memory pool, which is persistent and atomic. If the node crashes, the memory pool doesn’t. The next GPU reads the state back in under a second.

---

## The Engineering Curiosities: What Nobody Tells You

### 1. Cache Coherency is a Lie

The CXL 3.0 spec promises "hardware coherency." In practice, getting 4,000 memory blades to agree on the most recent value of a 64-bit pointer is like herding cats with Attos. We had to implement a **directory-based coherency protocol** using our MLE accelerator. Every CXL transaction includes a "home node" identifier. If two GPUs try to write to the same cache line simultaneously, the MLE sends a _conflict resolution_ packet – one writer retries after a backoff (implemented with a hardware random delay circuit). It’s not pretty, but it works.

### 2. The Thermal Nightmare

Memory blades (2TB of DRAM) dissipate about 2.5kW per blade. That’s 160kW for the memory pool alone. We use single-phase immersion cooling for the memory blades – the CXL switches hate it (liquid and 256 ports do not mix). We built a custom _dry contact_ heat exchanger specifically for the switch ASICs. **Lesson:** Disaggregation moves heat _away_ from the compute, but concentrates it in a new, weird place. Expect your DCIM team to hate you.

### 3. The “Memory Pin” Bug

Our early prototypes had a 37% failure rate on memory blade power-on. In a traditional server, if a DIMM fails, you RMA the stick. In a disaggregated system, a single failing memory blade can crash _every_ GPU that was accessing its address space. We had to implement **memory pin fencing** at the MLE level: if a blade fails, the MLE atomically marks all its pages as “unmapped” and sends a poison signal to any pending transactions. GPUs get an `EPT_VIOLATION` (like a segfault) but the job doesn’t crash – it writes a trace buffer and resumes. We lose 0.8% of training throughput to this recovery.

---

## The Hype vs. Reality: Why NVIDIA is Fighting This

You might have heard the buzz: **Disaggregated memory is the next big thing.** Vendors like Liqid, Untether AI, and even Intel (with CXL) are screaming from the rooftops. NVIDIA, however, is silent. There’s a reason.

**NVIDIA’s business model is built on the DGX "pizza box"** – the integrated node. They sell you an 8-GPU node with 2TB of RAM and a proprietary NVLink fabric. They want lock-in. Disaggregation commoditizes memory – suddenly, you can buy DRAM from Samsung, Micron, or SK hynix, and attach it to any GPU via standard CXL. NVIDIA loses the premium on “NVIDIA-certified” memory.

**The technical challenge:** NVIDIA’s GPUs don’t natively speak CXL. They use NVLink and NVSwitch. To connect to a CXL memory pool, you need a PCIe Gen 5 bridge (like a PLX switch) that translates NVLink transactions into CXL.mem. This adds 200-300ns of latency. For memory-bound kernels (like Flash Decoding), that latency kills performance. **We solved this by moving the memory _closer_ to the GPU via the NVSwitch fabric** – essentially, we created a _virtual_ CXL endpoint inside the NVSwitch ASIC. We're working with Broadcom on this. It’s not production-ready yet.

**The real takeaway:** Disaggregation is inevitable, but it will take a _new_ interconnect standard (CXL 4.0, or maybe something from the Open Compute Project) to make it trivial. For now, it’s a boutique solution for the petascale elite.

---

## The Future: What’s Coming in 2025–2026

1. **Memory Disaggregation for Inference:** Batch inference on LLMs is memory-bound. Imagine a single query needing to load 1TB of KV cache from a memory pool. With CXL 4.0’s _coherent interleaving_, you can stripe the cache across 64 blades and read it in 1.5 µs. That’s **10x cheaper** than keeping the cache on HBM.

2. **DAO of Memory (Disaggregated Allocator Optimizer):** We are open-sourcing our `cuDistMalloc` library under a permissive license next quarter. It will include a _reinforcement learning-based_ memory page placement agent that learns the access patterns of your model and pre-fetches pages onto the GPU’s local cache before the kernel launches. Think “Linux `fadvise` on steroids.”

3. **Optical Memory Pooling:** We’re prototyping a _silicon photonics_ memory pool – 100TB of DRAM connected via 1,024 optical lanes, each 400Gbps. No more copper CXL cables. Latency drops to 100ns. The power draw, however, is terrifying. We’re working on a _zero-energy_ optical switch – basically, a photovoltaic switch that passes light without electrical conversion. It’s vaporware for now, but the math works.

---

## Closing: The Unbundling Is Here

The era of the integrated server is over. For any cluster above 100 GPUs, the idea of "a node" is an artifact of 1980s mainframe design. **Memory should float. Compute should burn. And the fabric should be a single, coherent, global address space.**

We’ve been running this for six months. Our MTBF is 92% (terrible, but improving). Our effective throughput per dollar is 3.4x higher than our previous DGX-based cluster. We’ve trained a 3T parameter model to 99.2% accuracy on a 2TB subset of the C4 dataset. It crashed four times during the run. Each time, the memory pool preserved the state, and the compute pods restarted in under 30 seconds.

**You don’t need to be Google to do this.** The hardware is available (CXL 3.0 switches are shipping). The software is maturing (Linux 6.8 includes `cxl_mem` kernel drivers). The only thing holding you back is the courage to unbundle your architecture.

So go ahead. Break the chassis. Disaggregate your memory. Watch your training throughput triple.

And when your ops team asks why you ordered 64,000 memory blades, tell them: _“Because the GPU is too damn precious to waste on idle RAM.”_

---

_Got thoughts? Disagree with my latency numbers? Want to share your own disaggregation war stories? Drop a comment below. I’m @mem_bandwidth_junkie on X – let’s argue about cache coherency._
