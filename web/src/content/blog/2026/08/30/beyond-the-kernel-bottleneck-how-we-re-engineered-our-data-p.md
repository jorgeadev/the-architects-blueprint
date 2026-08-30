---
title: "Beyond the Kernel Bottleneck: How We Re-Engineered Our Data Plane for 100Gbps DDoS Mitigation with eBPF and XDP"
shortTitle: "Scaling 100Gbps DDoS Mitigation with eBPF and XDP"
date: 2026-08-30
image: "/images/2026/08/30/beyond-the-kernel-bottleneck-how-we-re-engineered-our-data-p.svg"
---

It’s 3:00 AM. The monitoring dashboard for our edge ingress cluster—a fleet of high-performance servers handling tens of terabytes of traffic—is bleeding red. A massive, volumetric DDoS attack is slamming our infrastructure. We’re seeing upwards of 120 million packets per second (Mpps) hitting our edge routers.

On the servers, `ksoftirqd` is pinned at 100% on every core. The traditional Linux networking stack is choking. `iptables`, usually our reliable workhorse, has become a liability; the O(N) lookup complexity of its rule chains is effectively executing a self-inflicted denial-of-service. Even with `nftables` and its hardware offload capabilities, the overhead of the `sk_buff` (socket buffer) allocation in the kernel is simply too high.

The packets are arriving faster than the kernel can decide to drop them. We are losing the war of attrition at the interrupt level.

This was the catalyst for our team to move beyond the traditional paradigm of Linux networking. We didn't just need a faster firewall; we needed to re-engineer the data plane itself. We turned to **eBPF (Extended Berkeley Packet Filter)** and **XDP (eXpress Data Path)**. This is the story of how we moved our packet processing from the middle of the kernel to the very edge of the network driver, achieving line-rate mitigation and observability at a scale that was previously the exclusive domain of expensive, proprietary ASIC hardware.

---

## The Architectural Wall: Why the Standard Stack Fails at Scale

To understand why we needed eBPF, you first have to understand the "tax" the Linux kernel imposes on every packet. In a standard networking path, when a packet arrives at the Network Interface Card (NIC):

1.  **The Hardware Interrupt:** The NIC raises an IRQ (Interrupt Request).
2.  **The Driver:** The driver handles the interrupt and allocates a `sk_buff` structure—a heavy metadata object—for the packet.
3.  **The Protocol Stack:** The packet travels through the Netfilter hooks (`prerouting`, `input`, etc.), the IP routing table, and finally reaches the socket layer.
4.  **Context Switching:** If the packet is destined for a user-space application, the system performs a context switch from kernel-space to user-space.

At **100Gbps**, a 64-byte packet arrives every **6.7 nanoseconds**. The overhead of just allocating and deallocating an `sk_buff` can exceed 50 nanoseconds. By the time the kernel even looks at the packet headers, we’ve already fallen behind. The CPU spends more time managing internal kernel data structures than actually processing traffic.

### The Hype vs. The Substance: What is eBPF Actually?

For the last three years, eBPF has been the darling of the infrastructure world. Every major tech player—from Cloudflare and Meta to Google and Netflix—has published "love letters" to BPF. But cutting through the hype is essential: eBPF is not just a "fast packet filter."

**eBPF is a sandboxed virtual machine inside the Linux kernel.** It allows you to run custom C-like code in response to kernel events (like a packet arriving, a system call, or a tracepoint) without changing the kernel source code or loading a dangerous kernel module.

The "substance" that makes eBPF a game-changer for networking is **XDP**. XDP provides a hook at the earliest possible point in the software stack: **inside the NIC driver**, before the `sk_buff` is even allocated.

---

## The New Architecture: The XDP Data Plane

Our re-engineered data plane operates on a simple philosophy: **Reject or route the packet as close to the wire as possible.**

We moved our logic into three distinct layers of XDP execution:

1.  **Offloaded XDP:** For the most aggressive volumetric attacks, we push eBPF programs directly onto the NFP (Network Flow Processor) of our SmartNICs. Here, the CPU doesn't even see the packet; the hardware drops it at the MAC layer.
2.  **Native XDP:** This is our "sweet spot." The eBPF program runs within the NIC driver's main receive loop. It has direct access to the raw DMA (Direct Memory Access) buffer.
3.  **Generic XDP:** Used mainly for testing on legacy hardware that doesn't support Native XDP (where the hook is slightly later in the stack).

### The Anatomy of an XDP Program

An XDP program is essentially a function that receives a `struct xdp_md` (metadata) pointer. It inspects the packet and returns one of five verdicts:

- `XDP_DROP`: Silently discard the packet (the holy grail for DDoS mitigation).
- `XDP_PASS`: Send the packet up to the normal Linux stack.
- `XDP_TX`: Bounce the packet back out the same interface (useful for load balancing).
- `XDP_REDIRECT`: Send the packet to a different NIC or a CPU core.
- `XDP_ABORTED`: Error state.

---

## Implementing Line-Rate DDoS Mitigation

When you are under a massive SYN flood or a UDP amplification attack, you cannot afford complex logic. You need **O(1) lookups**.

### Using BPF Maps for State

Traditional `iptables` rules are a linear list. If you have 10,000 blocked IPs, the 10,001st packet has to be checked against all 10,000 rules. In eBPF, we use **BPF Maps**—efficient, shared-memory key-value stores.

We implemented a two-stage filter:

1.  **The "Deny List" Hash Map:** A high-speed hash map containing millions of known malicious IP addresses.
2.  **The Bloom Filter:** For suspected botnets, we use a Bloom Filter map to perform probabilistic checks, minimizing memory footprint while maintaining incredibly high throughput.

### Code Deep-Dive: A Minimalist XDP Dropper

Here is a simplified look at how we perform high-speed dropping of UDP traffic on a specific port (a common vector for amplification attacks):

```c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>

// Map to store our "Blocked IPs"
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1000000);
    __type(key, __u32);   // IPv4 Address
    __type(value, __u64); // Packet Count
} drop_map SEC(".maps");

SEC("xdp")
int xdp_mitigator(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end) return XDP_PASS;

    if (eth->h_proto != __constant_htons(ETH_P_IP)) return XDP_PASS;

    struct iphdr *iph = data + sizeof(struct ethhdr);
    if ((void *)(iph + 1) > data_end) return XDP_PASS;

    // Check if the source IP is in our block list
    __u32 src_ip = iph->saddr;
    __u64 *value = bpf_map_lookup_elem(&drop_map, &src_ip);

    if (value) {
        // Atomic increment of the drop counter for observability
        __sync_fetch_and_add(value, 1);
        return XDP_DROP;
    }

    // Additional logic for port-specific mitigation...
    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

**Why this is fast:** There are no locks. There is no memory allocation in the critical path. The "Verifier" (the kernel's safety checker) ensures this code cannot crash the kernel or loop infinitely. It's JIT-compiled into native machine code the moment it's loaded.

---

## Observability: Seeing the Invisible at 100Gbps

One of the biggest pain points of high-speed networking is that **standard tools lie to you**. If you try to run `tcpdump` during a 50Mpps attack, `tcpdump` itself will cause the system to fall over due to the overhead of copying packets to user-space.

### The "Flight Recorder" Pattern

With eBPF, we decoupled packet processing from telemetry. We use **BPF Ring Buffers**—a high-performance, multi-producer, single-consumer FIFO queue that allows the kernel to push "event samples" to user-space with near-zero overhead.

Instead of capturing the whole packet, we extract only the "DNA" of the attack:

- The source/destination IP and port.
- TCP flags.
- Payload fingerprints (for identifying L7-style attacks like "Slowloris" or specific botnet signatures).

### Real-Time Introspection

We built a custom dashboard that reads from these Ring Buffers. Because the eBPF program can update BPF maps (like the `drop_map` in the code above), we get **real-time counters of dropped packets per IP** without ever leaving the kernel.

This creates a virtuous cycle:

1.  The XDP program detects a pattern (e.g., an unusual ratio of SYN to ACK packets).
2.  It sends an alert to a user-space agent via the Ring Buffer.
3.  The user-space agent, using a pre-trained ML model, confirms the attack pattern.
4.  The agent updates a BPF Map with the offending IP range.
5.  The XDP program starts dropping that range instantly.

The total "Detection to Mitigation" time? **Under 100 milliseconds.**

---

## Engineering Curiosities: The Battle with the Verifier

While eBPF sounds like magic, the engineering reality is a constant battle with the **eBPF Verifier**.

The Verifier is a pedantic gatekeeper. It performs a static analysis of your code to ensure it's safe to run in kernel-space. It checks for:

- **Out-of-bounds memory access:** You must manually check that the packet length is sufficient before reading any header (the `if (data + ... > data_end)` checks in the snippet above).
- **Code Complexity:** It used to limit programs to 4,096 instructions (now much higher, but still a factor).
- **Loop Safety:** Until recently, loops were strictly forbidden or had to be bounded and unrolled.

To build a complex DDoS engine, we had to use **Tail Calls**. Think of a Tail Call as a `goto` for eBPF programs. We split our logic into modular chunks: one program for parsing Ethernet/IP, one for TCP-specific checks, and another for our complex Bloom Filter logic. When one finishes, it "tail calls" into the next. This keeps the complexity per-program low while allowing for a sophisticated processing pipeline.

### The Memory Latency Problem

At 100Gbps, the bottleneck isn't the CPU frequency; it's the **memory subsystem**. If your eBPF program causes a cache miss (by looking up a key in a very large Hash Map that isn't in L1/L2 cache), the CPU stalls for hundreds of cycles.

We optimized this by:

- **Per-CPU Maps:** Using maps that are local to a specific CPU core to avoid the overhead of cross-core cache coherency (NUMA awareness).
- **Data Locality:** Keeping our lookup tables small enough to fit into the L3 cache of our Xeon Scalable processors.

---

## Reaping the Rewards: Compute Scale and Efficiency

By moving to an eBPF-driven data plane, the results were transformative.

1.  **DDoS Resilience:** We successfully mitigated a 1.2 Tbps multi-vector attack where the software-defined edge nodes remained responsive. CPU utilization stayed below 40%, even while dropping 200M+ packets per second.
2.  **Resource Efficiency:** Because the CPU is no longer bogged down by the kernel's networking stack, we were able to reduce our ingress cluster size by **30%**, saving significant Opex in power and cooling.
3.  **Programmability:** We are no longer beholden to the feature set of our hardware vendors. If a new type of attack emerges tomorrow, we can write, verify, and deploy a new eBPF mitigation script to our entire global fleet in seconds—without a single reboot.

## The Future of the Data Plane

The shift we’re seeing is a fundamental "unbundling" of the Linux kernel. We are moving toward a world where the kernel provides the _resources_ (memory, CPU, hardware access), but the _logic_ of how those resources are used is defined by sandboxed, high-performance eBPF programs.

As we look toward 400Gbps and 800Gbps networking, the "standard stack" will likely become a legacy path used only for management traffic. The real work—the heavy lifting of the modern internet—will happen in the eBPF programs running in the driver, the NIC, and the programmable switches.

We’ve moved past the era of static configuration files. We are now in the era of **Network Functions as Code**. For those of us building at massive scale, there's no turning back. The kernel bottleneck is broken, and the data plane is finally ours to program.
