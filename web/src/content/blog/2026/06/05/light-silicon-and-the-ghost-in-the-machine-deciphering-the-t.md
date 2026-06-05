---
title: "Light, Silicon, and the Ghost in the Machine: Deciphering the TPU v5 Hardware Abstraction Layer"
shortTitle: "Deciphering the TPU v5 Hardware Abstraction Layer"
date: 2026-06-05
image: "/images/2026/06/05/light-silicon-and-the-ghost-in-the-machine-deciphering-the-t.jpg"
---

We’ve all seen the charts. The exponential climb of parameters in Large Language Models (LLMs) looks less like a growth curve and more like a vertical takeoff. But while the industry oscillates between hype-fueled panic and genuine awe over models like Gemini 1.5 Pro or GPT-4o, there is a quieter, much more interesting story happening at the physical layer.

The real "magic" of modern AI isn't just in the transformer architecture or the Reinforcement Learning from Human Feedback (RLHF) loops. It’s in the plumbing. Specifically, it’s in how Google has managed to turn 8,960 individual Tensor Processing Units (TPUs) into a single, coherent, light-speed supercomputer.

With the release of **TPU v5p (Performance)** and **TPU v5e (Efficiency)**, Google didn't just update its silicon; it completely reimagined the **Hardware Abstraction Layer (HAL)**. We are moving away from the era of "chips on a motherboard" and into the era of the **Optical Fabric.**

In this deep dive, we’re going to peel back the lid on the TPU v5 architecture. We’ll analyze the inter-chiplet coherence protocols that keep the math honest, the Optical Circuit Switching (OCS) that makes InfiniBand look like dial-up, and the software glue—the HAL—that makes this massive orchestrations of photons and electrons programmable for mere mortals.

---

## The Reticle Limit and the Rise of the Chiplet

To understand the TPU v5, you first have to understand the physical wall Google hit with TPU v4. In semiconductor manufacturing, there is something called the **reticle limit**—the maximum size a single die can be (usually around 858mm²). If you want more compute, you can’t just make the chip bigger; it won't fit on the lithography machine.

NVIDIA solved this with NVLink and massive monolithic dies, but Google took a different path for the TPU v5p. They embraced **chiplet architecture** and **inter-chiplet interconnects (ICI)** at a scale never seen before.

### Why Chiplets?

In TPU v5p, the compute is disaggregated. Instead of one massive, low-yield die, Google uses a modular approach. This introduces a massive problem: **Coherence.** How do you make two separate pieces of silicon behave as if they share the same registers and memory?

This is where the **TPU v5 HAL** comes in. In a traditional CPU, the HAL is a thin driver. In the TPU v5, the HAL is a sophisticated resource manager that virtualizes the ICI. It masks the latency of moving data between chiplets so that the XLA (Accelerated Linear Algebra) compiler sees a giant, contiguous pool of HBM3 (High Bandwidth Memory).

---

## The Nervous System: Inter-Chiplet Coherence (ICI)

The "secret sauce" of the TPU v5 is the **ICI**. In TPU v5p, each chip is connected to its neighbors via dedicated high-speed links, forming a 3D torus topology. But unlike a standard network, the ICI is **tightly coupled** with the TPU’s systolic arrays.

### The Memory Model: Relaxed Consistency for Massive Scale

Maintaining strict cache coherence (like a multi-core Intel CPU) across 8,000+ nodes is physically impossible due to the speed of light. If node A had to wait for an acknowledgment from node Z every time it wrote to memory, the system would spend 99.9% of its time idling.

The TPU v5 HAL implements a **relaxed consistency model**. It uses a "push-based" DMA (Direct Memory Access) architecture. When a TPU finishes a computation (say, a Matrix Multiplication or MatMul), the HAL doesn't wait for a request. It proactively shoves that data across the ICI to the next node in the pipeline.

### SparseCore: The Unsung Hero of v5

One of the most technical "flexes" in the TPU v5 is the **SparseCore**. While the TensorCores handle the heavy MatMuls, the SparseCore is a dedicated co-processor for embedding lookups—the backbone of recommendation systems and the "MoE" (Mixture of Experts) architectures used in Gemini.

The HAL manages the SparseCore as a separate execution thread. It allows for "gather/scatter" operations to happen in parallel with the dense math. This means while the main Matrix Unit (MXU) is crunching tokens, the SparseCore is already fetching the next layer's weights over the ICI.

---

## The Optical Fabric: Switching at the Speed of Light

If the ICI is the nervous system, the **Optical Circuit Switch (OCS)** is the circulatory system. This is where the TPU v5 leaves the competition in the dust.

In a traditional data center, if you want to connect Rack A to Rack B, you go through a series of electrical switches (Leaf/Spine). This involves **OEO (Optical-Electrical-Optical) conversions**. You take the light from a fiber, turn it into electricity to switch it, and turn it back into light. This adds microseconds of latency—a lifetime in AI training.

### Palomar and the MEMS Mirror

Google’s OCS (codenamed Palomar) eliminates the "E" in OEO. It uses **Micro-Electro-Mechanical Systems (MEMS)**—tiny, steerable mirrors—to physically reflect beams of light from one fiber to another.

**Why this matters for the HAL:**
The TPU v5 HAL can **programmatically reconfigure the physical topology of the supercomputer.**

Imagine you are training an LLM. For the first phase, you want a 3D Torus topology for optimal All-Reduce performance. Midway through, you switch to a Mixture of Experts model that requires a different communication pattern. In a standard cluster, you're stuck with your physical wiring. With TPU v5, the HAL sends a command to the OCS, the mirrors tilt, and **the physical layout of the network changes in milliseconds.**

```python
# Conceptual pseudocode for HAL-level topology reconfiguration
hal.reconfigure_topology(
    slice_id="gemini_training_01",
    target_pattern=TopologyPattern.TWISTED_TORUS,
    optimization_goal=Optimization.ALL_TO_ALL_BANDWIDTH
)
```

This dynamic reconfigurability allows for "slice-level" multi-tenancy. You can carve out a 1,024-chip slice for one team and a 512-chip slice for another, and both will have "perfect" topology as if they were the only ones in the building.

---

## Deep Dive into the Software Stack: XLA and Pallas

The hardware is impressive, but without a way to program it, it’s just very expensive space heating. The bridge between the Python code you write in JAX or PyTorch and the OCS-mirrors is the **XLA Compiler** and a new language called **Pallas**.

### XLA (Accelerated Linear Algebra)

XLA is the brain of the operation. It takes a high-level computational graph and performs "kernel fusion." Instead of executing `Add` and then `Multiply` as two separate steps (which would involve two slow trips to HBM memory), XLA fuses them into a single TPU instruction.

At the TPU v5 level, XLA interacts with the HAL to handle **collective communication primitives**. When you call `jax.pmean` (a parallel mean), XLA doesn't just send data. It looks at the HAL’s map of the ICI and OCS and generates a custom routing path that avoids congestion.

### Pallas: Writing Metal-Level Code

For the first time, Google is letting developers get closer to the metal with **Pallas**. Pallas is to TPUs what CUDA is to GPUs, but with a twist. It allows you to write custom kernels that explicitly manage the **SRAM (Static RAM)**—the ultra-fast memory living right next to the MXU.

In the TPU v5 HAL, the memory hierarchy looks like this:

1.  **Registers:** Fast, tiny.
2.  **VMEM (Vector Memory):** Low latency, local to the core.
3.  **HBM3:** High bandwidth, but relatively high latency (250-300 cycles).

Pallas allows an engineer to write a loop that pre-fetches data from HBM into VMEM _while_ the MXU is busy. This "double-buffering" is managed by the HAL's DMA engines, ensuring the MXU never "starves" for data.

---

## The Scale: 18.5 ExaFLOPs of Compute

Let's talk about the sheer magnitude. A single TPU v5p pod consists of 8,960 chips. When these chips are linked via the OCS fabric, they produce a staggering **18.5 ExaFLOPs** of FP8 performance.

To put that in perspective: If every person on Earth did one calculation per second, it would take the entire population **75 years** to do what a single TPU v5p pod does in **one second.**

### Dealing with the "Blast Radius"

At this scale, hardware failure isn't a possibility; it's a statistical certainty. In a cluster of 9,000 chips, something is always breaking.

The TPU v5 HAL handles this through a concept called **transparent checkpointing and rescheduling.** Because the OCS can reconfigure the network, the HAL can "route around" a dead chip. If Chip #402 fails, the mirrors in the OCS shift, the HAL re-maps the logical ID of the node to a hot spare, and the training job continues with minimal downtime. This is the difference between a training run taking 3 months or failing every 3 days.

---

## Hype vs. Reality: TPU v5p vs. NVIDIA H100

The tech press loves a "chip war." The narrative usually goes: "Can Google's TPU kill the NVIDIA H100?"

The reality is more nuanced. NVIDIA’s H100 is an incredible, versatile beast. It excels in environments where you need to run a thousand different types of jobs. However, Google’s TPU v5 is a **vertically integrated scalpel.**

The advantage Google has isn't just the raw TFLOPS; it's the **power efficiency and the interconnect.**

- **Power:** By using OCS instead of electrical switches, Google saves megawatts of power. Light doesn't generate heat; electrical resistance does.
- **Interconnect:** The ICI bandwidth in TPU v5p is nearly double that of the previous generation, providing 4,800 Gbps per chip.

When you're training a model like Gemini, the bottleneck isn't how fast you can do a MatMul; it's how fast you can synchronize the gradients across the pod. This is where the HAL and the Optical Fabric become Google’s "unfair advantage."

---

## Engineering Curiosities: The "Twisted" Torus

One of the coolest technical details buried in the TPU v5 documentation is the use of the **Twisted Torus topology.**

In a standard 3D torus, you connect nodes in a grid, and the ends wrap around. However, this leads to "long wraps"—the cable from the last node in a row back to the first node has to be very long, creating a latency imbalance.

Google’s HAL implements a **mathematical twist** in the wiring. By shifting the wrap-around connection by one unit, they ensure that the maximum distance between any two nodes is minimized and, more importantly, **uniform.** This means the XLA compiler can assume that the latency for an `All-Gather` operation is deterministic. In the world of high-performance computing (HPC), determinism is the holy grail. It allows for perfectly synchronous execution without "stragglers."

---

## The Hardware Abstraction Layer as the Future of AI

As we move toward even larger models, the "unit of compute" is shifting. We are no longer designing for the chip; we are designing for the **Datacenter as a Computer.**

The TPU v5 HAL is the first true operating system for this datacenter-scale computer. It abstracts away:

1.  **Physical Location:** Thanks to OCS, where a chip is physically located doesn't matter.
2.  **Memory Boundary:** HBM3 is treated as a global, sharded resource.
3.  **Network Topology:** The HAL reconfigures the network to fit the model, not the other way around.

### Why You Should Care

Even if you never write a line of Pallas code or touch a TPU, the innovations in the TPU v5 HAL are setting the stage for the next decade of systems engineering. We are seeing the death of the traditional "Server" and the birth of the **Composable Infrastructure.**

The ability to use MEMS mirrors to route photons between chiplets to solve a backpropagation error is, frankly, one of the greatest engineering achievements of our time. It is a symphony of physics, silicon, and software.

## Looking Ahead: The Photon Revolution

We are only at the beginning of the optical era. While the TPU v5 uses OCS for rack-to-rack communication, the industry is already looking at **Silicon Photonics**—bringing light directly onto the chip.

When that happens, the HAL will have to manage not just thousands of mirrors, but millions of on-chip optical modulators. The complexity will be staggering, but the rewards—models with trillions of parameters running at 100x the current speed—are too great to ignore.

Google’s TPU v5 isn't just a faster processor. It’s a statement of intent. It says that the future of AI isn't just about better algorithms; it’s about mastering the movement of data at the physical limit of the universe.

And as it turns out, the physical limit of the universe is a very fast place to be.

---

**Technical Footnotes & Further Reading:**

- _Google’s OCS Paper (ASPLOS 2023):_ For those who want to see the mirror-steering math.
- _XLA: Intermediate Representation (HLO):_ The documentation on how XLA lowers ops to the TPU HAL.
- _The SparseCore Whitepaper:_ Deep dive into how Google handles embedding tables at scale.
