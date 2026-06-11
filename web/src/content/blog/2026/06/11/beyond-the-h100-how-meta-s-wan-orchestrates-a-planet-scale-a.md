---
title: 'Beyond the H100: How Meta’s "Wan" Orchestrates a Planet-Scale AI Symphony'
shortTitle: "Meta Wan: Orchestrating Planet-Scale AI Infrastructure"
date: 2026-06-11
image: "/images/2026/06/11/beyond-the-h100-how-meta-s-wan-orchestrates-a-planet-scale-a.jpg"
---

At the scale of Meta, "infrastructure" isn't just a collection of servers; it’s a living, breathing organism. When you have billions of people interacting with Llama-powered assistants, clicking through AI-curated feeds, and generating images in real-time, the traditional notions of "cloud computing" break down. You aren't just managing a cluster; you are managing a global fleet of heterogeneous silicon that must respond with millisecond precision.

The industry has spent the last two years obsessed with the **GPU arms race**. We’ve tracked H100 allocations like sports scores. But for the engineers inside the belly of the beast, the hardware is only half the story. The real magic—the secret sauce that prevents Meta’s massive AI investments from becoming a pile of expensive, idling heaters—is a system you’ve likely only heard whispers of: **Wan**.

Wan is Meta’s next-generation resource management and scheduling system. It is the conductor of a high-stakes orchestra, co-designing the relationship between cutting-edge software and a diverse hardware fleet that includes NVIDIA GPUs, AMD accelerators, and Meta’s own custom-built **MTIA (Meta Training and Inference Accelerator)**.

This isn't just another Kubernetes wrapper. This is the story of how Meta solved the "Inference Wall" through radical hardware-software co-design.

---

## The Context: The Pivot from Homogeneity to the Heterogeneous Reality

To understand why Wan exists, we have to look at the "Inference Crisis." In the pre-LLM era, AI inference was relatively predictable. You ran recommendation systems or computer vision models that were computationally light compared to today’s giants. You could throw them on CPUs or mid-range GPUs, and a standard scheduler would handle it.

Then came the **Llama Era**.

Suddenly, a single inference request might require dozens of gigabytes of HBM (High Bandwidth Memory) and trillions of floating-point operations. At the same time, the hardware market fractured. Relying solely on a single vendor (NVIDIA) became a strategic risk and a financial nightmare. Meta realized they needed a fleet that was **heterogeneous by design**.

The fleet today looks like a mosaic:

1.  **NVIDIA H100s/B200s:** The heavy lifters for the most complex Llama 3/4 models.
2.  **Meta MTIA:** Custom silicon optimized specifically for Meta’s internal workloads (like the PyTorch-heavy recommendation models).
3.  **Legacy GPUs (A100s/V100s):** Still vital for smaller task-specific models.
4.  **High-performance CPUs:** Handling the "glue code," pre-processing, and lighter embedding tasks.

**Wan** was built because traditional schedulers don't understand the nuance of _why_ an LLM request should go to an MTIA chip versus an H100. Wan understands the silicon's soul.

---

## Architecture Deep-Dive: The Anatomy of Wan

Wan isn't a monolithic block. It’s a distributed control plane designed for **global scale but local execution**. If we peel back the hood, we see a three-tier architecture that bridges the gap between a high-level Python request and a low-level register on a chip.

### 1. The Global Resource Estimator

At the top level, Wan maintains a real-time "inventory of capability." Unlike a standard cloud scheduler that looks at "CPU/RAM availability," the Resource Estimator tracks:

- **HBM Fragmentation:** Is the memory on the GPU contiguous enough for a large KV cache?
- **Thermal Headroom:** Is the rack in the Prineville data center running too hot to sustain a 700W TDP for the next ten minutes?
- **Network Topology:** Are the available GPUs connected via NVLink, or are they across a slower RoCE (RDMA over Converged Ethernet) hop?

### 2. The Predictive Logic Engine

This is where the "Co-Design" begins. Wan doesn't just wait for a request; it predicts the load. Using internal models (yes, AI managing AI), Wan forecasts which models are likely to be "hot" in which geographic regions. It preemptively "warms" the weights of Llama 3 on MTIA clusters in Europe just as the continent wakes up, ensuring that the first user doesn't hit a 2-second "cold start" latency.

### 3. The Wan Agent (The Silicon Whisperer)

On every single node in the fleet, a Wan Agent runs. This is a low-latency C++ process that talks directly to the hardware abstraction layer. It monitors the "health" of the inference kernels. If a specific kernel on an MTIA chip is underperforming due to a driver mismatch, the Wan Agent reports it instantly, and the scheduler routes around that specific "grey failure."

---

## Hardware-Software Co-Design: The Secret Sauce

The term "Hardware-Software Co-Design" is often used as a buzzword, but in Wan, it manifests in three very technical, very tangible ways.

### I. Topology-Aware Scheduling (The "Distance" Problem)

In a modern AI data center, the "distance" between two chips isn't measured in inches; it’s measured in nanoseconds and bandwidth.

If you are running a 405B Llama model, it won't fit on one GPU. You need to shard it across multiple chips (Tensor Parallelism). If Wan schedules Shard A on a chip in Rack 1 and Shard B on a chip in Rack 5, the model will crawl because the data has to traverse the top-of-rack switches.

**Wan’s Co-Design:** Wan has a complete map of the physical NVLink and InfiniBand/RoCE fabric. It treats a "pod" of 64 GPUs as a single scheduling unit. It understands the **hierarchical affinity** of the hardware. It will never split a latency-sensitive inference job across a non-optimal network boundary.

### II. The KV Cache Orchestrator

The biggest bottleneck in LLM inference isn't the compute—it’s the memory. Specifically, the **Key-Value (KV) Cache**. As an LLM generates text, it stores the context of the conversation in the GPU's high-bandwidth memory.

Wan implements a system-level memory management strategy that is aware of the hardware's specific memory controllers.

- On **NVIDIA chips**, it leverages PageAttention to handle memory fragmentation.
- On **MTIA chips**, it uses a custom-designed memory tiling strategy that Wan manages directly.

By having the scheduler (Wan) communicate with the memory allocator (inside the model code), Meta can achieve a **40% higher throughput** than if they used a "black box" hardware approach.

### III. Power-Aware Throttle Management

At Meta's scale, power is a finite constraint. If every GPU in a data center spiked to 100% utilization simultaneously, it could trip the local utility's breakers.

Wan is "Power-Aware." It receives telemetry from the Power Distribution Units (PDUs). If the data center is approaching its power envelope, Wan doesn't just "drop" requests. It uses **Co-Design** to shift the workload:

1.  It might route "non-critical" batch jobs (like offline translation) to a data center with more power headroom.
2.  It might signal the MTIA chips to run in a "high-efficiency" low-clock mode, trading a bit of latency for a massive drop in wattage.

---

## The Hype vs. The Reality: Why MTIA is the Real Star

There was a lot of skepticism when Meta announced they were building their own chips (MTIA). The "hype" was that Meta was trying to kill NVIDIA. The "reality" is much more nuanced: Meta is building a **specialized fleet**.

NVIDIA GPUs are the "Swiss Army Knives" of the AI world. They are incredible at everything. But MTIA is a "Scalpel." It is specifically designed to run the PyTorch-based recommendation models that drive Meta’s revenue (Ads, Reels).

**The Wan Integration:**
Wan treats MTIA as a "first-class citizen." When a request comes in, Wan looks at the model's graph. If the model uses operations that are natively optimized for MTIA’s SRAM-heavy architecture, Wan routes it there. This frees up the expensive H100s to handle the massive, sprawling parameters of the Llama-4 research experiments.

This **Heterogeneous Load Balancing** is how Meta manages to keep their CapEx (Capital Expenditure) from spiraling out of control. They aren't replacing NVIDIA; they are augmenting them with laser-focused efficiency.

---

## Technical Curiosity: A "Day in the Life" of a Token in Wan

To visualize how this works, let's trace a single prompt: _"Explain quantum physics to a five-year-old."_

1.  **Ingress:** The request hits Meta’s edge. The Wan Global Load Balancer identifies that this is a "Generative AI" request requiring high-precision weights.
2.  **The Bid:** Wan’s scheduler looks for a "Slot." It finds an H100 cluster in Texas that has just finished a batch job. However, the Texas cluster is experiencing a slight network jitter.
3.  **The Shift:** Wan decides to route the request to an MTIA v2 cluster in Iowa. Why? Because the MTIA v2 has a specialized "Flash Attention" kernel pre-loaded in its local cache that matches this specific prompt's requirements.
4.  **The Execution:** The Wan Agent on the Iowa node clears a small block of HBM for the KV cache. It pins the process to the specific hardware cores to avoid "Context Switching" (a killer of p99 latency).
5.  **The Return:** As the tokens are generated, Wan monitors the "Time Per Output Token" (TPOT). If the latency spikes, it dynamically adjusts the batch size for the _next_ set of requests to maintain the user experience.

---

## Operationalizing Complexity: The "Zero-Downtime" Fleet

One of the most impressive feats of Wan is how it handles **hardware failures**. In a fleet of hundreds of thousands of GPUs, something is _always_ breaking. A memory module fails, a fiber optic cable gets bent, or a voltage regulator pops.

In a traditional environment, a hardware failure means a crashed job and a manual "reboot."

In Meta’s Wan-orchestrated fleet:

- **Health Probes:** Wan runs "micro-benchmarks" in the background. Every few minutes, it sends a tiny, dummy AI task to every chip.
- **Predictive Isolation:** If a chip's "heartbeat" shows a 5% increase in error rates (ECC errors), Wan marks that chip as "Dying."
- **Transparent Migration:** Wan uses a technique called **Live Inference Migration**. It begins to duplicate the KV cache of active requests on a healthy neighbor chip. Once the state is synced, it flips the pointer. The user never knows their request just hopped from a failing chip to a healthy one.

---

## Why This Matters for the Future of AI

We are moving into an era where "raw flops" are no longer the only metric that matters. As we push toward **Agentic AI**—where models don't just answer questions but perform multi-step actions—the infrastructure demands will grow exponentially.

Wan represents a shift in thinking: **The Data Center is the Computer.**

By co-designing the scheduler with the silicon, Meta has created a system that is:

1.  **Resilient:** It thrives on heterogeneous, imperfect hardware.
2.  **Efficient:** It maximizes the utilization of every single watt and every single byte of HBM.
3.  **Scalable:** It allows Meta to plug in "future silicon" (like MTIA v3 or NVIDIA's Rubin architecture) with minimal changes to the high-level software.

### The Engineering Takeaway

For the engineers reading this at Cloudflare, Uber, or the next big AI startup, the lesson of Wan is clear: **Abstraction layers are necessary, but transparency is the key to performance.**

If you treat your hardware as a black box, you are leaving 30-50% of your performance on the table. The next frontier of engineering isn't just writing better code or building faster chips; it's the **Wan-like glue** that allows the code to understand the thermal, electrical, and topological reality of the silicon it runs on.

Meta’s Wan isn't just a scheduler; it’s a blueprint for the AI-native infrastructure of the next decade. While the rest of the world is fighting over who has the most GPUs, Meta is focused on who can make those GPUs—and their own custom silicon—dance in the most perfect, efficient harmony.

**And right now, the conductor is winning.**

---

### Conceptual Snippet: A "Wan-Style" Job Definition (Pythonic Pseudo-code)

To give you a taste of what it looks like to schedule on a heterogeneous fleet, here is what a "Wan-aware" job definition might look like in Meta's internal orchestration DSL:

```python
from wan_orchestrator import InferenceDeployment, HardwareCapability, NetworkTopology

# Define a deployment for Llama-3-70B
deployment = InferenceDeployment(
    model="llama-3-70b-instruct",
    priority="high_latency_sensitive",
    heterogeneous_policy="allow_mtia_v2_or_h100"
)

# Constraints that talk directly to the hardware-software co-design layer
deployment.add_constraints([
    # Ensure we have enough HBM for a 8k context window
    HardwareCapability.MinimumHBM(gb=64),

    # Only schedule on nodes with NVLink P2P capability for Tensor Parallelism
    NetworkTopology.RequireIntraNodeBandwidth(min_gbps=450),

    # Power-aware scheduling: avoid regions with high carbon intensity or grid stress
    HardwareCapability.PowerEfficiencyPreference(mode="max_throughput_per_watt")
])

# The "Co-Design" Hook: Wan can swap kernels based on the assigned hardware
@deployment.on_hardware_assigned
def optimize_kernels(assignment):
    if assignment.hardware_type == "MTIA_V2":
        import mtia_kernels as kernels
        load_model_weights(backend=kernels.SRAM_OPTIMIZED)
    elif assignment.hardware_type == "NVIDIA_H100":
        import cuda_kernels as kernels
        load_model_weights(backend=kernels.TRITON_FLASH_ATTN)

# Launch the fleet
wan_manager.deploy(deployment, scale_factor=0.95) # 95% target utilization
```

This snippet illustrates the core philosophy: the software isn't just _running_ on the hardware; it’s _adapting_ to it in real-time. That is the essence of Wan.
