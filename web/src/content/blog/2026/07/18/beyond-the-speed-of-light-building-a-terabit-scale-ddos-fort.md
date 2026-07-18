---
title: "Beyond the Speed of Light: Building a Terabit-Scale DDoS Fortress with eBPF XDP"
shortTitle: "Terabit-Scale DDoS Defense with eBPF XDP"
date: 2026-07-18
image: "/images/2026/07/18/beyond-the-speed-of-light-building-a-terabit-scale-ddos-fort.svg"
---

Imagine the scene: It’s 3:00 PM on a Tuesday. Your monitoring dashboard—usually a calm sea of green—suddenly turns a violent shade of crimson. In less than sixty seconds, ingress traffic on your edge routers has surged from a manageable 40 Gbps to a staggering 1.2 Tbps.

In a traditional architecture, this is the "game over" screen. Your CPU load spikes to 100%, not because of legitimate application processing, but because the Linux kernel is drowning in **interrupt storms**. Every packet arriving at the Network Interface Card (NIC) triggers a chain reaction: an IRQ is raised, the kernel allocates a `sk_buff` (socket buffer) structure, parses the headers, traverses the complex netfilter tables (iptables/nftables), and eventually realizes the packet is part of a malicious UDP flood.

By the time the kernel decides to drop the packet, the damage is done. The overhead of context switching and memory allocation has already starved your user-space applications of CPU cycles. Your service is offline.

This is the "Kernel Wall." And today, we’re going to tear it down.

In this deep dive, we’re exploring the architecture of a **Kernel-Bypass DDoS mitigation layer** using **eBPF (Extended Berkeley Packet Filter)** and **XDP (Express Data Path)**. We’re going to look at how to process packets at the driver level, before they even touch the formal networking stack, enabling us to filter millions of packets per second with negligible CPU impact.

---

## The Fatal Flaw of Traditional Networking

To understand why XDP is a revolution, we must first look at the "Standard Path" a packet takes through the Linux kernel.

When a packet arrives at a NIC, the hardware places the data into a ring buffer via DMA (Direct Memory Access). The NIC then raises a hard interrupt (IRQ). The kernel’s interrupt handler schedules a softirq (NAPI), which begins the arduous process of "Skbification."

1.  **Allocation:** The kernel allocates a `sk_buff`. This is a heavy-weight structure containing metadata for the entire life of the packet.
2.  **Metadata Initialization:** The kernel fills this structure with timestamps, interface indices, and protocol information.
3.  **Netfilter Traversal:** The packet travels through the `PREROUTING`, `INPUT`, and `FORWARD` chains. If you have a thousand `iptables` rules, the kernel evaluates them linearly.
4.  **Context Switching:** If the packet is for a user-space application, the kernel must context-switch to the process and copy the data from kernel-space to user-space memory.

At **Terabit scales**, this process is catastrophically slow. Even a high-end Xeon processor can only handle a few million `sk_buff` allocations per second per core. A 1 Tbps attack consisting of 64-byte packets represents roughly **1.48 billion packets per second (pps)**. The math simply doesn't work for the standard kernel path.

---

## Enter XDP: The Express Data Path

**XDP (Express Data Path)** is a framework within the Linux kernel that allows us to execute eBPF programs directly in the context of the network driver.

The genius of XDP lies in its **positioning**. It operates at the earliest possible point in the software stack: right after the DMA transfer from the NIC, but _before_ the kernel allocates a `sk_buff`.

### The XDP Hook Points

XDP can run in three different modes, depending on your hardware and requirements:

1.  **Offloaded XDP:** The eBPF program is JIT-compiled and loaded directly onto the NIC hardware (e.g., Netronome Agilio). The CPU never even sees the malicious packets. This is the holy grail of performance.
2.  **Native XDP:** The program runs within the network driver’s "poll" loop. Since it's in the driver, the packet data is still in the DMA buffer. This is incredibly fast and is supported by most modern 10G/40G/100G drivers (Mellanox, Intel, Broadcom).
3.  **Generic XDP (SKB Mode):** Used for testing or on drivers that don't support Native XDP. It runs after the `sk_buff` is allocated, so you lose the performance benefits, but keep the programmatic flexibility.

### The Verdict: The Four Actions

Every XDP program must return one of four verdicts for every packet:

- **`XDP_DROP`:** The packet is discarded immediately. No memory is allocated, no IRQs are passed up. This is our primary tool for DDoS mitigation.
- **`XDP_PASS`:** The packet is passed up to the regular Linux networking stack.
- **`XDP_TX`:** The packet is sent back out of the same interface it arrived on (useful for load balancing or hair-pinning).
- **`XDP_ABORTED`:** An error occurred; the packet is dropped (and a tracepoint is triggered).

---

## Architecture: The Terabit-Scale Mitigation Layer

Building a production-grade mitigation layer requires more than just dropping packets. It requires a stateful, programmable, and observable architecture. Here is how we build it.

### 1. The eBPF Virtual Machine and JIT

eBPF is essentially a RISC register-based virtual machine within the kernel. It has 10 registers, a 512-byte stack, and can access "Maps" for persistent state. When we load our C-based XDP program, the kernel **Verifier** ensures the code is safe (no infinite loops, no out-of-bounds memory access). Once verified, the **JIT (Just-In-Time) compiler** converts the eBPF bytecode into native x86_64 or ARM64 instructions.

This means our mitigation logic runs at **native hardware speed**.

### 2. Stateful Filtering via BPF Maps

A stateless firewall is easy to bypass. To stop sophisticated attacks (like low-and-slow or amplification attacks), we need state.

We use **BPF Maps**—key-value stores shared between the kernel and user-space—to store:

- **Allow-lists/Block-lists:** IP ranges that are known good or known bad.
- **Rate-limiting Counters:** Per-IP or per-subnet packet counts.
- **Flow State:** Track SYN/ACK handshakes to prevent SYN flooding.

### 3. The "Two-Stage" Mitigation Pipeline

To handle terabit traffic, we decouple the **Data Plane** from the **Control Plane**.

- **The Data Plane (Kernel/XDP):** A lean eBPF program that does the heavy lifting. It checks a `Hash Map` for blocked IPs. If a match is found, `XDP_DROP`. If not, it increments a counter in a `Per-CPU Array Map` and returns `XDP_PASS`.
- **The Control Plane (User-space Go/Rust):** A high-level service that monitors the Maps. It pulls telemetry, analyzes traffic patterns using ML or heuristics, and pushes "blocking" entries into the BPF Maps in real-time.

---

## Show Me the Code: Implementing a Simple XDP Drop Filter

Let’s look at a snippet of the eBPF code (C) that powers the edge. This program inspects incoming packets and drops traffic from a specific blocked IP list stored in a Map.

```c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>

// Define a map to store blocked IPv4 addresses
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1000000); // Scale to 1M blocked IPs
    __type(key, __u32);           // IPv4 Address
    __type(value, __u8);          // Dummy value
} blocked_ips SEC(".maps");

SEC("xdp")
int xdp_mitigation_filter(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    // Boundary check: Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    // We only care about IP traffic
    if (eth->h_proto != __constant_htons(ETH_P_IP))
        return XDP_PASS;

    // Boundary check: IP header
    struct iphdr *iph = (void *)(eth + 1);
    if ((void *)(iph + 1) > data_end)
        return XDP_PASS;

    // Lookup the source IP in our "blocked" map
    __u32 src_ip = iph->saddr;
    __u8 *blocked = bpf_map_lookup_elem(&blocked_ips, &src_ip);

    if (blocked) {
        // THE MAGIC MOMENT: Dropping without context switching!
        return XDP_DROP;
    }

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

### Why This Is Fast

1.  **No `sk_buff`:** We are operating on the raw `xdp_md` context, which points directly to the DMA memory.
2.  **No Memory Copying:** We inspect the headers in-place.
3.  **Map Lookups are O(1):** Using a BPF Hash Map allows for near-instant lookup regardless of whether we are blocking 100 or 1,000,000 IPs.
4.  **CPU Affinity:** eBPF Maps can be `BPF_MAP_TYPE_PERCPU_HASH`, meaning each CPU core has its own local cache of the map, eliminating lock contention (atomic operations) across cores.

---

## Scaling to Terabits: The Engineering Reality

Implementing the code above is only 20% of the battle. To reach **Terabit scale**, we have to address the hardware and infrastructure realities of high-speed networking.

### The PCIe Bottleneck

At 100 Gbps and above, the bottleneck often shifts from the CPU to the PCIe bus. A single PCIe 3.0 x16 slot caps out around 126 Gbps. To hit Terabit scale, you aren't using one server; you're using an **ECMP (Equal-Cost Multi-Path)** cluster.
Your edge routers distribute the 1.2 Tbps of traffic across, say, 20 servers, each equipped with 100G Mellanox NICs. Each server is now responsible for 60 Gbps—a volume that XDP can handle with just a fraction of its CPU cores.

### RSS and Multi-Queue NICs

Modern NICs use **Receive Side Scaling (RSS)** to distribute incoming packets across multiple hardware queues. Each queue is handled by a different CPU core.
Because XDP runs within the driver's poll loop, it scales linearly with the number of CPU cores and queues. If you have a 32-core CPU, XDP can run 32 parallel instances of your mitigation logic, processing packets in lock-step without ever needing to communicate between cores.

### The "Instruction Budget"

To process 100 Gbps of small packets (64 bytes), a CPU has roughly **10 nanoseconds** to process each packet.
This means our eBPF program must be incredibly lean. Every helper function call, every complex calculation, and every map lookup adds latency. We often use **Bloom Filters** in eBPF as a pre-filter to our Hash Maps. A Bloom Filter can tell us with 100% certainty if an IP is _not_ in the block-list with a single bit-check, saving us the cost of a full hash lookup.

---

## Moving Beyond Simple Drops: Challenges and Innovations

As DDoS attackers evolve, so must our eBPF programs. Modern mitigation layers don't just drop by IP; they perform deep packet inspection (DPI) and protocol verification.

### Handling UDP Amplification (Memcached, NTP, DNS)

Attackers often use spoofed UDP packets to reflect massive amounts of data from vulnerable servers. To mitigate this, our XDP program can implement a **Stateless Cookie** mechanism.
When a UDP packet arrives, we can hash the packet's contents (IPs, Ports, Payload) and compare it against a known "signature" of the attack. By using `BPF_MAP_TYPE_LPM_TRIE`, we can perform longest-prefix matching to block entire subnets that are participating in an amplification event.

### The TCP SYN Flood Problem

TCP SYN floods are tricky because dropping the SYN packet also prevents legitimate users from connecting.
Advanced XDP implementations use **SYN Cookies**. The XDP program intercepts the incoming SYN, generates a cryptographic cookie, and sends a SYN-ACK back to the client (`XDP_TX`) _without creating any state in the kernel_. Only if the client responds with a valid ACK (completing the handshake) does the XDP program allow the traffic to pass up to the kernel. This protects the kernel's connection table from being exhausted.

### Observability at Scale

You cannot manage what you cannot measure. In the eBPF world, we use **Ring Buffers** (`BPF_MAP_TYPE_RINGBUF`).
When the XDP program drops a packet, it can asynchronously push a small metadata struct (the source IP, the reason for the drop, the timestamp) into the Ring Buffer. A user-space daemon reads this buffer and pushes the data to Prometheus or ClickHouse. This gives us real-time, per-packet visibility into the attack without slowing down the fast-path.

---

## Why This Matters: The Economics of Defense

The traditional approach to DDoS mitigation involved buying expensive, proprietary hardware appliances (ASICs) that sat in front of your data center. These boxes were black boxes; they were hard to program, hard to update, and incredibly expensive to scale.

**eBPF and XDP have commoditized high-performance networking.**

By moving the mitigation logic into the software layer—specifically the Linux kernel—we can use standard COTS (Commercial Off-The-Shelf) hardware. We can update our mitigation logic in milliseconds without a reboot. We can leverage the entire LLVM compiler toolchain to optimize our code.

At companies like Cloudflare and Meta, eBPF/XDP is no longer a "niche experiment"; it is the foundation of the edge. Cloudflare’s `L4Drop` and `bpftools` have demonstrated that a software-defined edge can outperform hardware appliances while providing significantly more flexibility.

---

## The Path Forward: AF_XDP and Zero-Copy

While this post focused on `XDP_DROP` for mitigation, the ecosystem is moving even further with **AF_XDP**.
AF_XDP is a socket address family that allows for **Zero-Copy** packet transfer from the NIC directly to user-space. It bypasses the entire kernel networking stack but keeps the kernel in charge of memory management and security.

For developers, this means we can write DDoS mitigation logic in high-level languages like Rust (using the `aya` or `libbpf-rs` crates) while maintaining the performance of a kernel-level C program.

The "Kernel Wall" isn't just being bypassed; it's being redesigned. We are entering an era where the boundary between the driver, the kernel, and the application is fluid—governed by the safety and speed of eBPF bytecode.

If you're still relying on `iptables` to protect your infrastructure from terabit-scale attacks, the clock is ticking. It's time to move your logic to the Express Data Path. The speed of light is waiting.
