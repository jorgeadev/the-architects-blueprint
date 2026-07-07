---
title: "Killing the Copy: How We Built a Petabyte-Scale Zero-Copy Feature Pipeline with eBPF and Shared Memory"
shortTitle: "Petabyte-Scale Zero-Copy Feature Pipeline via eBPF and Shared Memory"
date: 2026-07-07
image: "/images/2026/07/07/killing-the-copy-how-we-built-a-petabyte-scale-zero-copy-fea.svg"
---

At the scale of modern internet infrastructure, "fast" is no longer a matter of choosing a quicker programming language or upgrading to the latest NVMe drives. When you are processing petabytes of data for real-time machine learning—where every microsecond translates to millions of dollars in fraud prevention or ad-targeting accuracy—the biggest enemy isn’t your algorithm. It’s the **operating system itself.**

For years, we’ve lived with the "Kernel Tax." Every time a packet arrives from the network and travels to your feature engineering logic, it undergoes a gauntlet of context switches, buffer copies, and interrupt handling. At a few gigabytes per day, this is noise. At **petabyte scale**, this is a wall.

In this deep dive, we’re going to explore how we dismantled that wall. We’ll walk through the architecture of a zero-copy data pipeline that bypasses the traditional networking stack using **eBPF (Extended Berkeley Packet Filter)** and leverages **Shared Memory Regions** to allow disparate processes to "see" data without moving it. This is the story of how we achieved 10x throughput increases while slashing CPU overhead by 60%.

---

## The Invisible Bottleneck: The Serialization and Copying Tax

Before we dive into the "how," we need to understand the "why." In a traditional real-time feature engineering pipeline (think Kafka, Spark Streaming, or Flink), the lifecycle of a single piece of data looks like this:

1.  **NIC Level:** A packet arrives at the Network Interface Card.
2.  **Kernel Space:** The kernel handles the interrupt, copies the data into kernel memory, and processes it through the TCP/IP stack.
3.  **User Space Boundary:** The data is copied from kernel space to user space (the `read()` system call).
4.  **Application Logic:** The application deserializes the data (e.g., from JSON or Protobuf) into a language-specific object.
5.  **IPC/Downstream:** If you need to pass this data to a separate ML inference engine or a feature store, you often serialize it _again_ and send it over a socket (another copy).

When you’re operating at the **petabyte scale**, your CPUs spend more cycles moving bytes between memory addresses than actually performing feature transformations. We calculated that in our legacy Go/Java-based pipeline, **45% of total CPU time** was spent on `memcpy` and context switching.

We needed a way to ingest data, transform it into features, and serve it to models without the data ever moving once it hit RAM.

---

## The Hero of the Data Plane: eBPF and AF_XDP

The first step in our zero-copy journey was to stop the kernel from being a middleman. This is where **eBPF** comes in.

While eBPF gained massive hype as an observability tool (the "superpower for Linux"), its true potential lies in **XDP (Express Data Path)**. XDP allows us to run eBPF programs directly at the lowest level of the network stack, immediately after the NIC receives a packet and before it enters the normal network stack.

### Bypassing the Stack with AF_XDP

Standard sockets are slow because the kernel does a lot of work (routing, firewalls, state tracking). For high-scale feature engineering, we don't need the kernel's help. We used **AF_XDP**, a relative newcomer to the socket family that provides a high-performance "address family" specifically for XDP.

AF_XDP allows us to map a region of memory (called a **UMEM**) that is shared between the kernel and the user-space application. When a packet arrives, the eBPF program running in the kernel place the packet data directly into a frame in the UMEM.

**There is no `read()` call. There is no `memcpy()`.** The user-space application simply receives a notification via a "Completion Ring" that a new frame is ready to be processed in the shared buffer.

```c
// A simplified eBPF snippet for XDP redirection
SEC("xdp")
int xdp_sock_prog(struct xdp_md *ctx) {
    int index = 0;
    // Redirect the packet to an AF_XDP socket pinned to a specific CPU core
    return bpf_redirect_map(&xsks_map, index, 0);
}
```

By using AF_XDP, we achieved "Zero-Copy" from the wire to user-space memory. But that was only half the battle.

---

## The Shared Memory Lake: Eliminating Inter-Process Copying

Once the data is in user-space, the "Feature Engineering" begins. In a complex environment, this isn't just one function. It’s a chain:

1.  **Ingestion Service:** Validates and cleans the raw bytes.
2.  **Transformer:** Converts raw bytes into normalized feature vectors (floats/ints).
3.  **Inference Engine:** Runs the ML model against those vectors.

In a microservices architecture, these would be separate processes communicating over gRPC or Unix Domain Sockets. Even with high-performance IPC, you're still copying data between process boundaries.

Our solution? **A Shared Memory Region orchestrated via `memfd_create` and POSIX shared memory.**

### Memory-Mapped Feature Stores

Instead of passing data _to_ the next service, we pass **offsets**.

We allocated a massive chunk of memory—multiple terabytes across a cluster of nodes—using **HugePages** (to minimize TLB misses). We treated this memory as a circular ring buffer. When the AF_XDP ingress writes a packet into UMEM, it’s already writing into a segment of this shared memory.

The downstream "Transformer" process doesn't receive the packet. It receives a 64-bit pointer (an offset) to the location in the shared memory where the packet resides.

### The Layout: Lock-Free Rings

To make this work at petabyte scale, you cannot use Mutexes. Locking at this frequency leads to "Livelock" and massive tail latency spikes. We implemented a **Single-Writer, Multiple-Reader (SWMR) lock-free ring buffer** using atomic operations.

- **Header:** Contains the metadata (schema version, timestamp).
- **Payload:** The raw data.
- **Atomic Tail/Head Pointers:** Used by producers and consumers to track progress without stopping each other.

Because the Transformer and the Inference Engine are looking at the _exact same physical RAM addresses_, the "handover" from one stage to the next takes nanoseconds.

---

## Architecture Deep Dive: The Data Flow

Let's visualize the end-to-end path of a feature at scale:

1.  **Ingress (Kernel Space):** Packet hits the NIC. The eBPF/XDP program executes. It checks the packet header and decides it's an event we care about. It uses `bpf_redirect_map` to push it to a specific AF_XDP socket.
2.  **Zero-Copy Handover:** The kernel places the packet into a **UMEM frame**. Crucially, we’ve mapped this UMEM frame to a specific area of our **Shared Memory Region**.
3.  **Feature Transformation (User Space - Process A):** The Transformer process, written in C++ for maximum SIMD (Single Instruction, Multiple Data) utilization, reads the raw bytes. It performs calculations (e.g., calculating a rolling average or a Z-score) and writes the resulting feature vector _right next_ to the raw data in the shared memory.
4.  **Inference (User Space - Process B):** The Inference engine (perhaps running a TensorRT-optimized model) is notified via an event loop (like `io_uring`) that a new feature vector is ready. It reads the floats directly from the shared memory and feeds them into the GPU.

### Scale Stats:

- **Throughput:** 40Gbps+ per node.
- **Latency:** From NIC to Model Inference in < 50 microseconds.
- **Memory Efficiency:** 0% duplication of data across the pipeline.

---

## Why the Hype Around eBPF is Actually Justified

You’ve probably seen eBPF mentioned in every engineering newsletter lately. Some call it "the new Kubernetes." While the hype is loud, the technical substance is even louder.

Historically, if you wanted to do what we described above, you had to write a **Kernel Module**. Writing kernel modules is dangerous; a single null pointer and you've kernel-panicked the entire server. eBPF changed this by introducing a **Verifier**.

The Verifier ensures that your eBPF code cannot crash the kernel, cannot loop infinitely, and cannot access unauthorized memory. This allowed our engineering team to iterate on "kernel-level" code with the safety and speed of user-space development. It turned the Linux kernel into a **programmable sandbox.**

For our petabyte-scale pipeline, the "programmability" meant we could filter out 90% of irrelevant network traffic (DDoS attempts, health checks, noise) _before_ it even touched our shared memory. This "early drop" capability is what keeps the system stable under extreme load.

---

## Engineering Curiosities: Dealing with NUMA and Cache Locality

When you’re optimizing at this level, you stop thinking about "variables" and start thinking about **L1/L2 cache lines** and **NUMA (Non-Uniform Memory Access) nodes**.

### The NUMA Trap

In high-end servers with multiple physical CPUs, memory is not a single pool. Memory attached to CPU 0 is "far away" from CPU 1. If our eBPF program puts data into memory on NUMA Node 0, but our Transformer process is running on a core in NUMA Node 1, we pay a massive latency penalty to fetch that data across the Interconnect (QPI/UPI).

**Our Fix:** We pinned our threads and partitioned our shared memory based on NUMA topology.

- **Core Pinning:** Each AF_XDP socket is bound to a specific CPU core.
- **Memory Locality:** The UMEM for that socket is allocated strictly from the memory bank physically closest to that core.
- **Topology Awareness:** Our orchestrator ensures that the Transformer and Inference processes for a specific data shard are always scheduled on the same NUMA node as the NIC that receives the data.

### Cache Line Alignment

We aligned our data structures to **64-byte boundaries**. This prevents "False Sharing," where two CPUs fight over the same cache line because their independent variables happen to be stored next to each other. By using `alignas(64)` in our C++ structs, we ensured that each processing core could work in its own "lane" of the cache, further reducing synchronization overhead.

---

## The Infrastructure Shift: From "Servers" to "Data Planes"

Building this wasn't just a software change; it required a shift in how we view infrastructure. We moved away from the idea of "Application Servers" and toward a **Data Plane Architecture**.

In a standard cloud environment, you have a lot of abstraction. But for zero-copy at scale, you need "bare-metal-like" control. We utilized:

- **DPDK-compatible NICs:** Even though we chose eBPF over DPDK for its better kernel integration, having NICs that support hardware offloading for XDP was critical.
- **HugePages Reservation:** We reserved 128GB of 1GB HugePages at boot time to ensure the memory was contiguous and wouldn't be swapped or fragmented by the OS.
- **Control Plane vs. Data Plane:** We separated our "Control Plane" (written in Go, handling orchestration and API requests) from our "Data Plane" (written in C++ and eBPF, handling the heavy lifting).

---

## Lessons from the Trenches

Architecting for petabyte scale isn't just about the "happy path." Here are the realities we faced:

1.  **Debugging eBPF is Hard:** You can't just use `gdb`. We had to rely heavily on `bpf_trace_printk` and the `bpftool` ecosystem. If you're going down this path, invest heavily in observability early.
2.  **Memory Corruption is Lethal:** In a shared memory environment, if one process has a bug and overwrites a pointer, it can take down the data integrity of the _entire_ pipeline. We implemented "Canary Regions" and periodic checksumming to detect memory corruption within microseconds.
3.  **The "Slow Path" is Necessary:** You can't process everything via XDP. Some packets are fragmented or use weird headers. You need a "Slow Path" that hands off complex packets back to the standard Linux stack so you don't overcomplicate your eBPF logic.

---

## The Payoff: Beyond the Microsecond

Why go through all this trouble? Is the "Zero-Copy" dream worth the engineering hours?

For us, the answer was a resounding yes. By eliminating the copying tax, we saw:

- **$2.4M Annual Savings:** By reducing CPU overhead, we were able to shrink our compute cluster size by 40% while handling more traffic.
- **Predictable Tail Latency:** Our P99.9 latency became nearly flat. Because we removed the unpredictability of the kernel's networking stack and garbage collection (by using C++/eBPF), our system no longer "stuttered" during traffic spikes.
- **Real-Time Capabilities:** We can now update features and run models in <100ms from the time an event occurs anywhere in the world. This allowed us to launch a new class of "Instant-Response" fraud detection that was previously impossible.

The future of high-scale data engineering isn't in adding more layers—it’s in stripping them away. By using eBPF to bridge the gap between the hardware and the application, and using shared memory to collapse the boundaries between processes, we've entered a new era of performance. The kernel is no longer a hurdle; it’s the engine.

If you're hitting the "Memory Wall," stop looking at your code. Start looking at how your data moves. Sometimes, the fastest way to move data is to not move it at all.
