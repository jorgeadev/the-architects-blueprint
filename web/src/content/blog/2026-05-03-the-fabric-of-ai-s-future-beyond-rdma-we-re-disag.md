---
title: "The Fabric of AI's Future: Beyond RDMA, We're Disaggregating Memory and Compute with CXL and Gen-Z"
shortTitle: "Disaggregating AI Memory and Compute with CXL/Gen-Z"
date: 2026-05-03
image: "/images/2026-05-03-the-fabric-of-ai-s-future-beyond-rdma-we-re-disag.jpg"
---

The future of Artificial Intelligence isn't just about faster chips or bigger models; it's about fundamentally rethinking the silicon and data pathways that bind them. For years, we've battled the tyranny of tightly coupled memory and compute, a relentless force that now threatens to cap the exponential growth of hyperscale AI. We've pushed the limits of PCIe, optimized RDMA to near perfection for network-attached storage, but when it comes to true _memory_ disaggregation and composable systems for AI, we're staring down a chasm.

Imagine a world where your GPUs aren't shackled by their onboard HBM, where CPUs can dynamically provision terabytes of memory on the fly, where a cluster of specialized AI accelerators can share a coherent memory pool as if it were local. This isn't science fiction anymore. We're on the precipice of a revolution, driven by two titans of fabric technology: **CXL (Compute Express Link)** and **Gen-Z**.

At our scale, building and deploying cutting-edge AI models – from colossal Large Language Models (LLMs) to intricate Diffusion Models and beyond – means confronting bottlenecks that simple scaling can no longer solve. We're talking about models with trillions of parameters, datasets spanning petabytes, and training runs that demand thousands of GPUs and custom accelerators. The sheer economics and physics of moving data are breaking our traditional datacenter architectures. The question is no longer _if_ we need disaggregation, but _how_ we achieve it coherently, performantly, and at scale.

This isn't just hype. This is a deep dive into the engineering realities, the architectural shifts, and the profound potential of CXL and Gen-Z as they redefine the very fabric of hyperscale AI. Get ready to explore the future where memory is a fluid resource, and compute is infinitely composable.

---

## The Looming Crisis: Why Current Architectures Can't Keep Up with Hyperscale AI

Let's start with the elephant in the room: **memory and I/O bottlenecks**.

For decades, Moore's Law generously provided us with ever-increasing compute power. But memory bandwidth and latency, along with the interconnects that shuttle data, haven't kept pace. In the world of AI, where models are growing exponentially and data sets are gargantuan, this "memory wall" is becoming a brick wall.

### The GPU Memory Problem

Modern GPUs, the workhorses of AI, are marvels of parallel processing. But even with incredible High Bandwidth Memory (HBM), they are still fundamentally limited by:

- **Fixed Capacity:** A GPU's HBM is an immovable, fixed resource. Want to train a model that's larger than your 80GB, 128GB, or even 192GB of HBM? You're forced into complex and often inefficient multi-GPU, multi-node parallelism strategies like model parallelism, expert parallelism, or offloading to CPU memory, incurring significant latency penalties over PCIe.
- **Limited Bandwidth Beyond Local:** While HBM offers immense local bandwidth, moving data _between_ GPUs or _from_ CPU memory over PCIe is a relative crawl. PCIe Gen5 might offer 128 GB/s bi-directional, but that's shared among all devices and pales in comparison to the terabytes/second of HBM.
- **Underutilization:** If your model can fit on a smaller GPU, or if parts of your model aren't always active, a substantial portion of the HBM might sit idle, yet it's an expensive, power-hungry resource.

### PCIe: The Ubiquitous Bottleneck

PCIe has served us well as a general-purpose interconnect for peripherals. But it was never designed for coherent memory sharing or large-scale composability across racks.

- **CPU-Centricity:** PCIe operates under the assumption that the CPU is the master, orchestrating all memory accesses. Accelerators are generally treated as subordinate devices.
- **Lack of Coherence:** PCIe, by itself, does not natively support cache coherence between devices. If a GPU wants to access data in CPU memory, it often has to explicitly invalidate/flush its own caches and then read from main memory, adding overhead and complexity.
- **Scaling Limits:** While we can build complex tree and mesh topologies with PCIe switches, the address space management, routing complexity, and cumulative latency make true rack-scale disaggregation impractical.

### RDMA: A Partial Solution, But Not for Memory

**Remote Direct Memory Access (RDMA)** has been a game-changer for high-performance networking and storage. It allows a NIC to directly access memory on a remote machine, bypassing the CPU, OS kernel, and their associated overheads. This dramatically reduces latency and increases throughput for data transfers.

**Why RDMA isn't the whole answer for memory disaggregation:**

- **Block-level Transfers:** RDMA is fantastic for moving blocks of data (e.g., entire tensor, database page). It's not designed for byte-addressable, cache-coherent memory semantics.
- **No Cache Coherence:** RDMA doesn't natively maintain cache coherence between the source and destination. If a CPU in one node modifies a memory region, and a GPU in another node tries to RDMA read that region, there's no automatic mechanism to ensure the GPU gets the latest cached version. You're responsible for cache flushing and synchronization, which adds complexity and latency.
- **Driver & Software Overhead:** While RDMA bypasses some kernel layers, it still requires setup and teardown of queue pairs and memory registrations, which can introduce overhead for fine-grained memory operations.
- **Protocol Differences:** RDMA works over network protocols like RoCE (RDMA over Converged Ethernet) or InfiniBand. True memory disaggregation requires a different kind of fabric, one that understands memory semantics at a fundamental level.

In essence, RDMA is like a super-fast forklift for moving containers of data. But for AI, we often need to manipulate individual items within those containers, sometimes simultaneously from different locations, all while ensuring everyone sees the most up-to-date version. That's where we need something more profound.

---

## The Holy Grail: Disaggregated and Composable Infrastructure for AI

The vision is simple yet revolutionary: **decouple compute, memory, and storage** into independent, pooled resources that can be dynamically composed and reconfigured on demand.

### Why Disaggregation is the Key to Hyperscale AI:

1.  **Memory Pooling:** Instead of fixed memory on each compute node or GPU, imagine a vast pool of memory (DRAM, Persistent Memory, CXL attached memory) accessible by any CPU or accelerator.
    - **Elasticity:** Dynamically provision memory for massive models or bursting workloads.
    - **Efficiency:** Reduce idle memory. If one GPU needs 200GB for a sparse model, and another needs 10GB, they can draw from the same pool.
    - **Cost Savings:** No need to overprovision memory on every single server or accelerator.
2.  **Resource Flexibility:** Mix and match compute (CPUs, GPUs, TPUs, custom ASICs), memory, and storage according to the specific demands of a job.
    - A job might need 10 CPUs, 4 GPUs, and 1TB of pooled CXL memory for pre-processing, then scale to 100 GPUs and 5TB for training, and finally down to 2 GPUs and 50GB for inference.
    - No more buying fixed configurations.
3.  **Improved Utilization:** Increase the overall utilization of expensive accelerators and memory. When a GPU finishes a task, its attached memory isn't wasted; it can be immediately reallocated.
4.  **Simplified Management:** A truly composable infrastructure simplifies resource management, provisioning, and scaling, reducing operational overhead.
5.  **Future-Proofing:** Easily integrate new generations of CPUs, GPUs, and memory technologies without needing to rip and replace entire systems.

This is where CXL and Gen-Z step onto the stage, not as mere interconnects, but as the foundational protocols for this new era.

---

## CXL: Bringing Coherence to the Edge of the CPU

**Compute Express Link (CXL)** emerged as an open industry standard built on top of the physical and electrical interface of PCIe. But don't let that fool you; it's a completely different beast, designed from the ground up to enable CPU-accelerator and CPU-memory coherence. It addresses the fundamental problem of how CPUs and accelerators can efficiently share memory with each other.

### The Genesis of CXL

Driven largely by Intel and then adopted by a broad consortium (including AMD, NVIDIA, Microsoft, Google, Meta, and many others), CXL was born out of the necessity to break free from the CPU-centric PCIe model. As specialized accelerators (like GPUs, DPUs, FPGAs, NPUs) became indispensable, the need for these devices to coherently access and share the CPU's memory, and even have their _own_ memory become part of the system's memory map, became paramount.

### The Three Flavors of CXL: A Symphony of Coherence

CXL isn't a monolithic protocol; it intelligently layers capabilities to suit different needs:

1.  **CXL.io (Type 1): The Foundation**
    - This is essentially PCIe, providing compatibility with existing PCIe devices and infrastructure. It handles device discovery, configuration, and standard I/O semantics.
    - Think of it as the "transport layer" for the other CXL types. Any CXL device will implement CXL.io.
    - **Relevance for AI:** Allows existing PCIe devices to coexist in a CXL fabric, making the transition smoother.

2.  **CXL.cache (Type 2): The Accelerator's Best Friend**
    - This is where things get exciting for accelerators like GPUs and AI ASICs. CXL.cache enables an accelerator to coherently snoop and cache CPU memory.
    - **How it Works:** The CXL.cache protocol ensures that if an accelerator reads data from CPU memory, it can cache that data locally. If the CPU then modifies that data, the CXL fabric mechanism will invalidate the accelerator's cache line, forcing it to fetch the updated version. This is the holy grail for reducing data movement overhead and maintaining data integrity.
    - **Use Cases for AI:**
        - **Zero-Copy Operations:** Accelerators can directly access CPU memory without costly DMA transfers and manual cache flushes.
        - **Shared Data Structures:** Multiple accelerators or CPUs can work on the same data structures (e.g., model weights, feature vectors) in memory without complex synchronization logic.
        - **Pooling and Tiering:** While CXL.cache focuses on accelerator caching _of CPU memory_, it sets the stage for more advanced memory pooling.

3.  **CXL.mem (Type 3): Unlocking Memory Disaggregation**
    - This is the true enabler for memory expansion, pooling, and tiering. CXL.mem allows CXL-attached memory devices to be treated as _system memory_ by the CPU, coherently.
    - **How it Works:** A CXL.mem device (e.g., a CXL-attached DRAM module or a memory pooling appliance) presents its memory as host-managed device memory. The CPU's memory controller understands how to access this memory and, crucially, how to maintain cache coherence across it.
    - **Use Cases for AI:**
        - **Memory Expansion:** Overcome physical DIMM slot limitations. Add hundreds of gigabytes or even terabytes of memory to a server without changing the motherboard.
        - **Memory Pooling:** Create shared pools of memory accessible by multiple CPUs or accelerators across a CXL switch. This is critical for large AI models that can't fit on a single GPU or even a single server's local memory.
        - **Memory Tiering:** Implement intelligent memory hierarchies, placing frequently accessed data in faster, closer memory (e.g., HBM or local DRAM) and less frequently accessed data in larger, potentially cheaper, CXL-attached memory.
        - **Persistent Memory:** CXL can also connect persistent memory (like NVMe-oF, Optane alternatives) as byte-addressable system memory, offering entirely new durability paradigms for AI workloads.

### CXL Fabric Topologies for AI

With CXL switches, we move beyond simple point-to-point connections:

- **Memory Expanders:** Simplest form, direct connection to a CPU, expanding local memory.
- **Memory Pooling:** A CXL switch connects multiple CPUs/GPUs to a shared pool of CXL memory devices. Think of a bank of disaggregated DRAM accessible by any compute element.
- **Multi-Headed Memory:** A CXL memory device can be accessed by multiple hosts simultaneously, enabling truly shared global memory.
- **Tiered Memory Architectures:** A sophisticated memory controller might manage local DRAM, CXL-attached DRAM, and CXL-attached persistent memory, presenting a unified, tiered memory space to the OS.

The promise of CXL is immense: democratizing memory, making it a fluid resource, and enabling coherent communication between disparate compute elements. This means larger models can be trained without complex offloading schemes, data can be shared efficiently across accelerators, and overall resource utilization skyrockets.

---

## Gen-Z: The Memory-Semantic Fabric Unleashed

While CXL brought coherence to the CPU's memory domain, **Gen-Z** approaches disaggregation from a fabric-first perspective. It's an open, memory-semantic, peer-to-peer interconnect designed to connect diverse components – CPUs, memory, accelerators, storage – over a high-performance, low-latency switched fabric. Gen-Z aims to abstract away the underlying physical connections, creating a truly composable system.

### The Genesis of Gen-Z

Born from a consortium including AMD, Dell EMC, HPE, IBM, and others (many of whom are also in CXL), Gen-Z sought to create a universal fabric for memory and I/O. Unlike CXL, which builds on PCIe, Gen-Z defines its own elegant, lightweight, packet-based protocol optimized for memory semantics.

### Key Design Principles: Memory-Semantic, Packet-Based, Peer-to-Peer

1.  **Memory Semantic:** This is crucial. Gen-Z understands memory operations (read, write, atomic operations) at its core. It's not just moving data; it's moving memory requests and responses.
2.  **Packet-Based Protocol:** All communication in Gen-Z happens via packets. This allows for flexible routing, multi-pathing, and efficient use of the fabric.
3.  **Low Latency, High Bandwidth:** Designed for nanosecond-level latencies across the fabric, Gen-Z aims to make remote memory access feel as close to local as possible.
4.  **Peer-to-Peer:** Any Gen-Z device can initiate transactions with any other Gen-Z device, without necessarily needing a CPU as an intermediary. This is vital for true disaggregation and accelerator-to-accelerator communication.
5.  **Not Inherently Cache Coherent (But Can Be):** Unlike CXL which _mandates_ coherence, Gen-Z's base protocol doesn't enforce it. However, it provides the mechanisms and hooks (like "memory objects") to _enable_ cache coherence if implemented by higher-level protocols or devices. This flexibility allows for simpler, faster, non-coherent access when coherence isn't needed (e.g., raw data transfers) and more complex coherent mechanisms when required.

### Gen-Z Fabric Topologies for Hyperscale AI

Gen-Z's switched fabric model allows for incredibly flexible and dynamic topologies:

- **Rack-Scale Memory Pooling:** A single rack (or multiple racks) can host a massive pool of Gen-Z attached DRAM modules, accessible by any CPU or GPU in the rack.
- **Heterogeneous Accelerator Fabrics:** Connect multiple types of accelerators (GPUs, TPUs, custom inference ASICs) via a Gen-Z fabric, allowing them to share memory pools and communicate directly with each other at ultra-low latencies.
- **Disaggregated Storage:** Connect NVMe-oF devices or even advanced computational storage drives directly into the fabric, presenting them as memory-semantic resources.
- **Bridging to Other Interconnects:** Gen-Z bridges can connect to other protocols (like CXL, InfiniBand, Ethernet), allowing it to act as a universal backbone.

### Gen-Z for Disaggregated AI: The Vision

- **Global Address Space:** Imagine a unified, global memory address space spanning multiple nodes, accessible by any compute element. Gen-Z provides the foundation for this.
- **Dynamic Resource Composition:** Spin up an AI training job, and the Gen-Z fabric dynamically provisions 16 GPUs, 2 CPUs, 400GB of shared DRAM, and a direct link to a petabyte of NVMe storage. When the job is done, the resources are released back to the pool.
- **Ultra-Low Latency Communication:** Critical for synchronous model parallelism or parameter server architectures, where fast updates across a distributed model are essential.
- **Advanced Memory Types:** Seamlessly integrate DRAM, NVM (non-volatile memory), HBM, and even specialized processing-in-memory (PIM) devices into a unified memory fabric.

---

## CXL vs. Gen-Z: A Symbiotic Future, Not a Zero-Sum Game

This is where the narrative often gets framed as a "competition," but in the hyperscale world, it's more likely a **synergy**.

### Where They Differ:

- **Coherence:** CXL inherently focuses on maintaining cache coherence with the CPU. Gen-Z provides the _mechanism_ for coherence but doesn't mandate it by default, offering more flexibility for non-coherent memory-semantic operations.
- **Starting Point:** CXL starts with PCIe and expands upwards, bringing coherence to an existing ecosystem. Gen-Z defines a new, independent fabric protocol from scratch.
- **Scope:** CXL is primarily focused on CPU-centric memory and accelerator attachment, leveraging existing PCIe infrastructure. Gen-Z is a broader, peer-to-peer fabric designed to connect virtually any component.
- **Adoption:** CXL has seen rapid adoption due to its strong backing by Intel and its integration with existing CPU architectures. Gen-Z has strong industrial backing but is a more fundamental shift.

### Where They Complement Each Other:

The most compelling future for hyperscale AI often involves _both_.

- **CXL over Gen-Z:** Imagine a Gen-Z fabric acting as the rack-scale or datacenter-scale interconnect. CXL devices (CPUs, GPUs, CXL memory expanders) could connect to this Gen-Z fabric via a CXL-to-Gen-Z bridge. This would allow CXL's native CPU-coherent memory semantics to extend across a broader, more flexible Gen-Z fabric. In this scenario, Gen-Z becomes the robust, scalable backbone, while CXL handles the coherent interaction closer to the CPU and its directly attached accelerators.
- **Tiered Memory Hierarchy:** CXL-attached memory might serve as a near-compute, coherent extension of main memory, while a Gen-Z fabric could host a larger, rack-scale pool of slower, potentially non-coherent, memory and storage.
- **CPU-Accelerator Coherence (CXL) + Accelerator-Accelerator & Fabric-Wide Memory Semantics (Gen-Z):** CXL excels at ensuring a CPU and its direct accelerators see a consistent view of memory. Gen-Z excels at connecting disparate accelerators to each other and to large, shared memory/storage pools with low latency across a flexible fabric.

**For hyperscale AI, this means:**

1.  **Local Node Coherence via CXL:** Within a single server, CXL provides the immediate memory expansion and CPU-accelerator coherence for fast local operations.
2.  **Rack-Scale & Beyond Fabric via Gen-Z:** A Gen-Z fabric connects multiple CXL-enabled servers, shared memory pools, and disaggregated storage at ultra-low latency, creating a truly unified resource plane.

---

## Crafting Hyperscale AI Topologies: The Engineering Marvel

Building these systems isn't just about plugging in new cables; it's about sophisticated design.

### The Role of Smart Switches

Both CXL and Gen-Z rely heavily on intelligent switches. These aren't just dumb packet forwarders; they are active components in the fabric:

- **Traffic Management:** Dynamic routing, congestion management, QoS (Quality of Service) to prioritize critical AI workload traffic.
- **Fabric Management:** Discovery of new devices, resource allocation, health monitoring.
- **Security:** Isolation of tenants, encryption, access control.
- **Bridging:** Connecting different domains (e.g., CXL to Gen-Z, Gen-Z to Ethernet/InfiniBand).

### Advanced Topologies

- **Fat-Tree with CXL/Gen-Z:** The familiar fat-tree topology, optimized for minimal hops and high bisection bandwidth, becomes even more powerful when transporting memory-semantic traffic. Every leaf switch can connect to compute nodes, memory pools, and storage arrays.
- **Mesh/Torus Architectures:** For tightly coupled, distributed AI training, these provide redundant, low-latency paths between a large number of compute nodes.
- **Dynamic Reconfiguration:** The ability to literally redraw the topology of your datacenter on the fly. Need more memory attached to a specific GPU array for a few hours? The fabric software provisions it.

### Software is the Key

The hardware is only half the battle. A truly disaggregated infrastructure demands a new generation of software:

- **Fabric OS/Manager:** Orchestrating the discovery, provisioning, and monitoring of resources across the entire fabric.
- **Memory Management Units (MMUs):** Advanced MMUs and IOMMUs within CPUs and accelerators need to understand and manage a global, distributed memory address space.
- **OS & Hypervisor Support:** Linux kernel, Windows, and hypervisors like VMware or KVM need deep integration to present disaggregated memory and compute resources to applications seamlessly.
- **Programming Models:** Developers need new APIs and programming models that abstract the physical location of memory, allowing them to treat disaggregated resources as local. Think of extensions to CUDA, PyTorch, and TensorFlow that are fabric-aware.
- **Security Frameworks:** In a disaggregated world, security becomes even more complex. How do you guarantee isolation and data integrity across a shared fabric? Attestation, encryption at the fabric level, and robust access control are paramount.

---

## The Unseen Engineering Curiosities & Challenges

This vision of a composable, disaggregated future comes with its own set of fascinating engineering challenges:

- **Latency Variability:** While CXL and Gen-Z promise low latency, accessing memory across a fabric will _always_ be slower than local HBM or DDR. Managing and characterizing this latency variability is critical for AI performance. How do we make an application performance-agnostic to whether memory is local, CXL-attached to the same CPU, or CXL-attached over a Gen-Z fabric to a remote CPU?
- **Memory Consistency Models:** In a global, shared memory space, ensuring strong memory consistency (what order memory operations appear to execute in) becomes incredibly complex. Different consistency models have different performance implications, and developers need tools to reason about them.
- **Power and Thermal Management:** A densely packed fabric with numerous memory devices and accelerators generates significant heat and consumes vast amounts of power. Efficient cooling and power delivery systems are non-trivial.
- **Interoperability:** The long-term success of both CXL and Gen-Z hinges on broad industry adoption and seamless interoperability between components from different vendors.
- **Debugging and Observability:** Diagnosing performance bottlenecks or subtle memory consistency issues in a highly disaggregated, distributed system is an order of magnitude harder than in a monolithic server. We need advanced tracing, monitoring, and debugging tools.
- **Security at the Fabric Level:** With data flowing freely across a shared fabric, robust hardware-level security, encryption, and access control become critical. A breach in the fabric could expose vast amounts of sensitive data.

---

## The Road Ahead: Powering the Next Generation of AI

The journey beyond RDMA and towards true memory and compute disaggregation with CXL and Gen-Z is not just an evolutionary step; it's a revolutionary leap for hyperscale AI.

We are moving from a world of fixed, siloed resources to one of fluid, composable infrastructure. This transformation promises:

- **Unprecedented Scale:** Train models that were previously unimaginable due to memory constraints.
- **Unmatched Flexibility:** Dynamically adapt infrastructure to the diverse needs of different AI workloads.
- **Dramatic Efficiency Gains:** Maximize the utilization of every expensive GPU, CPU, and memory module.
- **Future-Proof Innovation:** Easily integrate new hardware innovations without wholesale datacenter overhauls.

At our hyperscale operations, we are actively experimenting, prototyping, and contributing to the standards and software stacks that will bring this vision to life. The challenges are immense, the engineering is complex, but the potential rewards are even greater. The fabric of AI's future is being woven now, byte by byte, packet by packet, and the intelligent machines of tomorrow will run on disaggregated dreams.

This isn't just an upgrade; it's the architectural paradigm shift that will define the next decade of AI innovation. The age of composable, memory-semantic fabrics is here, and we're just getting started.
