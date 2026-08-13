---
title: "From Borg to Behemoths: Why the AI Revolution is Forcing Kubernetes to Relearn Google’s Secret Sauce"
shortTitle: "AI Revolution: Why Kubernetes is Relearning Google’s Borg Principles"
date: 2026-08-13
image: "/images/2026/08/13/from-borg-to-behemoths-why-the-ai-revolution-is-forcing-kube.svg"
---

The year is 2024, and we are witnessing a compute land grab unlike anything in the history of silicon. When we talk about the "AI Race," the conversation usually gravitates toward model parameters, token windows, and H100 allocations. But behind the curtain of every trillion-parameter model is a much more visceral, architectural nightmare: **The Scheduler.**

If you’re trying to coordinate 100,000 GPUs across a heterogeneous fleet of tens of thousands of nodes to train a foundational model, you aren't just "deploying an app." You are performing high-wire choreography where a single millisecond of latency or a misallocated InfiniBand rail can result in a $2 million-per-day cluster sitting idle.

For the last decade, **Kubernetes (K8s)** has been the undisputed king of the data center. But as we push toward **million-node scale** and hyper-specialized AI workloads, we find ourselves looking backward to its progenitor—**Google’s Borg**—to understand how to solve the scaling wall we’re currently hitting.

Let's dive into the technical guts of Borg vs. Kubernetes and explore why the future of AI infrastructure looks surprisingly like a return to the "Big Iron" philosophy of the Googleplex.

---

## The Genesis: Why Borg Still Lives While K8s Conquered the World

To understand the future, we have to acknowledge a dirty secret: **Google still uses Borg.** Despite gifting the world Kubernetes, Google’s internal workloads—Search, Ads, Gmail, and now Gemini—run on a system that is fundamentally more "monolithic" and specialized than the K8s we use in the wild.

### Borg’s Architecture: The "Big Cell" Philosophy

Borg was designed for a specific environment: a massive, relatively homogeneous set of Google-owned data centers where efficiency (bin-packing) is the only metric that matters.

- **The Borgmaster:** A centralized (though replicated) controller that handles everything from the API to the state of the world. It’s a giant, Paxos-based state machine.
- **The Cell:** Borg doesn't think in "clusters" of 5,000 nodes. It thinks in **Cells** of 10,000 to 50,000 nodes.
- **Allocations (Allocs):** Unlike K8s Pods, which are relatively ephemeral, Borg Allocs are reserved resources on a machine that can outlive the tasks running in them.

### Kubernetes: The API for Everyone

Kubernetes was the "de-Googled" version of Borg, redesigned for the rest of us. It swapped Borg’s rigid, performance-first C++ internals for a flexible, API-driven Go architecture.

- **The Controller Pattern:** K8s is built on the philosophy of "reconciliation." The API server doesn't _force_ state; it records a _desired_ state, and controllers work asynchronously to reach it.
- **Extensibility:** This is why K8s won. CRDs (Custom Resource Definitions) allowed the ecosystem to build everything from Service Meshes to Databases on top of K8s.

**The Catch?** That very flexibility and the asynchronous nature of the K8s control plane are exactly what make it struggle when you throw a 50,000-GPU AI training job at it.

---

## The AI Scaling Wall: When 5,000 Nodes Isn't Enough

The standard "limit" for a Kubernetes cluster has historically been around **5,000 nodes**. Beyond that, the heartbeat overhead, the size of the `etcd` database, and the complexity of the networking mesh start to degrade.

But foundational AI training is different. We aren't looking for 5,000 nodes; we are looking at **Million-Node Heterogeneous Fleets.** This involves:

1.  **H100/A100 GPUs** (Compute).
2.  **TPUs** (Google-specific ASICs).
3.  **LPU/DPU/IPUs** (Specialized I/O).
4.  **Complex Interconnects** (InfiniBand, NVLink, RoCE v2).

### The "Gang Scheduling" Problem

In a microservices world (standard K8s), if you deploy 10 replicas of a web server and 9 start while 1 fails, the 9 can still serve traffic.

**In AI training, if you request 1,024 GPUs for a distributed training job and 1,023 are available, you have 0% of a job.**

This is **Gang Scheduling.** You need an "All-or-Nothing" atomic placement.

- **Borg** handles this natively via high-priority preemption and complex "Alloc" reservations.
- **Vanilla K8s** scheduler is "one-pod-at-a-time." It has no inherent concept of a "Job" as a single atomic scheduling unit.

If you try to schedule a 512-node job on K8s without a specialized scheduler (like Volcano or Kueue), the scheduler might fill up the cluster with 200 pods, run out of space, and then sit there in a deadlock while other jobs wait for those 200 pods to do... nothing.

---

## Deep Dive: The Data Plane vs. The Control Plane

To manage a million-node AI workload, we have to re-engineer two specific areas where Borg and Kubernetes diverge significantly.

### 1. The Scheduling Throughput (The "Heartbeat" Problem)

In Kubernetes, the `kubelet` on every node heartbeats back to the API server. At 100,000 nodes, the API server is bombarded with tens of thousands of requests per second just to say "I'm alive."

Borg handles this via **Borglets** and a more hierarchical reporting structure. To reach million-node scale, we are seeing a shift toward **Hierarchical Kubernetes Control Planes.**

Imagine a "Manager of Managers" (Cluster API or specialized Federation) where the top-level scheduler doesn't see "Nodes," but rather "Compute Pools." It delegates the granular placement to "Child Clusters."

### 2. Topology Awareness (The "Physicality" of AI)

Standard schedulers treat a "Node" as a bucket of CPU and RAM. For AI, that is a fatal oversimplification.
Modern training jobs require **Topology-Aware Scheduling**. You need to know:

- Which GPUs share a **PCIe Switch**?
- Which nodes are on the same **L2 Leaf Switch** for InfiniBand?
- What is the **NVLink** topology within the chassis?

If the scheduler places two pods that need to communicate heavily on different racks, the "tail latency" of the network will throttle the entire training run by 40-60%.

**Borg's approach:** Borg uses a system of "constraints" and "preferences" that are deeply integrated into the hardware manifest.
**Kubernetes' evolution:** We are seeing the rise of the **Topology Manager** and the **Node Resource Interface (NRI)**, allowing K8s to finally understand the physical layout of the silicon it’s managing.

---

## The Technical Substance: Why Heterogeneity is the Final Boss

The "Million-Node" dream isn't just about more of the same. It's about **Heterogeneity.** In a single cluster, you might have:

- Older A100 nodes for inference or fine-tuning.
- Cutting-edge H100/H200 nodes for backbone training.
- CPU-heavy nodes for data preprocessing and ETL.

### Resource Bin-Packing vs. Fragmentation

In Borg, the scheduler is an optimization engine. It uses **Score-based scheduling**. It calculates a score for every possible placement based on power consumption, thermal limits, and resource utilization.

Kubernetes is traditionally **Filter-based**.

1. _Filter:_ Can this node fit the pod? (Yes/No)
2. _Score:_ Which of the 'Yes' nodes is best? (Usually based on "Least Requested" or "Most Requested").

When dealing with million-node AI, "Filter-based" scheduling leads to massive **Fragmentation.** You might have 1,000 GPUs free, but they are scattered across 1,000 different nodes, making them useless for a multi-node training job that requires NVLink.

### Enter the "Optimistic" Scheduler

This is where the **Omega** (the successor to Borg) concepts come back into play. Instead of a centralized lock on the cluster state, an optimistic scheduler allows multiple scheduler instances to "guess" at the state of the cluster, attempt a placement, and only conflict if they pick the exact same resource.

To hit AI scale, Kubernetes is moving toward this **Shared-State Scheduling** model.

---

## How to Scale K8s to "Borg-Level" AI Workloads

If you are an engineer tasked with building the next-gen AI cluster, you don't throw K8s away. You "Borg-ify" it. Here is the blueprint currently being used by the biggest players (OpenAI, Anthropic, Meta):

### Step 1: Replace the Default Scheduler

Don't use `kube-scheduler`. It wasn't built for this.

- **Volcano:** An industry-standard for high-performance workloads. It introduces Concepts like `PodGroups` (for Gang Scheduling) and `Queuing`.
- **Kueue:** A cloud-native job queuing controller that manages _when_ a job should be admitted to the cluster based on quota and resource availability.

### Step 2: Custom Resource Definitions (CRDs) for Training

Use operators like the **Kubeflow Training Operator**. It abstracts the "Job" away from individual pods. It handles the lifecycle of the Master and Worker nodes, ensuring that if one worker dies, the entire gang is handled appropriately.

### Step 3: Optimization of the Networking Stack

At million-node scale, the standard `iptables` or `IPVS` modes of Kube-Proxy fall over.

- **eBPF (Cilium):** High-performance networking that bypasses the Linux kernel's bottlenecked networking stack. For AI, you need **GPUDirect RDMA** support, allowing GPUs on different nodes to talk to each other's memory without involving the CPU.

### Code Snippet: A Specialized AI Job Spec

Notice how this differs from a standard deployment. We are defining a "Gang" of resources with specific constraints.

```yaml
apiVersion: scheduling.volcano.sh/v1beta1
kind: PodGroup
metadata:
    name: llama3-70b-training
spec:
    minMember: 512 # Gang scheduling: All 512 must be ready
    queue: high-priority-training
---
apiVersion: kubeflow.org/v1
kind: PyTorchJob
metadata:
    name: llama3-70b-training
spec:
    pytorchReplicaSpecs:
        Worker:
            replicas: 512
            template:
                spec:
                    schedulerName: volcano # Bypassing the default scheduler
                    containers:
                        - name: pytorch
                          image: nvidia/pytorch:24.01
                          resources:
                              limits:
                                  nvidia.com/gpu: 8
                                  rdma/hca: 1 # Requesting RDMA/InfiniBand interface
                          volumeMounts:
                              - name: dataset
                                mountPath: /data
                    affinity:
                        nodeAffinity:
                            requiredDuringSchedulingIgnoredDuringExecution:
                                nodeSelectorTerms:
                                    - matchExpressions:
                                          - key: feature.node.kubernetes.io/pci-10de.present
                                            operator: In
                                            values: ["true"] # Ensuring H100 presence
```

---

## The Verdict: Convergence is Inevitable

The debate isn't "Borg vs. Kubernetes" anymore. It's about the **convergence of their philosophies.**

The AI revolution has proven that the "commodity hardware" dream of early cloud computing—where every node is a replaceable worker bee—is over for high-end R&D. We are back to a world where the **Hardware-Software Interface** matters.

**Borg** taught us how to manage massive, high-utilization fleets with ruthless efficiency.
**Kubernetes** taught us how to build a flexible, multi-vendor ecosystem that anyone can use.

The million-node AI clusters of 2025 and beyond will run a version of Kubernetes that looks very different from the one we use for web apps. It will be a system characterized by:

- **Centralized Resource Queuing** (Borg-style).
- **Hardware-Aware Placement** (Topology-first).
- **Decoupled Control Planes** (To break the 5,000-node barrier).

We are essentially rebuilding Borg on top of the Kubernetes API. It’s the best of both worlds: the raw, unbridled power of Google-scale infrastructure with the open-source governance that ensures no single company holds the keys to the AI kingdom.

If you’re an infrastructure engineer, now is the time to look deep into the Linux kernel, understand the nuances of RoCE v2, and start thinking of your cluster not as a collection of nodes, but as a **single, massive, distributed supercomputer.**

The scheduler is no longer just a background process—it is the brain of the AI factory. And that brain is getting a massive upgrade.
