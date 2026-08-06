---
title: "The Packet Slaughterhouse: How We Use eBPF and XDP to Crush Terabit-Scale DDoS at the Edge"
shortTitle: "Crushing Terabit-Scale DDoS at the Edge with eBPF and XDP"
date: 2026-08-06
image: "/images/2026/08/06/the-packet-slaughterhouse-how-we-use-ebpf-and-xdp-to-crush-t.svg"
---

It’s 3:00 AM. Your monitoring dashboard just turned into a sea of crimson. Incoming traffic on your edge nodes has spiked from a comfortable 40 Gbps to a staggering 1.2 Tbps in less than thirty seconds. This isn't just a spike; it’s a coordinated, multi-vector volumetric assault.

In the old days of Linux networking, your servers would already be dead. The kernel's networking stack—as robust as it is—simply wasn't built to handle millions of malicious packets per second hitting the NIC. You’d see the `ksoftirqd` process pinned to 100% on every CPU core, the system would stop responding to interrupts, and your "high-availability" architecture would become a very expensive collection of space heaters.

But today, your edge remains calm. Latency for legitimate users hasn't budged more than 2ms. Why? Because instead of letting those packets crawl through the kernel’s complex routing and filtering layers, you are executing code directly on the network card’s doorstep.

Welcome to the world of **eBPF (Extended Berkeley Packet Filter)** and **XDP (eXpress Data Path)**—the technology that turned the Linux kernel into a programmable, high-speed packet-processing beast.

---

## The Bottleneck: Why the Standard Kernel Stack Fails

To understand why we need XDP, we have to talk about the `sk_buff`.

In a standard Linux networking path, when a packet arrives at the Network Interface Card (NIC), the driver allocates a metadata structure called an `sk_buff` (socket buffer). This structure is massive. It contains everything the kernel might ever need to know about that packet as it travels through the firewall (iptables/nftables), the routing table, and finally to a user-space socket.

The problem? **Allocating and deallocating `sk_buff` is expensive.**

When you are under a 1-terabit DDoS attack, you aren't dealing with a few large files. You are dealing with hundreds of millions of tiny 64-byte packets. If the kernel has to allocate a complex metadata structure for every single one of those malicious packets just to realize five milliseconds later that it should have dropped them, you’ve already lost. The CPU cycles spent on memory management and cache misses will choke the system long before the packets ever reach your application.

## Enter XDP: The "Fast Path"

XDP changes the game by moving the decision point. Instead of waiting for the kernel to "ingest" the packet, XDP allows us to run a custom eBPF program **at the earliest possible point in the software stack**: directly in the NIC driver's receive ring, before the `sk_buff` is even allocated.

### The XDP Hook Points

XDP can run in three modes, depending on your hardware and requirements:

1.  **Offloaded XDP:** The eBPF program is pushed directly onto the NIC’s hardware (NFP - Network Flow Processor). The packet never even touches the host CPU. This is the holy grail of performance.
2.  **Native XDP:** The program runs inside the NIC driver. This is incredibly fast because it happens before the kernel gets its hands on the data.
3.  **Generic XDP:** A "fallback" mode for drivers that don't support XDP natively. It’s slower than Native mode but still faster than traditional iptables because it bypasses much of the upper-layer stack.

---

## The Anatomy of an eBPF Program

eBPF is essentially a sandboxed Virtual Machine (VM) running inside the Linux kernel. It allows developers to run "safe" C code (compiled into BPF bytecode) in response to events—like a packet arriving.

### Why "Safe"?

Historically, if you wanted to change how the kernel handled packets, you had to write a Kernel Module. If your module had a bug (like a null pointer dereference), the whole system crashed (Kernel Panic).

eBPF uses a **Verifier**. Before your code is allowed to run, the Verifier analyzes it to ensure:

- It doesn't loop infinitely.
- It doesn't access out-of-bounds memory.
- It is small enough to not cause latency spikes.

Once verified, the code is **JIT-compiled (Just-In-Time)** into native machine instructions for your CPU (x86 or ARM64), making it run at near-native speeds.

### A Minimal XDP "Dropper"

Here is what a basic XDP program looks like in C. This program inspects a packet and drops it if it’s a UDP packet on a specific "attack" port.

```c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>

SEC("xdp")
int xdp_drop_udp_flood(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if (data + sizeof(*eth) > data_end)
        return XDP_PASS;

    if (eth->h_proto != __constant_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *iph = data + sizeof(*eth);
    if (data + sizeof(*eth) + sizeof(*iph) > data_end)
        return XDP_PASS;

    if (iph->protocol == IPPROTO_UDP) {
        struct udphdr *udp = data + sizeof(*eth) + sizeof(*iph);
        if (data + sizeof(*eth) + sizeof(*iph) + sizeof(*udp) > data_end)
            return XDP_PASS;

        // The "Signature" of our attack
        if (udp->dest == __constant_htons(1234)) {
            return XDP_DROP; // The packet dies here. No sk_buff allocated.
        }
    }

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

In a real-world scenario, we wouldn't hardcode a port. We would use **eBPF Maps**.

---

## Scaling to Terabits: The Hyper-Distributed Edge

When we talk about "Terabit-Scale," we aren't talking about a single server. We are talking about an Anycast network—a hyper-distributed architecture where a single IP address is advertised from hundreds of locations worldwide.

### The State Management Problem

DDoS mitigation at the edge is a game of **Global Intelligence vs. Local Enforcement.**

1.  **Local Enforcement:** Each edge node runs XDP programs to drop packets based on local thresholds (e.g., "If I see >100k PPS from this IP, drop it").
2.  **Global Intelligence:** A central control plane analyzes telemetry from all nodes. If Node A in London sees a new attack pattern, it pushes a "Blacklist Update" to Node B in Tokyo and Node C in New York within milliseconds.

### Using eBPF Maps for Dynamic Mitigation

eBPF Maps are key-value stores that can be shared between the kernel-space (where the XDP program runs) and user-space (where your management daemon lives).

- **LPM Trie Maps:** Perfect for storing millions of IP prefixes for CIDR-based blocking.
- **LRU Hash Maps:** Used to track "seen" IP addresses and their request rates.
- **Per-CPU Arrays:** Used for high-performance counters (e.g., "How many packets did I drop in the last second?").

In a hyper-distributed setup, a user-space agent (written in Go or Rust) listens to a global gRPC stream of attack signatures. When a signature is identified, the agent calls `bpf_map_update_elem()`, and **instantly**, the XDP program starts dropping that traffic. No reboots, no firewall reloads, and zero impact on the rest of the stack.

---

## The "Hype" Context: Why eBPF is Having a Moment

If you’ve been following the CNCF landscape, you’ve heard of **Cilium**, **Falco**, and **Pixie**. There is a massive wave of hype around "Observable Infrastructure," and eBPF is the engine driving it.

### Why the Hype is Real

For the last decade, we've tried to solve networking problems by wrapping them in layers of virtualization (Sidecars, Service Meshes, Overlays). But these layers add "latency tax."

The industry is currently realizing that **The Kernel is the Service Mesh.**

Instead of injecting a Sidecar proxy (like Envoy) into every pod—which requires context switching and copying data between user and kernel space—we can use eBPF to intercept traffic at the socket level. This provides:

1.  **Visibility:** See every syscall and packet without changing a line of application code.
2.  **Security:** Deep Packet Inspection (DPI) at line rate.
3.  **Efficiency:** Bypassing the heavy parts of the TCP/IP stack for internal service-to-service communication (Local Redirection).

---

## Advanced Tactics: Beyond Simple Dropping

True terabit-scale mitigation isn't just about dropping packets; it's about being clever enough to separate the "signal" from the "noise" without annoying the users.

### 1. XDP_TX: The Reflector Hook

One common DDoS vector is the **Reflection Attack** (DNS or NTP amplification). With XDP, we can implement "XDP_TX." If we detect a spoofed packet, we can rewrite the headers in-place and send it back out the same interface it came in on.

Imagine a "Mirror" defense: We reflect the attack traffic back at the source (or a honeypot) with zero overhead. Since we aren't moving the data to user-space or even the upper kernel, we can reflect traffic at the maximum line rate of the hardware.

### 2. Programmable Flow Cookies (SYN Cookies)

TCP SYN floods are the bread and butter of attackers. Normally, the kernel handles SYN cookies, but it does so only after the `sk_buff` is created. By implementing SYN Cookie generation and verification in XDP, we can validate that a connection request is coming from a real browser _before_ we ever let the kernel know a connection is being attempted.

### 3. Rate-Limiting with Token Buckets

Using eBPF Maps, we can implement a **Leaky Token Bucket** algorithm in about 20 lines of C code.

- **Key:** Source IP.
- **Value:** Last seen timestamp + current token count.
  Each incoming packet "consumes" a token. If the bucket is empty, `return XDP_DROP`. This allows us to allow "bursty" legitimate traffic while strictly capping the throughput of any single attacker.

---

## Infrastructure Realities: The Engineering "Gotchas"

It sounds like magic, but implementing this at scale has significant engineering hurdles.

### 1. Memory Safety and the Verifier

The eBPF Verifier is a strict taskmaster. You cannot have arbitrary loops. If you want to parse a packet with many layers of encapsulation (e.g., VXLAN over IPv6), the Verifier might reject your code because it can't prove the code will finish in a finite number of steps.
**The Solution:** Use bounded loops (supported in kernels 5.3+) and `#pragma unroll`.

### 2. CPU Cache Locality

Even with XDP, you can hit a wall. If your eBPF program accesses a massive Hash Map (millions of entries), you will suffer from **LLC (Last Level Cache) misses**.
**The Solution:** Use Per-CPU maps to ensure that each CPU core is working on its own local memory segment as much as possible, reducing the need for expensive cross-core synchronization (locking).

### 3. The "Tail Call" Architecture

Complex mitigation logic can exceed the maximum instruction limit for a single eBPF program. To solve this, we use **Tail Calls**. Think of this as "Function Hooking" for BPF. Program A does the initial parsing, then "tail calls" into Program B, which handles the specific DDoS logic. This keeps the code modular and bypasses the instruction limit.

---

## Performance: The Numbers Speak

To put the scale into perspective, let’s look at some representative benchmarks comparing traditional methods against an XDP-optimized stack on a standard 100GbE NIC:

- **iptables (Standard Kernel):** Can handle ~600,000 to 1,000,000 packets per second (PPS). After that, the CPU is saturated with softirqs.
- **nftables (Optimized):** Can reach ~2,000,000 PPS.
- **XDP (Native Mode):** Can comfortably process **20,000,000 to 30,000,000 PPS per CPU core.**

In a multi-core system (e.g., a 32-core EPYC or Xeon), XDP can handle hundreds of millions of packets per second—enough to swallow a terabit-scale attack whole without dropping a single legitimate connection.

---

## The Future: The Programmable Data Plane

We are moving away from the era of "Fixed-Function Networking." In the past, you bought a firewall, and you were stuck with the features the vendor gave you. In the hyper-distributed edge of the future, the network is code.

By leveraging eBPF and XDP, we’ve moved the "security perimeter" from a centralized appliance in a data center to a dynamic, programmable layer that lives within millimeters of the wire. We aren't just mitigating DDoS; we are redefining what the Linux kernel is capable of.

So, the next time a terabit-scale storm hits your infrastructure at 3:00 AM, you won't need to wake up the whole SRE team. Your XDP programs will already be at the gates, silently slaughtering the malicious packets and keeping the internet running, one BPF instruction at a time.
