---
title: "Zero-Copy or Bust: Re-architecting High-Throughput Data Planes with eBPF and AF_XDP"
shortTitle: "High-Performance Data Planes with Zero-Copy eBPF and AF_XDP"
date: 2026-08-26
image: "/images/2026/08/26/zero-copy-or-bust-re-architecting-high-throughput-data-plane.svg"
---

The year is 2024, and your infrastructure is hitting a wall. Your microservices are humming, your Kubernetes clusters are scaling, and your 100GbE NICs are theoretically capable of moving mountains of data. Yet, when you look at your observability dashboards, your P99 latencies are spiking, and your CPUs are spending 40% of their cycles just moving bytes from the kernel to userspace.

If you’ve ever felt the frustration of watching a powerful Xeon or EPYC processor choke on network interrupts while your application logic sits idle, you’ve encountered the "Kernel Tax." For years, the industry standard for high-performance networking was **DPDK (Data Plane Development Kit)**, which famously bypasses the kernel entirely. But DPDK is a greedy beast—it requires dedicated CPU cores and complex driver management.

Enter the modern era of **Zero-Copy Data Planes**. Today, we’re diving deep into the two titans of the Linux networking renaissance: **eBPF (XDP)** and **AF_XDP**. We’re going to tear down the architecture, look at the code, and figure out why these technologies are the secret sauce behind the next generation of high-throughput microservices.

## The Bottleneck: Why the Standard Linux Stack is Failing You

Before we talk about the solution, we have to respect the problem. In a standard Linux networking path, a packet arrives at the NIC, triggers an IRQ, and the kernel’s NAPI (New API) subsystem starts polling. The kernel then wraps that packet in a complex metadata structure called an `sk_buff` (socket buffer).

The `sk_buff` is the "Swiss Army Knife" of the kernel—it has everything needed for heavy-duty routing, firewalling (iptables/nftables), and protocol encapsulation. But for a high-throughput microservice, it’s a massive overhead. Every time that packet moves from the kernel to your Go or Rust service, a **context switch** occurs and a **memory copy** happens.

At 1Gbps, you don’t feel it. At 10Gbps, it’s noticeable. At 100Gbps, the cost of copying memory and managing `sk_buff` objects is so high that your CPU becomes the bottleneck long before the wire is full.

## The Rise of eBPF and XDP: The "In-Kernel" Revolution

The hype around eBPF (Extended Berkeley Packet Filter) has been deafening, and for good reason. It’s often described as "JavaScript for the Kernel." It allows us to run sandboxed programs inside the Linux kernel without changing the source code or loading dangerous modules.

For networking, the crown jewel is **XDP (eXpress Data Path)**.

### The Architecture of Speed

XDP hooks into the network driver at the earliest possible point—right when the packet lands in the RX (receive) ring buffer of the NIC, _before_ an `sk_buff` is even allocated.

When an XDP program runs, it can return one of several actions:

- **XDP_DROP:** Trash the packet immediately (perfect for DDoS mitigation).
- **XDP_PASS:** Send it up to the normal Linux networking stack.
- **XDP_TX:** Reflect the packet back out of the same interface (great for load balancers).
- **XDP_REDIRECT:** Send the packet to another NIC or, crucially, an AF_XDP socket.

### Why it’s High-Performance

Because XDP operates at the "driver level," it can process millions of packets per second (Mpps) per core. By avoiding the overhead of the TCP/IP stack and the `sk_buff` allocation, you are essentially turning your Linux kernel into a programmable switch.

```c
// A simplified XDP program to drop all UDP traffic
SEC("xdp")
int xdp_drop_udp(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;
    struct ethhdr *eth = data;

    if (data + sizeof(struct ethhdr) > data_end)
        return XDP_PASS;

    if (eth->h_proto == bpf_htons(ETH_P_IP)) {
        struct iphdr *iph = data + sizeof(struct ethhdr);
        if (data + sizeof(struct ethhdr) + sizeof(struct iphdr) > data_end)
            return XDP_PASS;

        if (iph->protocol == IPPROTO_UDP) {
            return XDP_DROP; // Packet never reaches the stack!
        }
    }
    return XDP_PASS;
}
```

## AF_XDP: The True Zero-Copy Gateway

While XDP is great for dropping or redirecting traffic _inside_ the kernel, most of us write our business logic in userspace. This is where **AF_XDP** (Address Family XDP) enters the stage.

AF_XDP is a relatively new socket type (introduced in Linux 4.18) designed for high-performance packet processing. Unlike a standard AF_INET socket, AF_XDP is a **zero-copy** interface. It allows userspace applications to read and write packet data directly from the NIC’s DMA (Direct Memory Access) buffers.

### The Magic of UMEM and Ring Buffers

To understand AF_XDP, you have to understand **UMEM**. UMEM is a contiguous chunk of memory that you, the developer, allocate in userspace and share with the kernel. This memory is divided into "frames" that can hold packets.

Communication between your application and the kernel happens via four circular ring buffers:

1.  **Fill Ring:** Userspace puts descriptors here to tell the kernel, "Hey, here are some empty frames you can put new packets into."
2.  **RX Ring:** The kernel puts descriptors here to tell userspace, "I’ve filled these frames with incoming packets."
3.  **TX Ring:** Userspace puts descriptors here to say, "Please send the data in these frames out onto the wire."
4.  **Completion Ring:** The kernel puts descriptors here to say, "I’ve finished sending those packets; you can have the frames back."

**The technical payoff:** No data is copied between kernel and userspace. Only the _pointers_ (descriptors) to the frames are passed back and forth. This is true zero-copy.

## Infrastructure Scale: From 1M to 100M Packets Per Second

Why does this matter in production? Let’s look at the compute scale.

In a traditional microservice architecture, a specialized Load Balancer (like Nginx or HAProxy) sits in front of your services. As traffic grows, that Load Balancer becomes a massive CPU sink. By moving the load balancing logic to an AF_XDP-based data plane, engineers at companies like **Cloudflare** have demonstrated the ability to process over **20 million packets per second on a single commodity CPU core**.

Think about that. If your service handles 1KB packets, 20Mpps is roughly 160Gbps. You are saturating 100G links using a fraction of a single server's compute power, leaving the rest of the CPU free to run your actual business logic.

### The "Zero-Copy" Nirvana

In a standard stack, if you are building a proxy, the flow is:
`NIC -> Kernel Buffer -> Userspace Buffer (Read) -> Userspace Buffer (Modify) -> Kernel Buffer (Write) -> NIC`.
That’s **two copies** across the kernel/userspace boundary.

With AF_XDP:
`NIC -> UMEM Frame -> Userspace (Modify in place) -> NIC`.
That’s **zero copies**. The data never leaves the UMEM area.

## The "Hype" vs. Reality: Engineering Challenges

If eBPF and AF_XDP are so fast, why isn't everyone using them? Because "Zero-Copy" isn't a free lunch. It’s more like a "Some assembly required" buffet.

### 1. The Memory Management Headache

When you use AF_XDP, the kernel no longer manages your memory. You are responsible for the UMEM. You have to handle frame allocation, ensure proper alignment, and manage the rings. If your application crashes without cleaning up, or if you mismanage the rings, you can easily leak memory or hang the NIC driver.

### 2. Protocol Re-implementation

The Linux kernel provides a world-class TCP/IP stack. When you use AF_XDP in "Zero-Copy" mode (using the `XDP_DRV` flag), you are bypassing that stack. If your application needs to handle TCP handshakes, window scaling, or retransmission, **you have to implement it yourself** or use a library like `libxdp` or a userspace TCP stack (like F-Stack or mTCP).

This is why AF_XDP is most commonly used for:

- **UDP-based services** (QUIC, Gaming, VoIP).
- **Layer 4 Load Balancers**.
- **Intrusion Detection Systems (IDS)**.
- **Custom protocol gateways**.

### 3. Hardware Support

Not every NIC supports AF_XDP zero-copy. While Intel (i40e, ice) and Mellanox (mlx5) have excellent support, many cloud providers use virtualized NICs (like AWS ENA) that may only support "copy mode" (using the `XDP_SKB` flag). In copy mode, you still get the programming benefits of eBPF, but you lose the zero-copy performance gains.

## Production Implementation: A Deep Dive into the Flow

Let's walk through a production-grade setup for a high-throughput microservice using AF_XDP.

### Step 1: Memory Alignment and Hugepages

To squeeze every drop of performance, we don't just use standard `malloc`. We use **Hugepages** (2MB or 1GB pages). This reduces TLB (Translation Lookaside Buffer) misses.

```c
// Allocating UMEM using hugepages
void* mem = mmap(NULL, NUM_FRAMES * FRAME_SIZE, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
```

### Step 2: Loading the XDP Program

We need a small eBPF program loaded on the NIC that acts as a traffic cop. Its only job is to look at incoming packets and say, "Is this for my AF_XDP socket? If yes, `XDP_REDIRECT`."

```c
SEC("xdp")
int xdp_sock_prog(struct xdp_md *ctx) {
    int index = ctx->rx_queue_index;
    // Map of AF_XDP sockets indexed by queue ID
    return bpf_redirect_map(&xsks_map, index, XDP_PASS);
}
```

### Step 3: The Userspace Polling Loop

Unlike standard sockets that use `select()` or `epoll()`, high-performance AF_XDP applications often use a **busy-poll** loop to avoid the latency of sleep/wake cycles.

```rust
// Pseudocode for a Rust-based AF_XDP processing loop
loop {
    // 1. Check RX Ring for new packets
    let rcvd = rx_ring.peek(BATCH_SIZE);

    for desc in rcvd {
        let frame = umem.get_frame(desc.addr);
        process_packet(frame); // Your business logic here

        // 2. Move frame pointer to Fill Ring to reuse it
        fill_ring.produce(desc.addr);
    }

    // 3. Trigger kernel to process rings
    socket.poll();
}
```

## The "Recent Hype" Context: Why Now?

You might be wondering why we're talking about this now if AF_XDP was released years ago. The answer lies in the massive shift toward **Cloud Native Networking** and the limits of **Sidecar Proxies**.

In the Kubernetes world, the "Service Mesh" (Istio, Linkerd) has been the dominant architectural pattern. But sidecars introduce a "double-kernel-bypass" problem where every request hops through the kernel stack multiple times to go from App A -> Sidecar A -> Sidecar B -> App B.

The industry is currently obsessed with **eBPF-based Service Meshes** (like Cilium). Cilium uses eBPF to short-circuit the networking path, essentially performing "Socket-to-Socket" redirection. AF_XDP is the logical extension of this—if we can shorten the path _within_ the kernel, why not give the application the ability to pull the data directly?

Furthermore, the rise of **QUIC (HTTP/3)** has moved the complexity of the transport layer from the kernel (TCP) to userspace (UDP). Since AF_XDP is a natural fit for UDP, it has become the "Holy Grail" for companies building ultra-fast HTTP/3 proxies and edge gateways.

## Engineering Curiosities: The Hidden Gotchas

### Cache Locality and NUMA

When you are processing 20 million packets per second, the distance between your CPU and your memory matters—literally. If your NIC is physically wired to CPU Socket 0, but your AF_XDP application is running on CPU Socket 1, the data has to travel across the QPI/UPI link (the interconnect between sockets). This "cross-talk" can destroy your performance gains.

Production implementations must be **NUMA-aware**. You pin your threads to the cores directly associated with the NIC’s PCIe lane and allocate your UMEM from the local NUMA node.

### The Specter of Interrupt Coalescing

Modern NICs try to be helpful by "coalescing" interrupts—waiting for a few packets to arrive before bothering the CPU. For high-throughput, this is great. For low-latency, it's a nightmare. When tuning a zero-copy data plane, you often have to dive into `ethtool` settings to find the "Goldilocks" zone of interrupt moderation.

## Measuring the Impact: A Real-World Comparison

In a recent benchmark conducted by an engineering team at a major fintech firm, they compared a standard Go-based microservice against a version re-architected with AF_XDP (using a Rust-based packet processor).

- **Standard Stack:**
    - Max Throughput: 1.2 Mpps
    - P99 Latency: 450μs
    - CPU Usage: 100% (8 cores)
- **AF_XDP (Zero-Copy):**
    - Max Throughput: 15 Mpps
    - P99 Latency: 35μs
    - CPU Usage: 25% (2 cores)

The results weren't just a marginal improvement; it was a **10x increase in efficiency**. They were able to decommission two-thirds of their load-balancing fleet while simultaneously improving the user experience for high-frequency traders.

## Moving Toward a Kernel-Native Future

The debate of "Kernel vs. Userspace" is finally reaching a synthesis. We no longer have to choose between the safety and features of the Linux kernel and the raw performance of kernel-bypass tools like DPDK.

With eBPF and AF_XDP, we are entering an era of **Programmable Data Planes**. We can leverage the kernel's security model and driver ecosystem while achieving zero-copy speeds that were previously the stuff of specialized hardware and proprietary stacks.

As microservices continue to shrink in size and grow in number, the overhead of the network will continue to be the primary target for optimization. If you are building high-scale infrastructure, the question is no longer _if_ you will use zero-copy techniques, but _when_.

The "Kernel Tax" is high, but thanks to eBPF and AF_XDP, we finally have the tools to stop paying it. It’s time to stop moving bytes and start moving the needle.
