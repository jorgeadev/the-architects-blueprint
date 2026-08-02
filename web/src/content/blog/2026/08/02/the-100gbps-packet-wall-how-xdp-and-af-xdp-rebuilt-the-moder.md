---
title: "The 100Gbps Packet Wall: How XDP and AF_XDP Rebuilt the Modern Load Balancer"
shortTitle: "Overcoming the 100Gbps Packet Wall with XDP and AF_XDP"
date: 2026-08-02
image: "/images/2026/08/02/the-100gbps-packet-wall-how-xdp-and-af-xdp-rebuilt-the-moder.svg"
---

Imagine a firehose. Now imagine that firehose isn't spraying water, but a relentless stream of 64-byte Ethernet frames. At 100Gbps—the current gold standard for data center interconnects—you aren't just dealing with "high traffic." You are dealing with a packet every **6.7 nanoseconds**.

In the time it takes for light to travel about two meters, your CPU must receive a packet, parse its headers, look up a state table, decide on a destination, rewrite the MAC/IP addresses, and send it back out. If you spend more than a few hundred CPU cycles per packet, you aren't just slow; you’re dropping traffic. You’re failing.

For years, the industry relied on the standard Linux kernel networking stack and IPVS (IP Virtual Server) to handle Layer 4 load balancing (L4LB). But as Cloudflare, Meta, and Google pushed toward 100G and 400G NICs, the "General Purpose" nature of the Linux kernel became a liability. The overhead of `sk_buff` allocations, context switching, and the sheer complexity of the netfilter subsystem created a bottleneck that no amount of CPU pinning could solve.

This is the story of how we moved past the kernel’s limitations, why the industry shifted from DPDK to eBPF/XDP, and the technical surgery required to build a 100Gbps L4 load balancer using AF_XDP.

---

## The Ghost in the Machine: Why the Kernel Stack Broke

To understand why we needed XDP, we have to understand why the traditional Linux networking stack hit a wall.

When a packet arrives at a standard NIC, the driver allocates a metadata structure called an `sk_buff` (socket buffer). This structure is massive—it’s a "Swiss Army knife" containing everything the kernel might possibly need for any protocol (TCP, UDP, SCTP, tunneling, etc.).

1.  **Memory Allocation Overhead:** Allocating and deallocating `sk_buff` for every single packet at 148 million packets per second (Mpps) is a recipe for cache misses and allocator contention.
2.  **The Interrupt Storm:** Every packet triggers a softirq. Even with NAPI (New API) coalescing interrupts, the CPU spends an enormous amount of time just managing the transition from the "hardware" world to the "kernel" world.
3.  **The Locking Nightmare:** The kernel's connection tracking (conntrack) uses global locks or complex hashed locks. At 100Gbps, the contention on these locks across 32 or 64 cores becomes the primary bottleneck.

For a long time, the solution was **DPDK (Data Plane Development Kit)**. DPDK essentially says, "The kernel is too slow, so let's bypass it entirely." It pulls the NIC driver into user-space and polls the hardware constantly. While incredibly fast, DPDK has a massive "tax": you lose the Linux ecosystem. You lose `iptables`, you lose the standard routing table, and you have to write your own TCP/IP stack if you want to do anything more than simple forwarding.

Then came **XDP (eXpress Data Path)**.

---

## XDP: The "Best of Both Worlds" Revolution

XDP, powered by eBPF, introduced a third way. Instead of bypassing the kernel, XDP allows us to run a sandboxed, highly optimized C program **directly inside the NIC driver**, before the kernel has even allocated an `sk_buff`.

When a packet hits the driver, the XDP program executes. It can:

- **XDP_DROP:** Trash the packet (perfect for DDoS mitigation).
- **XDP_TX:** Reflect the packet back out the same interface (great for load balancing).
- **XDP_PASS:** Hand the packet up to the normal Linux stack.
- **XDP_REDIRECT:** Send the packet to a different NIC or a user-space socket.

This is where Cloudflare’s "Unimog" and similar modern L4LBs live. By processing packets at the XDP layer, we avoid almost all the kernel overhead while still maintaining the ability to "fall back" to the kernel for complex tasks (like ICMP handling or BGP).

---

## Deep Dive: The AF_XDP Architecture

While XDP is great for simple "drop" or "forward" logic, a modern load balancer often needs to perform complex state lookups or interact with user-space control planes. This is where **AF_XDP** (Address Family XDP) enters the frame.

AF_XDP is a "fast path" socket that allows us to move raw frames from the driver directly into a user-space application with **zero-copy** overhead. It’s effectively a high-performance bridge.

### The Ring Buffers: How the Data Flows

AF_XDP doesn't use `send()` or `recv()` syscalls. That would be too slow. Instead, it uses four shared circular buffers (rings) between the kernel and user-space:

1.  **Fill Ring:** User-space tells the kernel: "Here are some empty memory slots (buffers) you can use to put incoming packets."
2.  **RX Ring:** The kernel tells user-space: "I’ve filled these slots with new packets. Go ahead and process them."
3.  **TX Ring:** User-space tells the kernel: "I’ve processed these packets and put them in these slots. Please transmit them."
4.  **Completion Ring:** The kernel tells user-space: "I’ve finished transmitting the packets in these slots, you can have the memory back."

This "Lockless Ring Buffer" design is the secret sauce of 100Gbps performance. Since the producer and consumer are on different ends of the ring, we can achieve massive throughput without the CPUs fighting over a single memory lock.

### The Code: A Glimpse into XDP Logic

A basic XDP program for a load balancer looks something like this (simplified C):

```c
SEC("xdp_lb")
int xdp_load_balancer(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if (eth + 1 > data_end) return XDP_ABORTED;

    struct iphdr *iph = data + sizeof(struct ethhdr);
    if (iph + 1 > data_end) return XDP_ABORTED;

    // Use Consistent Hashing (Maglev) to find a backend
    __u32 key = iph->saddr ^ iph->daddr;
    struct backend_info *backend = bpf_map_lookup_elem(&backends_map, &key);

    if (backend) {
        // Rewrite Destination MAC and IP
        __builtin_memcpy(eth->h_dest, backend->mac, ETH_ALEN);
        iph->daddr = backend->ip;

        // Recalculate Checksum (usually offloaded to hardware)
        // ...

        return XDP_TX; // Send it back out
    }

    return XDP_PASS;
}
```

---

## Solving the "Maglev" Problem: Consistent Hashing at Scale

In a 100Gbps environment, you aren't just balancing across two servers. You’re balancing across hundreds of backends. If one backend goes down, you cannot afford to reshuffle all existing connections (a "hash rehashing storm").

Cloudflare and Google use the **Maglev Consistent Hashing** algorithm. The goal of Maglev is to ensure that even if the backend pool changes, the vast majority of existing flows still map to the same backend.

At the technical level, this involves maintaining a massive "Lookup Table" in an **eBPF Map**. When a packet arrives, the XDP program hashes the 5-tuple (Src IP, Dst IP, Src Port, Dst Port, Protocol) and uses that hash as an index into the Maglev table.

**The Engineering Challenge:** Updating these maps atomically. When the control plane detects a dead backend, it must update the eBPF map without stopping the packet flow. We use `BPF_MAP_TYPE_ARRAY` for the lookup table, allowing for $O(1)$ lookups, which is critical when you only have 6 nanoseconds to make a decision.

---

## The NUMA Factor: Why Hardware Topology is Everything

If you’re building a 100Gbps LB, you can’t ignore the physical layout of your server. Modern high-core-count CPUs (like AMD EPYC or Intel Scalable) are split into **NUMA (Non-Uniform Memory Access) nodes**.

If your 100G NIC is physically plugged into PCIe lanes connected to **CPU Socket 0**, but your XDP program is running on a core on **CPU Socket 1**, the packet data has to cross the QPI/UPI interconnect. This adds latency and bottlenecks the throughput.

**The Optimization Strategy:**

- **Core Pinning:** We pin the AF_XDP processing threads to the specific cores that are "closest" to the NIC.
- **Hugepages:** We use 2MB or 1GB memory pages for our UMEM (the memory used by AF_XDP) to reduce TLB (Translation Lookaside Buffer) misses.
- **RSS (Receive Side Scaling):** We configure the NIC to distribute incoming traffic across multiple hardware queues. Each queue is then handled by a dedicated CPU core running an independent XDP instance.

---

## Zero-Copy: The Holy Grail

Standard AF_XDP is fast, but "Zero-Copy" AF_XDP is the dream. In standard mode, the packet is copied once from the driver's memory into the AF_XDP buffer. In **Zero-Copy mode**, the NIC hardware writes the packet directly into the memory that your user-space application owns.

This requires specific driver support (e.g., `mlx5_core` for Mellanox/NVIDIA cards). When enabled, the performance jump is staggering. We’ve seen systems move from "struggling at 40Gbps" to "idling at 100Gbps" just by switching to zero-copy and optimizing the descriptor rings.

---

## Observability: Seeing Into the 6ns Window

One of the biggest hurdles in moving from IPVS to XDP is that `tcpdump` no longer works out of the box. Since XDP intercepts the packet before the kernel sees it, a standard `tcpdump` session will show... nothing.

To solve this, we had to build custom observability tools.

- **eBPF Exporters:** We use eBPF maps to track metrics (packets per second, bytes per second, error codes) and export them to Prometheus.
- **XDP_SAMPLE:** We created "sampling" programs that clones 1 out of every 10,000 packets and sends them to a special AF_XDP socket just for monitoring and PCAP analysis.

You cannot manage what you cannot measure, and in the world of 100Gbps, measuring is an engineering project in its own right.

---

## Why This Matters: The Big Picture

The transition from kernel-heavy IPVS to XDP/AF_XDP represents a fundamental shift in how we think about the operating system. We are moving toward a world where the kernel provides **safety and resource isolation**, while the "Data Plane" is handled by specialized, programmable micro-programs (eBPF).

Cloudflare’s transition allowed them to collapse their DDoS protection and load balancing into a single, unified pipeline. This didn't just save on CPU cycles; it reduced the latency of every request passing through their edge.

### The Takeaway for Engineers

If you are building high-performance systems today, the "Kernel vs. User-space" debate is over. The answer is **both**.

- Use the **Kernel** for what it’s good at: control planes, routing protocols, and security.
- Use **eBPF/XDP** for the "hot path": packet steering, load balancing, and telemetry.

At 100Gbps, every nanosecond is a gift. Don't waste it on a context switch.

---

### Technical Summary for the Scanners:

- **The Problem:** Kernel `sk_buff` overhead and conntrack locks fail at 100Gbps/148Mpps.
- **The Solution:** XDP runs C code at the driver level; AF_XDP provides a zero-copy path to user-space.
- **The Math:** At 100Gbps, you have ~6.7ns per packet. Efficiency is not optional.
- **The Logic:** Use Maglev hashing for consistency and eBPF maps for $O(1)$ state lookup.
- **The Hardware:** NUMA affinity and Hugepages are required to avoid interconnect bottlenecks.

This is the new frontier of networking. It’s complex, it’s low-level, and it’s incredibly fast. Welcome to the era of the programmable data plane.
