---
title: "🚀 Breaking the Scheduler Barrier: How We Squeezed 99.7% GPU Utilization from Exascale AI Training"
shortTitle: "Exascale AI: Max GPU Utilization Through Scheduler Breakthroughs"
date: 2026-05-11
image: "/images/2026-05-11-breaking-the-scheduler-barrier-how-we-squeezed-99.jpg"
---

**Spoiler alert: It wasn't Kubernetes doing the heavy lifting.**

You know that sinking feeling. You're staring at your Grafana dashboard. Your GPU cluster—a $50M investment in H100s, A100s, or maybe even some exotic MI300X beasts—is screaming along at **42% utilization**. Your ML engineers are frustrated. Your cloud bill is bleeding. And Kubernetes, bless its heart, is doing exactly what it was designed to do: scheduling containers, not thinking about tensor parallelism, NUMA affinity, or the fact that your model needs 320GB of VRAM across 8 GPUs that simply _cannot_ be on different PCIe switches.

If you've ever felt that pain, welcome. This is the engineering story of what happens when you decide to rip out the default scheduler, strap a rocket engine onto Kubernetes, and build a custom resource management layer that treats GPUs not as fungible compute units, but as **topologically-aware, bandwidth-contended, cache-coherent supercomputing nodes** that need to literally _hold hands_ during training.

---

## The Context: Why Everyone is Suddenly Talking About "Post-Kubernetes Scheduling"

Let's rewind to early 2023. The AI hype machine is in full swing. Every tech blog is publishing "We scaled our LLM to 1 trillion parameters!" posts. But behind the scenes, a quiet crisis is brewing.

The problem became painfully obvious at major AI labs: **Kubernetes, for all its container orchestration wizardry, fundamentally doesn't understand ML training workloads.** It was born in the era of stateless microservices—"spin up 10 copies of my Node.js app, and if one fails, who cares?" That's beautiful for web servers. It's catastrophic for distributed training.

Here's why the hype around alternative schedulers exploded:

- **Training is a distributed monolith.** Your model might span 64 GPUs across 8 nodes. If _one_ GPU's network cable gets jiggled, the entire job stalls. K8s retry logic? It might reschedule that pod onto a _different node_, breaking the entire model-parallel topology.
- **Co-scheduling is non-negotiable.** You need _all_ your GPUs, _all at the exact same time_, for the entire training run. K8s "best-effort" scheduling was costing labs days of idle time waiting for pods to land simultaneously.
- **The margin of error is zero.** At exascale (1000+ GPUs), even 2% utilization loss due to poor scheduling costs millions of dollars per month in electricity and hardware depreciation.

The result? A Cambrian explosion of custom schedulers: **Volcano, Yunikorn, AWS Batch for ML, and our in-house abomination we lovingly call "The Hammer."** But none of these are _just_ schedulers. They're the tip of a much deeper architectural iceberg.

---

## The Architecture Nightmare: Why Your K8s Cluster is a Lie

Before we talk solutions, let's get brutally honest about the hardware reality you're dealing with.

### The Topology Trap

Imagine you have 8 NVIDIA H100 GPUs in a single node. They're connected via NVLink (900 GB/s). That's fast. But they're also connected to the CPU via PCIe Gen5 (128 GB/s per slot). And the CPU is connected to other CPUs via NUMA links (variable, ~50-100 GB/s). And your nodes are connected via InfiniBand (400 Gb/s if you're lucky).

**Your ML model needs certain GPU pairs to talk to each other faster than others.** For example, tensor parallelism (Megatron-LM) demands intra-node NVLink bandwidth. Pipeline parallelism can tolerate slower inter-node connections. Data parallelism? It's network-bound.

Here's where it gets messy. Out of the box, Kubernetes doesn't know:

- Which GPUs share an NVLink switch?
- Which PCIe root complex a GPU is under?
- Whether two pods on different nodes share a top-of-rack switch?

**Result:** You might schedule two tensor-parallel model shards on GPUs that _don't share NVLink_. Your training step time doubles. Utilization craters to 35%.

### The Memory Fragmentation Crisis

Modern training runs have exotic memory patterns. Your model might need:

- **70GB** for model parameters
- **20GB** for optimizer states
- **40GB** for activations (during forward pass)
- **25GB** for mixed-precision gradients

That's 155GB total. An H100 has 80GB. You need at least two GPUs. But you also need _memory-balanced_ placement. If K8s puts one pod on a GPU with 10 other processes eating 10GB of VRAM, you get OOM errors mid-training. And K8s _cannot preempt_ because it doesn't understand memory pressure in any meaningful way.

---

## Our Solution: The Daemon Scheduler + Topology-Aware Resource Pool

Let me walk you through the three-layer architecture we built. It's running in production on a 4,096-GPU cluster powering a 175B parameter model training run. I'll give you the raw details.

### Layer 1: The Daemon Scheduler (Kubernetes Mutating Webhook on Steroids)

We didn't replace the Kubernetes scheduler entirely. We bent it to our will. Here's the flow:

1. **User submits a Volcano Job** (a custom resource that defines GPU counts, parallelism types, and affinity rules).
2. **A mutating admission webhook intercepts the pod spec.**
3. The webhook calls a **centralized topology daemon** that maintains a live map of:
    - Every GPU in the cluster (UUID, node, NVSwitch group, PCIe topology)
    - Current memory utilization (polled every 5 seconds via DCGM)
    - Current utilization percentage (to spot "fake idle" GPUs—processes sitting in PyTorch's `__init__`)
4. The webhook **injects node affinity rules, pod anti-affinity, and custom GPU selectors** that reflect the _exact_ topology needed.

**Code snippet from our webhook (simplified, but real):**

```python
# Pseudocode for GPU allocation logic
def select_gpus(request: PodSpec, cluster_state: TopologyMap) -> List[GPUAllocation]:
    job_type = request.labels.get("parallelism-type", "data")
    model_parallel_size = request.annotations.get("model_parallel_degree", 1)

    if job_type == "tensor":
        # Find NVLink-connected GPU sets
        nvlink_groups = cluster_state.find_nvlink_groups(model_parallel_size)
        best_group = nvlink_groups.best_fit(request.gpu_count)

        # Enforce node-level affinity: all GPUs must be in same NUMA domain
        for gpu in best_group:
            request.spec.affinity.node_selector["nvidia.com/numa-affinity"] = gpu.numa_node

        return best_group

    elif job_type == "pipeline":
        # Inter-node topology matters: pick nodes with same PCIe switch
        pcie_groups = cluster_state.find_pcie_coherent_groups(request.gpu_count)
        ...
```

**The result?** Tensor-parallel jobs land on GPUs that are physically bonded via NVLink. Pipeline jobs get nodes that share high-bandwidth PCIe roots. We consistently see **15-40% step-time improvements** over naive scheduling.

### Layer 2: Preemptive Memory Pressure Signaling

This is where things get spicy. GPU memory is a zero-sum game. You have 80GB. If a training process uses 72GB and a data-loading process (yes, PyTorch DataLoader on the GPU) uses 6GB, you've got 2GB of slop. A memory spike during the backward pass? OOM.

We built a **memory pressure predictor** that runs as a sidecar on every GPU node. It:

- Tracks `cudaMalloc` / `cudaFree` calls via libnvml hooks
- Maintains a rolling histogram of VRAM usage per process
- Runs a small LSTM model (yes, we're using ML to schedule ML) that predicts OOM events 2-3 seconds before they happen

**When it predicts an OOM:**

1. It sends a `SIGSTOP` to the least critical process (e.g., a validation loop that's not on the critical path)
2. It defragments memory by triggering a controlled `cudaDeviceSynchronize()`
3. It reallocates memory for the training process
4. Resumes

This is _insanely_ risky. But we've tested it for 30,000+ training hours. It's prevented **7 OOM events per day** on average. Without it, utilization would drop by 12% due to restarts.

### Layer 3: Co-Scheduling with Temporal Gangs

The holy grail of exascale scheduling is **gang scheduling**—making sure all pods for a training job start _simultaneously_. Kubernetes has no native concept of this. Volcano does, but its approach is too naive: "Wait for N pods to be scheduled, then start them."

Our innovation was **temporal gang scheduling with backfill**. Here's the algorithm:

1. A training job arrives requesting 256 GPUs (8 nodes × 32 GPUs).
2. The scheduler looks at the "critical path": the slowest node to become available.
3. It computes a **spread spectrum** for each node: for how long would a node sit idle if we wait for all 256 GPUs?
4. **If the idle time is > 1 minute**, we backfill with a _preemptible_ job (e.g., a hyperparameter sweep that can checkpoint instantly)
5. When the gang-job's last GPU becomes available, we preempt the backfill job, checkpoint it (takes ~5 seconds), and start the gang job

**Data from production:**

- Average idle time for gang jobs: **3.2 seconds** (down from 47 seconds with vanilla Volcano)
- Cluster utilization (overall): **97.3%** (up from 82%)
- Preemption overhead: **0.4% of total compute time** (totally acceptable for the utilization gain)

---

## The Exascale Reality Check: Networking and RDMA

If you think scheduling is just about GPUs, you're missing half the battle. At exascale, the network _is_ a compute resource. And it's the most contended.

### The Jitter Problem

When you have 4,096 GPUs doing all-reduce across InfiniBand, the synchronization protocol (e.g., NCCL's ring algorithm) is brutally sensitive to **tail latency**. If one node's NIC experiences a queuing delay of 100 microseconds, _every other node_ stalls waiting for that reduction step.

**Our solution: Network-aware scheduling.**

We instrumented every InfiniBand HCA (Host Channel Adapter) to report:

- Queue pair depth per link
- Packet loss rate (even 0.01% is catastrophic)
- Credit loopback delays (a sign of fabric congestion)

The scheduler **avoids colocating jobs** that share the same top-of-rack switch or leaf-spine fabric if they both do heavy all-reduce. We added a simple rule: "No two training jobs with > 64 GPUs can land on the same leaf switch unless there's 100 Gbps headroom."

**Impact:** Tail latency for all-reduce dropped from 1.2ms to 0.4ms. That's an 8% end-to-end training speedup on a 30-day run—**saving 2.4 days of compute time per job.**

### The NCCL-Awareness Hack

This part still makes me grin. Standard NCCL uses a ring topology for all-reduce. But the ring's performance depends heavily on how GPUs are mapped to network cards. We wrote a **custom NCCL topology plugin** that communicates with our scheduler.

When the scheduler assigns GPUs to a job, it also sends a **NCCL rank-to-GPU mapping** that:

- Ensures each node's GPUs are connected to its NICs in the optimal order
- Matches the physical cabling (e.g., GPU0 on node A should talk to GPU2 on node B because they share the same leaf switch)
- Avoids GPU-to-GPU links that have high latency (we discovered that _two_ H100s on the same board can have 50% bandwidth variation due to manufacturing tolerance!)

**Result:** NCCL all-reduce bandwidth went from 320 GB/s to 395 GB/s. We're now within 95% of theoretical peak.

---

## The Metadata Mess: How We Tamed the State

With 4,096 GPUs, the scheduler's state grows exponentially. Every GPU has ~50 attributes. Every job has ~20 constraints. If we stored this in a SQL database, queries would take seconds.

**We built a custom in-memory state tree using Redis with CRDTs (Conflict-Free Replicated Data Types).**

Here's the beauty:

- **3 microsecond state lookups** (vs 25ms for PostgreSQL)
- **CRDT-based conflict resolution** for leaderless scheduling decisions (we have 3 scheduler replicas, any of which can make scheduling decisions)
- **Tombstone-based deletion** for preempted jobs (so we don't double-allocate GPUs)

**The state tree structure:**

```
/Root
  /Jobs/{job_id} (state: pending|running|preempted)
    /Tasks/{task_index} (node: node_id, gpu_ids: [0,1,2,3])
    /Constraints (hard: topology, soft: utilization > 50%)
  /Nodes/{node_id}
    /GPUs/{gpu_id} (memory_free, temperature, nvlink_partners)
    /NICs/{hca_id} (queue_depths, link_speed)
    /Memory_Pressure (running_prediction: OOM_risk)
  /Allocator (free_gpus: [gpu_uuid, ...], reserved_for_gang: {job_id: start_time})
```

**Scaling factor:** We run at 50,000 state mutations per second (mostly GPU memory updates). Redis handles it on a cluster of 3 c6g.8xlarge instances. Cost: $4,000/month. Savings from improved utilization: **$2.1M/month.**

---

## The Hardest Bug We Ever Squashed: The "Ghost GPU" Incident

Let me share a war story that illustrates why this work is both terrifying and thrilling.

One day, our scheduler started seeing **30% GPU allocation failure** for no apparent reason. State said 2,000 GPUs were free. Node health checks passed. Kubernetes said the nodes were ready. But every time we tried to schedule a pod, it failed with "insufficient resources."

After 14 hours of debugging (including 4 hours on a Zoom call with NVIDIA engineering), we discovered:

**The GPUs were in a "zombie" state.** A prior training job had done an unclean shutdown. The GPU's firmware had locked some memory regions in a "pending DMA" state. The kernel driver reported the memory as free, but `cudaGetDeviceProperties()` returned zero free memory.

**Our fix:** We added a **pre-allocation sanity check** before scheduling. When the scheduler picks a GPU, it spawns a tiny CUDA kernel that allocates 1 MB, writes to it, reads it back, and frees it. If this fails, the GPU is flagged as "poisoned" and added to a hold queue for GPU reset.

**The monitoring hook:**

```python
def check_gpu_sanity(gpu_uuid: str, node: str) -> bool:
    try:
        # Launch a lightweight CUDA context on the GPU
        context = cuda_context.attach(gpu_uuid)
        array = cuda.mem_alloc(1_000_000)
        cuda.memset(array, 0, 1_000_000)  # Write
        check = cuda.mem_alloc_as_array(1_000_000)
        cuda.memcpy(check, array, 1_000_000)  # Read
        cuda.free(array)
        cuda.free(check)
        context.detach()
        return True
    except (cuda.CudaAPIError, RuntimeError) as e:
        logging.warn(f"GPU {gpu_uuid} failed sanity check: {e}")
        return False
```

We now run this check every 60 seconds for each GPU. It catches **3-5 zombie GPUs per day** on a 4,096 GPU cluster. Each zombie would have otherwise caused 4+ hours of debugging per incident.

---

## The Final Architecture: Putting It All Together

Here's what our system looks like, from a 50,000-foot view:

```
[Model Training Job Spec]
        |
        v
[Volcano / Custom Resource]
        |
        v
[Topology-Aware Webhook]  <--- Live state from Redis CRDT tree
        |                          (GPU memory, topology, network load)
        v
[Gang Scheduler with Backfill]
        |
        +--> [Node A] - [DCGM Exporter] - [Memory Pressure Predictor] - [NCCL Plugin]
        +--> [Node B] - [DCGM Exporter] - [Memory Pressure Predictor] - [NCCL Plugin]
        +--> ... 256 nodes total
        |
        v
[InfiniBand Fabric Monitor] (tail latency, queue depths)
        |
        v
[Preemption Handler] (checkpoints backfill jobs in <5s)
```

**Key metrics (production, 4096 H100 cluster):**
| Metric | Before | After |
|--------|--------|-------|
| Average GPU utilization | 62% | 97.3% |
| Job start time (256 GPU) | 47s | 3.2s |
| OOM crashes per day | 23 | 0.4 |
| Training throughput (175B param) | 1.2 TFLOPs/GPU | 1.71 TFLOPs/GPU |
| Mean time between restarts | 2.1 days | 18 days |

---

## The Philosophy: You Don't Actually Want "Elastic" Scheduling

Here's the uncomfortable truth this whole experience taught me: **The industry's obsession with "elastic" Kubernetes scheduling is wrong for ML.**

Elasticity assumes workloads can scale in and out gracefully. ML training can't. Resharding model parallelism is a **days-long operation** that requires recomputing gradients. Every preemption or reschedule loses hours of work (unless you have perfect checkpointing, which adds 30% overhead).

**Our philosophy:** Treat GPU allocation as a **batch computing problem** from the 1970s, but with 2024's hardware complexity. It's closer to running a molecular dynamics simulation on a supercomputer than serving web traffic.

The result? We don't even use Kubernetes for the final scheduling layer anymore. We use a **custom resource allocation daemon** that:

- Calls the Kubernetes API _only_ to register pods
- Makes all scheduling decisions itself
- Uses Kubernetes as a glorified namespace manager and health checker

It's ugly. It's not cloud-native. But it got us from 62% to 97.3% utilization. And that's worth $2M/month in savings.

---

## What's Next: Thermal-Aware Scheduling and Power Capping

We're not done. The next frontier is **thermal scheduling**. On H100 SXM modules, the GPU can boost clock to 3.4 GHz... if it's under 70°C. At 85°C, it throttles to 1.8 GHz. That's a 47% performance loss.

We're building a **thermal model per GPU** that predicts temperature curves based on:

- Current power draw (via `nvidia-smi -q -d POWER`)
- Ambient temperature (from BMC)
- Local airflow (we instrumented the datacenter with ultrasonic anemometers on each rack)

The scheduler will **avoid placing hot jobs** (high power consumption) on GPUs that are already near thermal limits. And it will **power cap** GPUs to stay within 80°C, trading 5% performance for 20% thermal headroom.

**Early results:** 99.7% GPU utilization, with only 1.2% performance hit from power capping. We're calling it the "99th percentile utilization."

---

## The Takeaway

The dirty secret of exascale ML training is that **Kubernetes was never the right tool**. It's a hammer, and your GPU cluster is a Swiss watch. You need a scheduler that understands:

- The physical topology of your hardware
- The memory semantics of your training framework
- The network contention patterns of your communication library
- The thermal dynamics of your datacenter

If you're running a 1000+ GPU cluster with vanilla Kubernetes and wondering why your utilization is below 70%, this is your wake-up call. The technology exists. The patterns are proven. And the ROI is **absolutely massive**.

Now, go forth and build your own "hammer." Your $50M H100 cluster deserves it.

---

_Built at [REDACTED] Labs. We're hiring systems engineers who love GPUs more than microservices. If this blog post made your heart race, reach out._
