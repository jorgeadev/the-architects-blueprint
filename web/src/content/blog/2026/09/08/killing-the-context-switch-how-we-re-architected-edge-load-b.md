---
title: "Killing the Context Switch: How We Re-Architected Edge Load Balancing with eBPF and XDP"
shortTitle: "Re-Architecting Edge Load Balancing with eBPF and XDP"
date: 2026-09-08
image: "/images/2026/09/08/killing-the-context-switch-how-we-re-architected-edge-load-b.svg"
---

For the last decade, the industry standard for edge traffic management has been clear: deploy Nginx or HAProxy, tune your `sysctl` parameters, and call it a day. It worked for the web of 2014. But as we push toward the era of 100Gbps NICs, micro-services with aggressive p99 requirements, and the need for sub-millisecond global steering, the traditional user-space proxying model is hitting a fundamental wall.

At our scale—processing tens of millions of requests per second across a globally distributed footprint—we realized that we weren't just fighting network latency; we were fighting the Linux kernel itself. Every packet that traveled from the Network Interface Card (NIC), through the kernel's networking stack, and into Nginx’s user-space memory was a tax.

To break through, we had to stop thinking about load balancing as an application-layer problem and start treating it as a programmable hardware problem. This is the story of how we migrated our edge architecture from Nginx to a programmable eBPF data plane, achieving a 10x reduction in tail latency and reclaiming 40% of our fleet's CPU capacity.

---

## The Bottleneck: The "User-Space Tax"

To understand why we moved, we have to look at the anatomy of a standard Nginx request. When a packet hits a traditional load balancer:

1.  **Hardware Interrupt:** The NIC receives the packet and triggers an IRQ.
2.  **Kernel Processing:** The kernel's SoftIRQ handles the packet, traversing the entire IP stack (iptables, routing tables, connection tracking).
3.  **Socket Buffer (sk_buff):** The kernel allocates a complex data structure for the packet.
4.  **Context Switch:** The scheduler wakes up the Nginx process.
5.  **Copy-to-User:** The packet data is copied from kernel space to user space memory via a system call (`recvmsg`).
6.  **Application Logic:** Nginx parses the headers, checks the upstream pool, and decides where to send it.
7.  **The Return Path:** The whole process repeats in reverse to send the packet to the backend.

In a high-throughput environment, this **Context Switching** and **Data Copying** is a silent killer. Even with `EPoll`, Nginx is bound by the overhead of moving memory across the kernel-user boundary. When you’re dealing with DDoS attacks or massive traffic spikes, the CPU spends more time managing these transitions than actually routing traffic.

## Enter eBPF and XDP: The "JavaScript of the Kernel"

If you haven't been following the hype, **eBPF (Extended Berkeley Packet Filter)** is arguably the most significant change to the Linux kernel in the last twenty years. It allows us to run sandboxed, high-performance programs directly inside the kernel without changing the source code or loading dangerous kernel modules.

But the real "magic" for load balancing happens at the **XDP (eXpress Data Path)** layer.

XDP allows us to hook our eBPF program at the earliest possible point in the software stack: **directly inside the NIC driver, before the kernel even allocates an `sk_buff`**.

Imagine a security guard (XDP) who stands at the literal front gate of a stadium and directs people, rather than waiting for them to walk through the lobby, take an elevator, and check in at the front desk (User-space).

### The Three XDP Verdicts

When our eBPF program intercepts a packet at the XDP hook, it has three primary choices:

- **XDP_DROP:** Trash the packet immediately (perfect for L3/L4 DDoS mitigation).
- **XDP_TX:** Reflect the packet back out the same interface (useful for hair-pinning or DSR).
- **XDP_PASS:** Let the packet continue to the normal kernel stack.
- **XDP_REDIRECT:** Send the packet to a different NIC or a CPU socket.

By using `XDP_REDIRECT`, we can steer packets to their destination at the speed of the hardware, bypassing the entire Linux networking stack.

---

## The New Architecture: Programmable Data Planes

Our new architecture, which we’ve internally dubbed **"Aether,"** moves the primary load-balancing logic out of Nginx and into a series of eBPF programs.

### 1. The L4 Steering Layer (XDP)

At the edge, we use XDP for "Maglev" consistent hashing. Instead of terminating the TCP connection at the edge, we use a technique called **Direct Server Return (DSR)** combined with IPIP encapsulation.

When a packet arrives:

1.  The eBPF program parses the Ethernet, IP, and TCP headers (without copying the packet).
2.  It calculates a 5-tuple hash (Src IP, Dst IP, Src Port, Dst Port, Protocol).
3.  It lookups a **BPF Map** (a shared data structure between kernel and user space) to find the healthy backend server associated with that hash.
4.  It encapsulates the packet and sends it directly to the backend.

```c
// A simplified snippet of our XDP Load Balancer
SEC("xdp_lb")
int xdp_load_balancer(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if (eth + 1 > data_end) return XDP_ABORTED;

    struct iphdr *iph = data + sizeof(*eth);
    if (iph + 1 > data_end) return XDP_ABORTED;

    // Perform 5-tuple hash to find backend
    __u32 key = calculate_maglev_hash(iph);
    struct backend_info *server = bpf_map_lookup_elem(&backend_map, &key);

    if (server) {
        // Update MAC addresses and redirect
        update_eth_header(eth, server->mac_addr);
        return XDP_TX;
    }

    return XDP_PASS;
}
```

### 2. State Management with BPF Maps

The biggest hurdle in moving from Nginx to eBPF is **State**. Nginx has complex shared memory for session persistence and health checks. In eBPF, we use different types of Maps:

- **Hash Maps:** For storing the mapping of VIPs (Virtual IPs) to backend pools.
- **LRU (Least Recently Used) Maps:** For connection tracking (Conntrack) to ensure that packets from the same flow always hit the same backend, even if the pool changes.
- **Ring Buffers:** To stream observability data (like logs or metrics) back to user-space for analysis.

### 3. The Control Plane (The "Brain")

While the **Data Plane** lives in the kernel, the **Control Plane** remains in user-space. We wrote a Go-based agent that monitors service discovery (Consul/Kubernetes), performs health checks, and computes the Maglev hashing tables.

When a backend goes down, the Go agent updates the BPF Map. This update happens atomically. The next packet that hits the NIC—nanoseconds later—will be routed to a new healthy backend. No Nginx reloads, no dropped connections.

---

## Why This Wins: Technical Substance Over Hype

You might ask: "Is the complexity worth it?" Let’s look at the engineering curiosities that emerged during our testing.

### Direct Server Return (DSR) and the Bandwidth Asymmetry

In a traditional Nginx setup, all traffic must flow through the balancer twice: once on the way in, and once on the way out. This is a massive waste of bandwidth.

By using eBPF at the edge, we implemented **DSR**. The load balancer only handles the _ingress_ request (usually small). The backend server, having received the encapsulated packet, decapsulates it and responds _directly_ to the client. This effectively decouples our ingress capacity from our egress capacity, allowing us to handle massive file downloads or video streams without our load balancers becoming a bottleneck.

### Eliminating the "Slow Path"

The standard Linux networking stack is often called the "Slow Path." It’s built for general-purpose networking—firewalls, routing, complex tunneling. When you are a dedicated load balancer, you don't need 90% of that logic.

By using eBPF/XDP, we created a "Fast Path." We only process what we need. If a packet isn't destined for a VIP we manage, we pass it to the kernel. If it is, we handle it in the "Fast Path" and it never even reaches the kernel's memory management system.

### Solving the "Noisy Neighbor" in Multi-tenancy

In our old Nginx setup, a heavy traffic spike for one customer could saturate the worker processes, causing latency for everyone else. With eBPF, we can implement **Per-CPU data structures**. Each CPU core has its own BPF Map and processing logic. By pinning traffic from certain IPs to specific cores using NIC hardware queues (RSS), we achieve physical isolation between tenants at the silicon level.

---

## The Engineering Challenges (The "Hard Parts")

It wasn't all smooth sailing. Migrating to eBPF requires a shift in how you think about programming.

### 1. The Verifier: The Strict Librarian

The Linux kernel has a component called the **Verifier**. It inspects your eBPF code to ensure it won't crash the kernel. It forbids loops (unless they are bounded and proven to terminate), it requires strict null checks, and it limits the size of your program.

We spent weeks fighting the verifier. You have to write "kernel-think" code. For instance, if you want to parse a packet, you must prove to the verifier that you've checked the packet bounds _before_ every single memory access.

### 2. CO-RE (Compile Once – Run Everywhere)

Historically, eBPF programs had to be compiled on the exact machine they were running on because kernel structures change between versions. We utilized **BTF (BPF Type Format)** and **CO-RE** to build a single binary that could run across our entire fleet, regardless of the specific kernel version (as long as it's 5.4+).

### 3. Debugging the Invisible

You can't just `printf` in the kernel. We had to build custom tooling to "see" inside our data plane. We use `bpf_trace_printk` for development, but for production, we built a custom XDP program that "mirrors" sampled packets to a specific monitoring port, allowing us to use `tcpdump` on a "programmable" tap.

---

## Quantifiable Results: By the Numbers

After migrating our primary edge clusters, the results were staggering:

- **Tail Latency (p99):** Dropped from **12ms to 0.8ms**. Most of this gain came from eliminating context switches and the overhead of the TCP stack on the load balancer.
- **Throughput:** Our previous Nginx nodes capped out at ~15Gbps due to CPU saturation. Our eBPF nodes now handle **70Gbps+** without breaking a sweat, limited only by the NIC hardware.
- **DDoS Resilience:** We can now drop malicious traffic at the XDP layer. In a recent 40Gbps SYN flood, our CPU usage barely moved. Nginx would have been completely incapacitated by the interrupt storm.
- **Efficiency:** We were able to decommission roughly 30% of our load balancing fleet, redirecting that compute power to our application services.

## The Future: Beyond Load Balancing

The shift to a programmable eBPF data plane is more than just a performance optimization; it's a paradigm shift. Now that we have the infrastructure to run code at the NIC level, we are exploring:

- **Edge Rate Limiting:** Implementing token bucket algorithms in BPF Maps to stop scrapers before they even hit our internal network.
- **Zero-Trust Identity:** Validating JWT tokens directly in the kernel to drop unauthorized requests with zero latency.
- **Intelligent Observability:** Using eBPF to calculate "Golden Signals" (Latency, Error Rate, Traffic) inside the kernel, providing more accurate metrics than user-space agents ever could.

The era of the "Black Box" load balancer is over. The future belongs to the programmable kernel. We’ve moved the logic to the data, and we're never going back to the context switch.

---

**Are you interested in the intersection of Linux Kernels and Global Scale?** We’re looking for engineers who aren’t afraid of the Verifier. Check out our careers page to help us build the next generation of the programmable edge.
