---
title: "The Great Unbundling: Why Kubernetes Is Eating Bare-Metal GPU Orchestration (And What It Means for Foundation Model Training)"
shortTitle: "Kubernetes Unbundles Bare-Metal GPU Orchestration"
date: 2026-09-09
image: "/images/2026/09/09/the-great-unbundling-why-kubernetes-is-eating-bare-metal-gpu.svg"
---

You're staring at a **10,000-node GPU cluster**, and it's staring back at you. Not with blinking LEDs, but with a deafening silence—the silence of idle H100s waiting for a scheduler that’s currently spending more time negotiating with the API server than actually dispatching pods. Sound familiar?

If you’ve been in the MLOps trenches for the last eighteen months, you know the drill. The hype cycle for "AI Infrastructure" hit escape velocity, and suddenly every blog post is about training a 70B parameter model. But beneath the jargon, there’s a tectonic shift happening in the compute layer. We aren’t just scaling up; we are witnessing a **convergence**—a messy, beautiful, and highly technical merger between the ephemeral, containerized world of Kubernetes and the iron-fisted, low-latency requirements of bare-metal GPU orchestration.

This isn’t about "running PyTorch in a pod." That was 2022. This is about re-architecting the control plane to treat a **GB200 NVL72 rack** or an **H200 node** not as a server, but as a _single, indivisible scheduling primitive_—and then asking a system designed for stateless web services to handle it without breaking a sweat.

Let’s pop the hood on the evolution of cluster scheduling. We’re going to look at why the industry hit a wall with traditional schedulers, why the "bare-metal revival" isn’t a step backward, and how the bleeding edge of Kubernetes (K8s) is morphing into something that looks suspiciously like a High-Performance Computing (HPC) workload manager—but with better YAML.

---

## The Tipping Point: When "Good Enough" Scheduling Became a Nightmare

To understand where we are, we have to look at the failure modes of the past. For years, the standard stack was **Kubernetes + Custom Resource Definitions (CRDs) + a GPU device plugin**. It worked beautifully for inference and fine-tuning. You request a pod, the kubelet sees a `nvidia.com/gpu` resource, assigns an index, and you’re off to the races.

Then, Foundation Model training hit the scene. Specifically, **SuperPod-style training**—think massive synchronous data-parallel training with ZeRO-3 or Tensor Parallelism. Here’s where the illusion breaks:

1.  **The Topology Problem:** Kubernetes the scheduler doesn't inherently care _where_ your GPUs are. It cares about _if_ they are available. But training at scale runs on NVLink, InfiniBand, and now Ultra Ethernet. You cannot just randomly pack jobs onto nodes; you need **co-location within a NVSwitch domain** or a specific **fat-tree topology** (e.g., a 400Gb/s leaf-spine) to avoid network contention. Standard schedulers treat "network" as a single block, not as a graph of adjacent switches.
2.  **The Gang Scheduling Deadlock:** If you have a job requiring 512 GPUs, and the scheduler tries to schedule it as 512 individual pods, you get a partial allocation. The first 256 pods start, waiting for the rest to become available. They hold a lock on the GPU memory, but they aren't running anything. Meanwhile, other small jobs are starved. This is the classic _deadlock_ of fragmented scheduling.
3.  **Preemption is a Myth:** In a standard cloud environment, you can kill a pod. In a distributed training environment, killing one rank is _catastrophic_. It triggers a collective communication (NCCL) timeout, which can hang the entire job. So, Kubernetes' killer feature—preemption—becomes its Achilles' heel.

The industry realized that we weren't scheduling _containers_. We were scheduling **rigid, topology-aware, co-scheduled machines** that just _happen_ to run containers.

## The Bare-Metal Mystique: Slaying the Kubernetes Tax

Enter the "Bare-Metal" revival. But wait, we're not talking about going back to `apt-get install python`. We're talking about **Bare-Metal as a control plane philosophy**.

Startups and hyperscalers began building _actual_ "Orchestrators" like **Slurm** or **BCP** (Bare-Metal Control Plane) that talk directly to the hardware via Redfish or IPMI, bypassing the host OS and the kubelet entirely. Why?

- **Perception of Zero Overhead:** The argument is that Kubelet adds a ~200ms latency to pod startup, but more critically, it adds _entropy_. Every log aggregation agent, every network CNI plugin, every CSI driver is a potential point of failure. When you’re running a job for a week, a CNI memory leak at hour 80 is a $500,000 mistake.
- **Binary Precision:** Bare-metal schedulers can flash a machine with a specific firmware version, set the GPU clocks to a specific "locked" frequency, and map the exact PCIe bus addresses _before_ the OS even boots. This is critical for **NVLINK domains spanning multiple physical servers** (like the HGX baseboards). You need the scheduler to ensure that the physical chassis is contiguous.
- **Performance Isolation:** In Kubernetes, you fight for CPU shielding with the OS. In a true bare-metal orchestration model, the scheduler can use _core partitioning_ (like Intel’s PQOS or AMD’s L3 cache controls) to ensure the NCCL threads aren't fighting the metrics exporter for L2 cache lines.

However—and this is the big _however_—bare-metal is **ops hell** for everything _unless_ it’s training. What about the data-loading pipeline? What about the rollout of the training code? What about the sidecar that streams checkpoints to S3? Do you want to SSH into 1000 nodes to fix a Python dependency? No. You need **containers** for the _software_ and **bare-metal semantics** for the _silicon_.

---

## The Kubernetes Rebirth: The Scheduler Takes Steroids

This is where the convergence begins. The Kubernetes community didn't fold. Instead, the api-server is becoming the **central source of truth for hardware**, while the actual _intelligence_ regarding "where" to place things is moving out of the default kube-scheduler.

We are now seeing the rise of **Custom Schedulers** (like Volcano, Kueue, and Google’s GKE Autopilot internals) that don't just look at "free memory" but treat the GPU cluster as a massive, non-blocking silicon fabric.

Here is the architectural shift happening right now:

### 1. From Fine-Grained Pods to "Virtual Clusters"

The most significant evolution is **Multi-Tenancy at the Job Level**. We aren't scheduling pods; we are scheduling **virtual clusters**. Look at a resource request like:

```yaml
apiVersion: kueue.x-k8s.io/v1beta1
kind: ClusterQueue
metadata:
    name: gpu-gang
spec:
    admissionChecks:
        - topology-aware-placement
    namespaceSelector: {}
    resourceGroups:
        - coveredResources: ["nvidia.com/gpu", "memory", "cpu"]
          flavors:
              - name: "dgx-h100"
                resources:
                    - name: "nvidia.com/gpu"
                      nominalQuota: 512
```

This tells the controller, "I don't care about the individual pods yet. I need a quota of 512 GPUs with a specific _topology_ flavor." The scheduler then acts as a **bin-packing oracle**, searching the cluster state for a set of nodes that:

- Are 8 in a rack (maximizing NVSwitch utilization).
- Have the same or newer driver version.
- Are connected via a specific network CIDR to avoid oversubscription.

Only _after_ that physical placement is locked does it admit the `JobSet` and ripple down the pod creations. This is **Gang Scheduling** done right—the quota is held at the _ClusterQueue_ level until the entire allocation is guaranteed.

### 2. Topology-Aware Placement: The NUMA and NIC Problem

Let’s get into the weeds. When you train with **NCCL**, the library is notoriously sensitive to the physical topology. It uses _caps_ (NVLINK) vs _long wires_ (PCIe/IB).

A modern Kubernetes plugin (e.g., the **NVIDIA Topology Manager** or **Kubernetes Aware Scheduling** via the **Kubernetes Topology Manager**) now communicates with the kubelet to ensure memory and CPU affinity.

The convergence here is implementing **HPC-adjacent allocation models** natively in K8s:

- **CPU Manager Policies**: `static` + guaranteed QoS.
- **Device Plugin Extensions**: Exposing `nvidia.com/gpu.nvlink-domain`. A node object now carries metadata that says, "I am node 3 of 8 in an NVLink domain with nodes 1,2,4." The scheduler parses this graph.

Consider this pseudo-code for the scheduler filter:

```go
func (s *GpuScheduler) Filter(ctx context.Context, state *framework.CycleState, pod *v1.Pod, nodeInfo *framework.NodeInfo) *framework.Status {
    // Check if the pod requires a specific GPU gene (e.g., GB200)
    if desiredGene := pod.Labels["gpu.family"]; desiredGene == "h100" {
        // Check if the node is marked as H100 *and* if that node is
        // in a "network pod" with other H100s for the job.
        if nodeInfo.Node().Labels["nvidia.com/gpu.family"] != "h100" {
            return framework.NewStatus(framework.Unschedulable, "wrong gpu")
        }
        if !nodeInfo.Node().Labels["topology.kubernetes.io/zone"] == "rack-03" {
            return framework.NewStatus(framework.Unschedulable, "must be in rack-03")
        }
    }
    return nil
}
```

This is no longer just resource counting; it’s **graph traversal on the datacenter network**.

### 3. Accelerated Networking: Bridging the CNI Gap

If you’ve ever tried running NCCL over a standard Flannel network, you know it’s a pool noodle versus a fiber optic cable. The evolution here is **DPU/BlueField Offload** and **Host-GPU networking convergence**.

We are seeing Kubernetes networking plugins (CNIs) evolve to support **GPUDirect RDMA** natively. The scheduler must ensure that the pod is pinned to a node that has its InfiniBand NIC in the _same PCIe switch_ as its GPU (or via the BlueField pairing). This feature, called **Multi-NIC** or **Peer Direct**, is now an explicit requirement in modern training deployments.

The convergence point? The **Network Topology** is now a first-class citizen in the scheduling decision. You might see hardware resources exposed as:

```yaml
resources:
    limits:
        nvidia.com/gpu: 8
        nvidia.com/gpu.switchid: "switch-carrier-03"
```

The scheduler ensures that if you use `switchid`, all your pods are in the same broadcast domain to avoid adding routing hops.

---

## The Bare-Metal Control Plane: A Temporary Sibling, Not a Parent

So why are some bleeding-edge labs still using **Slurm** or **Kubernetes-on-BareMetal** with **Fluid** or **RuntimeClass** (like `gvisor` not applying here, but using `nvidia` runtimeclass)?

Because there is a **cultural lag** in the HPC community. The researchers want a fire-and-forget job submission (`sbatch`), not a 500-line Helm chart. However, the recent push by NVIDIA with **NVIDIA Cluster Manager** and **Run:AI** has demonstrated a fascinating hybrid: Kubernetes managing the _North-South_ traffic (API calls, log ingestion, data prep) and a **sub-scheduler** managing the _East-West_ data plane (NCCL collectives).

We are seeing **"Node Pre-Baking"** as a service inside K8s. A special `Draining Operator` will:

1.  Cordon the nodes.
2.  (Optional) SSH and disable BIOS power capping.
3.  Install a custom NVIDIA Driver plugin via a DaemonSet.
4.  Set the GPU clocks to max via a custom `nvidia-smi` sidecar.
5.  Resume the node for the K8s scheduler.

This brings back the _feel_ of bare-metal control, but under a scalable reconciliation loop.

### The Curious Case of the "Slow Start"

One of the biggest engineering feats recently has been **fault tolerance in the scheduling loop**. Let’s say you have a 1000-node job. Node 500 fails and triggers a **Topology Restart**.

In the old world, you’d lose the whole job. In the new convergence world, the scheduler uses **checkpointing coupled with topology elasticity**.

The trick here is the "StatefulSet with a Future" mindset. You don't just reschedule a pod; you reschedule a _band_. This requires the scheduler to understand the **JobSet API** and issue a coordinated rolling restart. It’s not just an autoscaler; it’s a **fleet manager** that understands the _handshake_ between the data loading service and the training process.

#### A Glimpse at the "Core Weave" Approach

Core Weave built their infrastructure by abstracting the complexity of **physical geography**.

They treat a "cluster" as a logical region of H100s, but they use a custom **Topology Service** that exposes the _switch hierarchy_ to Kubernetes. They injected annotations like `k8s.coreweave.com/topology-nvlink`.

This allows the platform to bypass the _default_ scheduling algorithm and submit straight to a custom scheduler that runs a bipartite matching algorithm between available GPUs and requested parallel workers. This isn't just an R&D experiment; this is the **production standard** they run for the open-source foundation models.

---

## The Future: Schedulerless Orchestration and the "IO Aware" Push

Where is this heading? We are moving beyond just "compute" scheduling to **storage scheduling**. The next frontier in this evolution is convergence with **exascale storage**.

Training a model on 10TB of datasets requires **checkpointing** to filesystems like **Lustre** or **GPFS** (via CSI drivers). But kernel-level filesystems over TCP are awful for GPU load.

We are now seeing **Kubernetes Scheduler Extenders** that factor in the _distance_ to the data section. If a job needs to read an 8TB checkpoint, the scheduler must ensure the pod lands on a node that has a peta-scale NVMe cache—or it provisions a **LocalCache** pod _before_ launching the training pod.

This gets us into **Pipelined Scheduling**:

1.  **Stage 1:** Schedule the "Data Loader" DaemonSet on all candidate nodes to pre-fetch the checkpoint into local RAM (using `page cache`).
2.  **Stage 2:** Once the cache reports 100% hit ratio, schedule the actual training job.

This is the ultimate convergence of _state_ (K8s) and _iron_ (Bare-Metal storage).

---

## The Verdict: It’s Not Kubernetes vs. Bare-Metal. It’s K8s _with_ a Bare-Metal Heart.

Don’t buy the hype that "Kubernetes is dead" for AI. That is clickbait. Kubernetes is just learning to be **less polite**.

The evolution we’re seeing is analogous to the evolution from the **monolithic kernel** to the **microkernel**. You keep the _scheduling_ loop robust and high-level (K8s API), but you move the _drivers_ into user space (Bare-Metal Agents) for safety and speed.

The future of foundation model training infrastructure is a **Hybrid**. You will have:

- A **Kubernetes API Server** acting as the distributed operating system kernel.
- A **Custom Scheduler** that understands the physical network graph better than the network engineer does.
- **Kubeletlets** (small daemons) that communicate over gRPC with the GPU drivers directly, bypassing the overhead of CRI runtime buffering during the hot path.
- **Bare-Metal Controllers** that can power cycle a node via its out-of-band management interface if the job hits a thermal limit.

The winning stack of tomorrow isn't the one that chooses between YAML and `sbatch`. It’s the one that wraps a gang scheduler around an NVLink domain and lets the Datacenter Runtime Manager (DRM) do what it does best: ensuring those H200s burn white-hot with mathematical computation, never sleeping.

So, the next time you see a scheduling backlog of 2,000 pods all waiting for `nvidia.com/gpu: 8`, don’t curse the complexity. Marvel at it. We are building the control plane for a planet-sized silicon brain, and the orchestrator just got out of college. The debugging is half the fun.

---

_Now, go check your **topology-spread-constraints**, and for the love of all that is sacred, separate your checkpoint broker from your network scheduler._
