---
title: "The War on Jitter: Engineering a Zero-Copy Data Plane for Sub-Microsecond Financial Clearing"
shortTitle: "Zero-Copy Data Plane for Sub-Microsecond Financial Clearing"
date: 2026-09-22
image: "/images/2026/09/22/the-war-on-jitter-engineering-a-zero-copy-data-plane-for-sub.svg"
---

In the world of high-frequency trading (HFT) and global financial clearing, time isn’t just money—it’s the fundamental physics of the marketplace. When you are processing millions of clearing instructions per second, a "slow" packet isn't just a minor delay; it’s a systemic risk. We aren't talking about milliseconds. We aren't even talking about microseconds in the broad sense. We are hunting for **tail latency in the nanosecond range.**

The traditional Linux networking stack is a masterpiece of general-purpose engineering. It is robust, versatile, and powers most of the internet. But for a financial clearing engine—where the difference between profit and a catastrophic "out-of-sync" state is measured by the speed of light in fiber—the standard kernel path is a bloated, slow-moving bureaucratic nightmare.

To achieve sub-microsecond P99.99 (four nines) latency, we have to stop asking the kernel for permission. We have to move data directly from the wire to the application memory without the CPU ever touching the headers. We need a **Zero-Copy Data Plane.**

This is the story of how we combined **RDMA (Remote Direct Memory Access)** and **eBPF (Extended Berkeley Packet Filter)** to bypass the "kernel tax" and build a clearing engine that treats 100Gbps like a leisurely stroll.

---

## The Ghost in the Machine: Why the Kernel is Killing Your Performance

Before we dive into the "how," we need to understand the "why." Why can't we just tune a standard TCP socket and call it a day?

The traditional Linux networking path involves a series of mandatory, high-latency hurdles:

1.  **Interrupt Handling:** When a packet hits the NIC, it triggers a hardware interrupt. The CPU stops what it’s doing, saves its state, and handles the IRQ. This context switch is a latency killer.
2.  **The Memory Copy Tax:** Data arrives in a kernel buffer. To get it to your clearing application, the kernel must copy that data into user-space memory. For a 1500-byte packet, this might seem trivial. At 10 million packets per second, the CPU spends more time moving bytes than calculating trades.
3.  **Context Switching:** Every time your application calls `recv()`, it transitions from User Mode to Kernel Mode. These transitions flush TLBs (Translation Lookaside Buffers) and disrupt the CPU pipeline.
4.  **SoftIRQs and Bottlenecks:** The `ksoftirqd` process handles protocol processing. If your clearing engine is pinned to Core 1, but the SoftIRQ is running on Core 2, you’ve just introduced inter-core latency and cache misses.

In a clearing environment, **jitter**—the variance in latency—is the enemy. A P50 of 2 microseconds is useless if your P99.99 is 500 microseconds. That "tail" is where the losses happen.

---

## Enter RDMA: The High-Speed Express Lane

RDMA (specifically **RoCE v2**—RDMA over Converged Ethernet) allows one computer to read or write directly into the memory of another without involving either operating system’s kernel.

### How it Works: Bypassing the CPU

With RDMA, the NIC (Network Interface Card) becomes a highly specialized co-processor. We "pin" a region of our application's memory and tell the NIC: _"When a packet arrives for this specific Queue Pair, don't tell the OS. Just drop it exactly at this memory address."_

The CPU doesn't even know the data has arrived until it checks a **Completion Queue (CQ)**. This is the definition of **Zero-Copy**. The data moves from the wire, through the PCIe bus, directly into the L3 cache or RAM of the host.

### The Architecture of an RDMA Clearing Engine

In our engine, we utilize **Unreliable Datagram (UD)** and **Reliable Connection (RC)** modes depending on the message type:

- **RC (Reliable Connection):** Used for the actual clearing instructions where packet loss is unacceptable. The hardware handles acknowledgments and retransmissions at the microsecond level.
- **UD (Unreliable Datagram):** Used for market data feeds where, if you miss a packet, you’re better off waiting for the next one than retrying the old one.

**The Engineering Curiosity:** The real magic happens with **Remote Direct Memory Access Write with Immediate.** This allows the sender to write data into our memory and simultaneously trigger a 32-bit "immediate" value in our completion queue. This acts as a hardware-level notification, eliminating the need for the application to "poll" every single byte of a 10GB memory buffer.

---

## eBPF: The Programmable Scalpel in the Kernel

While RDMA handles the bulk transfer of data, we still have a problem: **Filtering and Routing.** Not every packet is an RDMA packet. We still have heartbeat signals, management traffic, and potential DDoS attacks to deal with.

If we let the standard kernel handle this "noise," it will still trigger interrupts and steal cycles from our high-priority clearing threads. This is where **eBPF and XDP (Express Data Path)** come in.

### XDP: The "First Responder"

XDP allows us to run eBPF bytecode directly inside the network driver, _before_ the kernel even allocates an `sk_buff` (the standard Linux packet structure).

Imagine a clearing house receiving 40 million packets per second. Most of these are valid, but some might be malformed or irrelevant. Instead of letting these packets travel up the stack, our eBPF program inspects the packet at the NIC's doorstep:

- **XDP_DROP:** Trash the packet immediately (latency: ~10ns).
- **XDP_REDIRECT:** Send the packet to a specific CPU core or a dedicated AF_XDP socket for ultra-fast processing.
- **XDP_PASS:** Let the kernel have it (rarely used in our hot path).

### The Synergy: RDMA + eBPF

The real breakthrough in our architecture was using eBPF as a **pre-filter for RDMA setup.** RDMA requires complex connection handshakes (the "Connection Manager"). We use eBPF to parse these handshake packets and ensure only authenticated, low-latency-compliant peers can even attempt to establish an RDMA Queue Pair with our clearing engine.

By offloading the "handshake validation" to eBPF, we protect our clearing cores from being interrupted by "management noise."

---

## Deep Dive: Building the Zero-Copy Pipeline

Let’s look at how this actually looks in the codebase. Achieving sub-microsecond latency requires a obsessive focus on **cache-line alignment** and **NUMA locality.**

### 1. Memory Pinning and Hugepages

To prevent the kernel from swapping out our clearing buffers, we use **Hugepages** (2MB or 1GB). This reduces the pressure on the TLB.

```c
// Example: Allocating Hugepage memory for RDMA
void* buffer = mmap(NULL, BUFFER_SIZE, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
if (buffer == MAP_FAILED) {
    perror("mmap failed");
    exit(1);
}

// Register this memory with the RDMA HCA (Host Channel Adapter)
struct ibv_mr *mr = ibv_reg_mr(pd, buffer, BUFFER_SIZE,
                               IBV_ACCESS_LOCAL_WRITE | IBV_ACCESS_REMOTE_WRITE);
```

### 2. The XDP Filter (C code)

We write a highly optimized eBPF program to ensure that only traffic on specific UDP ports (our clearing ports) is allowed through to the user-space driver.

```c
SEC("xdp_clearing_filter")
int xdp_prog(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if (data + sizeof(*eth) > data_end) return XDP_PASS;

    if (eth->h_proto != bpf_htons(ETH_P_IP)) return XDP_PASS;

    struct iphdr *iph = data + sizeof(*eth);
    if (data + sizeof(*eth) + sizeof(*iph) > data_end) return XDP_PASS;

    // Only allow our specific Clearing Protocol (UDP port 9000)
    if (iph->protocol == IPPROTO_UDP) {
        struct udphdr *udp = data + sizeof(*eth) + sizeof(*iph);
        if (data + sizeof(*eth) + sizeof(*iph) + sizeof(*udp) > data_end) return XDP_PASS;

        if (udp->dest == bpf_htons(9000)) {
            return XDP_REDIRECT; // Send to the fast-path socket
        }
    }

    return XDP_DROP; // Drop everything else to save CPU
}
```

### 3. Avoiding the "Thundering Herd"

In a clearing engine, you might have 64 CPU cores. If 40 cores all try to read from the same RDMA Completion Queue, you’ll get **lock contention** that dwarfs any network latency.

We solve this by implementing **Core-to-Queue Affinity.** Each clearing thread owns a specific RDMA Queue Pair and a specific eBPF map. This ensures that the data for Thread A is processed on Core A, using the L2 cache of Core A, with zero inter-processor communication (IPC).

---

## The Infrastructure Scale: PCIe Gen5 and 200GbE

The software can only go as fast as the "pipes" allow. In modern clearing engines, we are moving toward **PCIe Gen5** and **200Gbps networking.**

### Why PCIe Gen5?

Even with RDMA, you are limited by the bandwidth and latency of the PCIe bus. PCIe Gen5 provides roughly 4GB/s per lane. For a 16-lane slot, that’s 64GB/s. More importantly, Gen5 reduces the **transaction latency**—the time it takes for a "DMA Write" to actually hit the memory controller.

When you are clearing trades, you aren't just moving one big file; you are moving millions of small packets. This makes **IOPS (Input/Output Operations Per Second)** and **Message Rate** more critical than raw throughput. Our current architecture handles roughly **120 million messages per second** per server.

### The NUMA Nightmare

If your NIC is connected to CPU Socket 0, but your clearing engine is running on CPU Socket 1, your data has to cross the **UPI (Ultra Path Interconnect)** or **Infinity Fabric**. This adds roughly **100–200 nanoseconds** of latency.

In the sub-microsecond world, 200ns is an eternity. We use strict `numactl` policies and BIOS tuning to ensure that:

1.  The NIC is in the same NUMA node as the clearing process.
2.  All memory allocated for RDMA is local to that NUMA node.
3.  Interrupts for management traffic are pinned to the _other_ socket.

---

## The Reality Behind the Hype: Is eBPF Truly "Zero-Overhead"?

There’s a lot of hype suggesting that eBPF is a magic bullet that makes networking "free." Let’s be real: eBPF is still code running on your CPU.

While XDP is significantly faster than the standard stack, it still consumes cycles. The "Zero-Copy" dream is truly realized by **RDMA**, while **eBPF** acts as the sophisticated air-traffic controller.

The actual technical substance behind the eBPF hype in HFT isn't just speed—it’s **observability.** Before eBPF, if you wanted to see why a packet was being delayed, you had to use `tcpdump` or `pcap`, which would introduce so much overhead that the latency you were trying to measure would triple.

With eBPF, we can use **kprobes** and **tracepoints** to measure the exact nanosecond a packet enters the system and exits the application, with virtually zero impact on the production flow. We can build "latency heatmaps" in real-time, identifying jitter caused by micro-bursts in network traffic that traditional monitoring would miss.

---

## Conquering the Tail: The Results

By implementing this dual-threat architecture—RDMA for the data plane and eBPF for the control/filter plane—we transformed our clearing engine’s performance profile.

**The Comparison:**

- **Standard Linux Stack (UDP/TCP):**
    - P50: 15-25 microseconds
    - P99.9: 150-300 microseconds (due to IRQ storms and context switches)
- **Zero-Copy (RDMA + eBPF + XDP):**
    - P50: **0.8 microseconds (800 nanoseconds)**
    - P99.9: **1.2 microseconds**

The most significant achievement isn't the 800ns P50—it's the **tightness of the tail.** By removing the kernel's unpredictability, we effectively eliminated the "jitter spikes" that cause clearing delays.

### The Engineering Takeaway

Building a zero-copy data plane is not about writing a clever algorithm. It's about **removing layers.** It’s a process of subtraction.

- Subtract the kernel.
- Subtract the memory copies.
- Subtract the interrupts.
- Subtract the NUMA hops.

When you get down to the bare metal, when the application and the NIC are speaking the same language without a middleman, that’s when you achieve the sub-microsecond dream. In the high-stakes world of financial clearing, that isn't just an optimization—it’s the ultimate competitive advantage.

**Are you ready to kill the kernel tax? The nanosecond clock is ticking.**
