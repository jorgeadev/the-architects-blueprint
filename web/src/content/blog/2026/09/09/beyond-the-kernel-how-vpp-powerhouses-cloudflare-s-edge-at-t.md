---
title: "Beyond the Kernel: How VPP Powerhouses Cloudflare's Edge at Terabit Scale"
shortTitle: "Scaling Cloudflare Terabit Edge Performance with VPP"
date: 2026-09-09
image: "/images/2026/09/09/beyond-the-kernel-how-vpp-powerhouses-cloudflare-s-edge-at-t.svg"
---

Imagine a tidal wave of data, shifting at the speed of light, crashing against a digital shoreline every single second. At Cloudflare, that shoreline is our global edge network, and the "tidal wave" is the trillions of packets we process daily for millions of customers. When you’re operating at this scale, the traditional methods of handling network traffic aren’t just slow—they are fundamentally broken.

For decades, the Linux kernel has been the gold standard for networking. It’s robust, it’s feature-rich, and it’s the backbone of the internet. But as we pushed our edge servers to handle 100Gbps, 200Gbps, and beyond, we hit a wall. A wall made of context switches, interrupt storms, and cache misses. To break through, we had to move the "brain" of our packet processing out of the kernel and into user space.

Enter **VPP (Vector Packet Processing)**.

In this deep dive, we’re going to peel back the layers of how Cloudflare utilizes FD.io’s VPP to achieve unprecedented throughput, why "vectorizing" packets is the secret sauce of modern high-speed networking, and how we’ve integrated this into a production environment that never sleeps.

---

## The Bottleneck: Why the Kernel Can’t Keep Up

To understand why we moved to VPP, we first have to talk about the **Scalar Processing** model used by the Linux kernel.

When a packet arrives at a Network Interface Card (NIC), the kernel generally handles it one by one. It’s a "scalar" approach:

1.  Interrupt is triggered.
2.  The kernel allocates a metadata structure (`sk_buff`).
3.  The packet is parsed, routed, filtered, and processed.
4.  The `sk_buff` is freed.

At low speeds, this is fine. But at the "Cloudflare scale," this model becomes a nightmare for the CPU's **Instruction Cache (I-cache)**. Each packet must traverse the entire networking stack—IP, TCP/UDP, Netfilter, Routing—before the next packet even begins its journey. By the time the second packet starts, the CPU has likely evicted the instructions needed for the beginning of the stack to make room for the end of the stack. This constant "thrashing" of the I-cache means the CPU spends more time waiting for instructions from memory than actually processing data.

Furthermore, **Context Switching** and **Interrupt Handling** overhead become astronomical. If your CPU is spending 30% of its cycles just managing the transition between kernel space and user space, you've already lost the battle.

## The Paradigm Shift: What is VPP?

VPP, part of the FD.io project (under the Linux Foundation), takes a completely different approach. Instead of processing one packet at a time (scalar), it processes a **Vector** (a batch) of packets.

Think of it like an elevator. In the scalar model, the elevator takes one person from the lobby to the 10th floor, comes back down empty, and picks up the next person. In the VPP model, the elevator waits for a group, then takes everyone to their respective floors in one trip.

### The Vectorized Advantage

By processing a batch of, say, 256 packets at once, VPP achieves something magical for CPU performance:

- **I-Cache Warmth:** When the code for "IPv4 Lookup" is loaded into the CPU, it stays there for all 256 packets in the vector. The CPU doesn't have to fetch new instructions until it's finished the entire batch for that specific task.
- **Prefetching:** VPP can "look ahead." While the CPU is processing the header of packet $N$, VPP can tell the hardware to prefetch the memory for packet $N+10$. This hides memory latency and keeps the execution pipeline full.
- **Reduced Interrupts:** VPP typically runs in **Poll Mode**. Instead of the NIC "screaming" at the CPU every time a packet arrives, a dedicated CPU core constantly checks the NIC for new data. It’s counter-intuitive, but "spinning" at 100% CPU to poll for packets is often more efficient than the overhead of thousands of interrupts per second.

---

## The Architecture: The Directed Graph

One of the most elegant aspects of VPP is its **Graph-Node Architecture**. In VPP, every networking function (NAT, Firewall, IP Lookup, Encapsulation) is a "node" in a directed graph.

A packet vector enters the graph at a source node (like `dpdk-input`) and flows through the nodes based on the packet's characteristics.

### How a Vector Moves Through the Graph:

1.  **`dpdk-input`**: Grabs a burst of packets from the NIC.
2.  **`ethernet-input`**: Strips Ethernet headers and determines the next node (e.g., IPv4 or IPv6).
3.  **`ip4-input`**: Validates checksums and TTLs for the whole vector.
4.  **`ip4-lookup`**: Performs a Longest Prefix Match (LPM) in the FIB (Forwarding Information Base).
5.  **`ip4-rewrite`**: Rewrites the MAC addresses for the next hop.
6.  **`dpdk-output`**: Pushes the batch back out to the wire.

Because each node only does one specific task for the whole vector, the **Instruction Cache efficiency is nearly 100%**.

### Code Snippet: The Inner Loop

To give you a taste of the technical substance, here is a conceptual look at what a VPP node's inner loop looks like. Notice how it processes multiple packets simultaneously to leverage CPU pipelining:

```c
while (n_left_from > 0) {
    u32 bi0, bi1;
    vlib_buffer_t *b0, *b1;

    // Prefetch next packets in the vector
    if (n_left_from >= 4) {
        vlib_prefetch_buffer_header(p2, LOAD);
        vlib_prefetch_buffer_header(p3, LOAD);
    }

    bi0 = from[0];
    bi1 = from[1];
    b0 = vlib_get_buffer(vm, bi0);
    b1 = vlib_get_buffer(vm, bi1);

    // Perform the logic (e.g., decrement TTL)
    ip0 = vlib_buffer_get_current(b0);
    ip1 = vlib_buffer_get_current(b1);

    ip0->ttl -= 1;
    ip1->ttl -= 1;

    // Determine the next node in the graph
    next0 = calculate_next(b0);
    next1 = calculate_next(b1);

    vlib_validate_buffer_enqueue_x2(vm, node, next_index,
                                    to_next, n_left_to_next,
                                    bi0, bi1, next0, next1);
}
```

_Note: VPP heavily uses macros and optimized assembly to ensure this loop is as tight as possible._

---

## Cloudflare’s Implementation: Integrating VPP into the Edge

We don't just use VPP as a standalone router; we use it as a highly programmable data plane. Our edge is diverse, handling everything from standard HTTP traffic to complex DDoS mitigation and "Magic Transit" (our BGP-based L3/L4 protection).

### 1. The DPDK Foundation

To get packets into user space, we use **DPDK (Data Plane Development Kit)**. DPDK provides the drivers that allow VPP to take ownership of the NIC hardware directly. By using "Zero-Copy" techniques, we move packet data from the NIC directly into VPP-managed memory buffers without the CPU ever having to move the data manually.

### 2. Programmability via C and Go

While VPP is written in C for performance, managing it in a dynamic environment like Cloudflare requires a more flexible approach. We use a **Go-based control plane** that talks to the VPP binary via a shared memory binary API.

This allows us to:

- Dynamically push thousands of firewall rules.
- Update routing tables in real-time based on global health checks.
- Collect granular telemetry (packets per second, drops per rule) and export them to Prometheus/Grafana.

### 3. The "Unimog" Connection

At Cloudflare, we’ve spoken before about **Unimog**, our high-performance L4 Load Balancer. VPP serves as the engine for many of our "Specialized" data plane needs. When we need to do high-performance encapsulation (like GRE or IP-in-IP for Magic Transit), VPP is the tool of choice. It allows us to perform these operations at line rate—something that would make a standard kernel-based implementation crawl.

---

## The Hype vs. The Reality: VPP vs. eBPF/XDP

In the networking world lately, **eBPF (Extended Berkeley Packet Filter)** and **XDP (eXpress Data Path)** are the subjects of immense hype. Some argue that eBPF makes user-space networking like VPP obsolete.

**The Technical Substance:**
It’s not an "either/or" situation. At Cloudflare, we use both.

- **XDP** is fantastic for early-stage DDoS dropping. It lives inside the driver and can drop packets before they even reach the main kernel stack. It’s lightweight and has great integration with standard Linux tools.
- **VPP** is a full-featured, stateful data plane. If you need to do complex fragmentation, reassembly, stateful firewalling, or heavy-duty encapsulation for millions of concurrent flows, VPP’s graph-node architecture and user-space memory management provide a level of flexibility and raw throughput that XDP currently struggles to match for "heavy" processing.

The "hype" suggests eBPF is the end-all-be-all. The "reality" is that for massive, complex L4-L7 middlebox functionality at terabit scale, the **Vectorized User-Space** approach still holds a significant performance edge in terms of "work done per CPU cycle."

---

## Technical Engineering Curiosities: The Challenges of User Space

Moving to user space isn't all sunshine and rainbows. It introduces unique engineering challenges that we’ve had to solve.

### The "Hidden" Bottleneck: Memory Latency

Even with vectorization, the CPU can still stall if it’s waiting for data from main memory (DRAM). We heavily utilize **NUMA (Non-Uniform Memory Access)** awareness. If a NIC is physically connected to the PCIe lanes of CPU Socket 0, VPP must ensure that the memory buffers and the CPU cores processing those packets are also on Socket 0. Crossing the QPI/UPI link to Socket 1 can increase latency by 30% and significantly reduce our max throughput.

### The Observability Gap

In the kernel, you have `tcpdump`, `iptables -L`, and `netstat`. In user space, the kernel knows nothing about the packets. If you run `tcpdump` on a physical interface owned by VPP/DPDK, you will see... absolutely nothing.

To solve this, we’ve integrated VPP’s internal tracing mechanisms. VPP can capture packets at _any_ node in the graph. We can say: "Show me the first 100 packets that passed through the `ip4-lookup` node but failed the `ip4-rewrite` node." This level of introspection is actually more powerful than `tcpdump`, as it provides a "per-node" view of the packet’s journey.

### CPU Pinning and Isolation

To prevent the Linux scheduler from interrupting our VPP worker threads, we use **CPU Isolation (isolcpus)**. We essentially tell the Linux kernel: "Do not touch these 16 cores. They belong to VPP." This prevents context switches and ensures that VPP has 100% of the core's resources to poll the NIC and process vectors.

---

## Compute Scale: Looking at the Numbers

What does this look like in production? On a standard dual-socket EPYC or Xeon server, we can see performance numbers that were previously the domain of expensive, proprietary ASIC-based hardware.

- **Packet Rates:** A single VPP worker thread can often process upwards of **10 to 15 million packets per second (Mpps)** depending on the complexity of the graph.
- **Scaling:** Because VPP scales almost linearly with cores, a 32-core allocation can easily handle **400+ Mpps**.
- **Latency:** By bypassing the kernel's complex queuing disciplines, we see a significant reduction in tail latency ($P99$), which is critical for the performance of the global DNS and HTTP services we provide.

---

## The CPU is the New ASIC

The trend is clear: the industry is moving away from fixed-function hardware (ASICs) toward **Software Defined Networking (SDN)** on commodity hardware. VPP is at the forefront of this revolution.

By treating the CPU like a highly programmable network processor and optimizing for the way modern silicon actually works—vectors, caches, and pipelines—we’ve been able to turn standard off-the-shelf servers into world-class network appliances.

At Cloudflare, decoding the data plane isn't just about speed; it's about control. With VPP, we have the power to define exactly how every bit and byte moves through our network, allowing us to build a faster, more secure, and more reliable internet for everyone.

The next time you load a website in milliseconds, remember: there's a vector of packets flying through a graph in user space somewhere at the edge, moving at a speed the kernel could only dream of.
