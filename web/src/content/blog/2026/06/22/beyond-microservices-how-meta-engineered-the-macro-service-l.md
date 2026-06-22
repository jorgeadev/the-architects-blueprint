---
title: "Beyond Microservices: How Meta Engineered the Macro-Service Layer for Sub-Millisecond RPCs"
shortTitle: "Meta's Macro-Service Layer for Sub-Millisecond RPCs"
date: 2026-06-22
image: "/images/2026/06/22/beyond-microservices-how-meta-engineered-the-macro-service-l.jpg"
---

For the last decade, the industry gospel was simple: **If it’s big, break it up.** We were told that microservices would solve our scaling woes, decouple our teams, and allow us to deploy at the speed of thought. And for a while, it worked. But as organizations scaled to the size of Meta, a dark reality emerged. The "distributed monolith" became a nightmare of network hops, serialization overhead, and tail-latency cascades that threatened the very responsiveness of the world's largest social graph.

If you’ve been following the recent industry chatter—the "Return to Monolith" articles from Amazon Prime Video or the "De-microservices" movements at high-growth startups—you might think we’re heading back to 2005. You’d be wrong.

At Meta, we aren't retreating to the monolithic graveyard. Instead, we are pioneering the **Macro-Service Layer**. This is a radical re-engineering of how compute is organized, moving away from fragmented, network-bound microservices toward highly-cohesive, high-performance "macro-services" that leverage **sub-millisecond RPC orchestration** and zero-copy memory semantics.

This isn't just about making things faster; it’s about fundamentally changing the physics of the data center. Here is the deep dive into how Meta is engineering the post-microservices era.

---

## The Microservices Hangover: The 100ms Tax

To understand the shift, we have to look at the cost of the status quo. In a classic microservices architecture, a single user request—say, loading your Facebook News Feed—might trigger hundreds or even thousands of internal RPC (Remote Procedure Call) requests.

Each RPC involves a brutal sequence of events:

1.  **Serialization:** Converting an in-memory object (C++, Python, or Hack) into a wire format (Thrift or Protobuf).
2.  **Kernel Context Switching:** Moving data from user space to kernel space.
3.  **Network Traversal:** Pushing bits through a NIC, across a leaf-spine fabric, and into another rack.
4.  **Deserialization:** Reconstituting the object on the other side.

When your "News Feed Service" calls the "Ranking Service," which calls the "User Profile Service," which calls the "Privacy Service," these milliseconds add up. At Meta's scale, we found that **up to 30% of our total CPU fleet capacity was being spent just on serialization and network stack processing.** We weren't just running code; we were paying a massive "infrastructure tax" to keep our services talking to each other.

Furthermore, the "p99.9" (the 99.9th percentile latency) became impossible to manage. If one minor microservice in a chain of twenty had a GC (Garbage Collection) pause or a network blip, the entire user request would hang.

---

## Defining the Macro-Service: The Logical Monolith, Physical Flexibility

The **Macro-Service Layer** is a hybrid architectural pattern. It retains the developer experience of microservices—independent codebases, clear ownership, and modularity—but changes the **runtime execution model**.

Instead of deploying twenty small services into twenty different containers across the data center, we are moving toward **Service Consolidation**. We group highly interdependent services into a single process or a single "Logical Macro-Service" that shares an address space or uses ultra-optimized local transport.

### The Core Philosophies:

- **High Cohesion, Low Latency:** If two services exchange more than a certain threshold of data, they belong in the same "Macro-cluster."
- **Shared-Memory RPCs:** When services coexist on the same hardware, we bypass the network stack entirely.
- **Binary Consolidation:** Using advanced linking and build systems (like Buck2) to merge separate service binaries into a unified execution unit without merging the actual source code repositories.

---

## Engineering Sub-Millisecond RPCs: The "Local-First" Transport

The heart of this architecture is a reimagined RPC layer. At Meta, we use **fbthrift** (an evolution of Apache Thrift). To enable the macro-service layer, we engineered a "Short-Circuit" transport mechanism.

### The "In-Process" Short Circuit

When a Macro-Service calls a sub-module that happens to be linked into its own binary, fbthrift detects this at the transport layer. Instead of serializing the data to a buffer, it performs a **Pointer Handover**.

```cpp
// Traditional RPC (Slow)
auto response = client->future_getProfile(userId).get();

// Macro-Service In-Process RPC (Sub-microsecond)
// The framework detects 'Target' is local.
// It simply passes a std::shared_ptr or folly::IOBuf across the boundary.
auto response = local_provider->getProfile(userId);
```

By using **`folly::IOBuf`** (a powerful buffer management utility in the Folly library), we can pass data between modules with zero copies. The "serialization tax" effectively drops to zero.

### The Shm-RPC (Shared Memory)

For services that must remain in separate processes (perhaps for fault isolation or different resource limits) but live on the same physical host, we use **Shared Memory RPC**.

Using a ring-buffer implementation in shared memory, Service A can write a request and Service B can read it without a single `send()` or `recv()` system call. We use **eBPF** to monitor these local connections and dynamically re-route traffic from the NIC to the shared-memory segment if the scheduler places the containers on the same node.

---

## The Infrastructure Secret Sauce: Hardware-Software Co-Design

You can't achieve sub-millisecond orchestration with software alone. Meta's macro-service strategy is deeply integrated with our custom hardware designs (OCP - Open Compute Project).

### NUMA-Aware Scheduling

Modern servers are not "flat." They have multiple CPU sockets, each with its own local memory (NUMA nodes). If a Macro-Service is running on Socket 0, but its data is in memory attached to Socket 1, you hit a "QPI/UPI hop" that adds nanoseconds of latency.

Our internal cluster orchestrator, **Tupperware**, was upgraded to be **NUMA-aware**. It doesn't just look for "a server with 4GB RAM"; it looks for "a server where the Macro-Service and its high-bandwidth sidecars can be pinned to the same NUMA node." This hardware-level affinity ensures that the L3 cache stays warm and memory latency remains deterministic.

### The Role of eBPF and XDP

Even when we must go "over the wire," we use **XDP (eXpress Data Path)**. XDP allows us to intercept incoming RPC packets directly at the NIC driver level, before they even reach the Linux networking stack.

By running eBPF programs in the kernel, we can perform "Packet Steering." If an incoming RPC is destined for a specific thread in our Macro-Service, the eBPF program can ensure the packet is delivered directly to the CPU core where that thread is currently running. This minimizes **cache misses** and **Inter-Processor Interrupts (IPIs)**, which are the silent killers of sub-millisecond performance.

---

## Managing the Monolith: Build Systems and Buck2

One of the biggest fears of "Macro-services" is the "Giant Binary Problem." If you link fifty services together, you get a 5GB binary that takes 20 minutes to load and 2 hours to compile.

To solve this, Meta leaned into **Buck2**, our open-source recursive build system. Buck2 allows us to treat the entire Meta codebase as a giant graph of dependencies.

- **Incremental Linking:** We use advanced linkers (like `lld`) and "ThinLTO" (Link Time Optimization) to ensure that even a massive macro-service binary only re-links the specific object files that changed.
- **Dynamic Loading of Modules:** Not every part of a Macro-Service needs to be statically linked. We use a "Plugin" architecture where secondary modules are loaded as shared libraries (`.so` files) on demand, allowing us to update specific business logic without restarting the entire "Macro-host."

---

## The Hype vs. The Reality: Why "Return to Monolith" is a Misnomer

The tech world went into a frenzy when Amazon Prime Video published their blog post about moving from Step Functions/Lambda to a monolith. Critics claimed this was the "death of microservices."

At Meta, we view this differently. It’s not about Monolith vs. Microservices. It’s about **Granularity vs. Efficiency**.

The "Hype" suggests we should go back to a single repo and a single deployment. The "Reality" we've built is much more sophisticated:

1.  **Developer Independence:** Engineers still work in modular codebases. They own their "service."
2.  **Logical Decoupling:** API contracts (Thrift definitions) are still strictly enforced. You can't just "reach into" another module's memory.
3.  **Physical Coupling:** At _runtime_, we choose to pack these modules together to win back the 30% CPU tax.

We call this **"Context-Aware Deployment."** In a dev environment, your service might run as a standalone microservice for ease of debugging. In production, it’s automatically "absorbed" into a Macro-Service layer for maximum performance.

---

## The Observability Challenge: Seeing Inside the Macro-Service

When you move from network-based microservices to in-process macro-services, traditional observability tools (like Zipkin or Jaeger) often break. Why? Because they rely on intercepting network traffic.

If Service A calls Service B via a pointer handover, there's no "packet" for a sniffer to catch.

To solve this, Meta built **Canopy**, our end-to-end performance tracing infrastructure. Canopy uses **Header Injection** at the code-generation level. When the fbthrift compiler generates the code for an in-process call, it automatically inserts "Logical Spans."

These spans use **Thread-Local Storage (TLS)** to pass trace IDs. Even if no network call occurs, the system records the entry and exit of every module. We can see, with microsecond precision, exactly how much time was spent in the "Ranking Module" versus the "Filtering Module," all within the same process.

---

## Complexity at the Edge: The Global Traffic Manager

Orchestrating these macro-services globally requires a rethink of load balancing. We use a system called **Cartographer**.

Cartographer doesn't just look at CPU load; it looks at **"Service Affinity."** If Cartographer notices that a Macro-Service in our Oregon (PRN) data center is frequently calling a specific database shard in Sweden (LLN), it will attempt to "migrate" the Macro-Service logic or the data to minimize cross-region tail latency.

With sub-millisecond RPCs, the bottleneck is no longer the local CPU—it’s the speed of light between data centers. The Macro-Service layer allows us to be much more aggressive with **Request Hedging**. Since the local call overhead is so low, we can afford to fire off three parallel "speculative" requests to different modules and simply take the fastest result, discarding the others. This is the secret to Meta's "instant" feeling, even on slow mobile connections.

---

## Lessons for the Industry: Should You Build a Macro-Service?

Meta’s engineering of the Macro-Service layer is a response to **extreme scale**. You might ask: "Does my 50-person engineering team need this?"

Probably not—yet. But the principles are universal:

1.  **Stop treating the network as free.** Every RPC has a cost in serialization and latency.
2.  **Prioritize Cohesion.** If Service A and Service B always scale together and talk constantly, they shouldn't be separated by a network.
3.  **Invest in Tooling over Architecture.** Don't change your code to a monolith; change your _build and deployment system_ to allow for consolidated runtimes.

The "Post-Microservices" era isn't about moving backward. It’s about moving toward an architecture that is **mechanically sympathetic**—one that respects the CPU, the cache, and the memory bus.

By engineering the Macro-Service Layer, Meta has proven that you can have your cake (modular development) and eat it too (monolithic performance). We are entering a world where the "service" is a logical concept, but the "execution" is a highly-tuned, sub-millisecond symphony of hardware and software co-design.

**The network is no longer the computer. The address space is.**
