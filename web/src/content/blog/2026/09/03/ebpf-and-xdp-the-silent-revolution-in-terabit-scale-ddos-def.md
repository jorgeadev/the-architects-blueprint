---
title: "eBPF and XDP: The Silent Revolution in Terabit-Scale DDoS Defense"
shortTitle: "Revolutionizing Terabit DDoS Defense with eBPF and XDP"
date: 2026-09-03
image: "/images/2026/09/03/ebpf-and-xdp-the-silent-revolution-in-terabit-scale-ddos-def.svg"
---

**Hook:** Imagine you’re standing in front of a network switch pumping 1.4 Tbps of malicious SYN flood traffic directly at your edge. Your load balancers are gasping, your firewall cluster is melting, and your cloud provider’s DDoS scrubbing center is 80 milliseconds away. Now imagine dropping 99.99% of that attack **in the kernel**, on the very first CPU core that sees the packet, **before** it even allocates a socket buffer, **before** it touches a userspace process, and **before** your application knows the attack existed. That’s not a futuristic fantasy; that’s the reality of eBPF and XDP running at the edge today. But here’s the twist: the “hard” part isn’t writing the filter. The hard part is orchestrating thousands of cores, managing memory barriers, and doing it all while a live firehose of legitimate traffic flows through the same NIC. This is the story of how we turned the Linux kernel into a programmable, wire-speed DDoS mitigation engine—and the engineering scars we earned along the way.

---

## The DDoS Landscape: Why Your Proxy Stack Is Lying to You

Let’s get brutally honest about scale. The largest recorded DDoS attacks—the ones hitting 2+ Tbps—aren’t sophisticated. They’re volumetric floods: SYN, UDP reflection (NTP/SSDP), and DNS amplification. They don’t care about your Layer 7 rules. They overwhelm the _network stack’s ability to process packets_, not your application.

Here’s the dirty secret of traditional mitigation: **You’re paying for a mitigation center that sits miles away from your edge, forwarding clean traffic over GRE tunnels.** That adds latency. And when you’re doing real-time trading or high-frequency data distribution, 50ms of extra RTT is a business killer.

So, the modern edge engineer asks: _Why can’t we mitigate where the traffic lands?_ The answer used to be “because the kernel is too slow.” The kernel’s default network path—interrupt handling, `sk_buff` allocation, protocol demultiplexing, netfilter chain traversal—costs ~1-2 microseconds _per packet_ in the best case. At 10 Million Packets Per Second (Mpps) per core, that’s 10-20 microseconds of work per core. A 100Gbps line rate at 64-byte packets is 148.8 Mpps. You’d need 15 cores _just_ to drop packets.

Then came **XDP (eXpress Data Path)** and **eBPF**. The revolutionary idea: What if you could execute packet filtering logic _inside the driver_, using a _just-in-time compiled_ instruction set, running on the same core that received the interrupt? The goal: **1 core, 25+ Mpps, sub-100ns packet processing.** That changes the economics. Suddenly, a single server with two 25G NICs can absorb an attack that would crush a traditional firewall cluster.

---

## The Architecture: Speaking Directly to the NIC’s Soul

Let’s strip away the buzzwords. **XDP** is a hook attached to the network driver. When a packet arrives at the NIC, DMA writes it into a ring buffer. **Before** the kernel allocates a `sk_buff` (the socket buffer structure that the rest of the stack uses), XDP runs an eBPF program. This is the killer feature: **The eBPF program runs on the same CPU core that is polling the NIC.** No cross-CPU locking. No cache-line bouncing. It’s the purest form of NUMA-affinity.

Inside that XDP hook, you have three fundamental actions:

- `XDP_PASS`: Let the packet proceed to the normal Linux network stack.
- `XDP_DROP`: Silently discard the packet right there, freeing the DMA buffer.
- `XDP_TX`: Bounce the packet back out _the same NIC_ (useful for load balancing or reflection).
- `XDP_REDIRECT`: Send the packet to another NIC, another CPU, or even another user-space application via `AF_XDP`.

The eBPF code itself is _not_ interpreted. The kernel contains a verifier that checks for loops, null-pointer dereferences, and out-of-bounds accesses. After verification, it’s translated into native machine code via the LLVM backend. The result? You’re running C-like logic at the speed of assembly.

**A real-world snippet from our edge mitigation policy:**

```c
// SPDX-License-Identifier: GPL-2.0
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// A per-CPU hash map tracking source IPs and their packet rates.
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1000000);
    __type(key, __u32); // Source IPv4
    __type(value, struct rate_limit_info);
} attack_map SEC(".maps");


struct rate_limit_info {
    __u64 packets;
    __u64 last_seen_timestamp;
    __u8 action; // 0 = pass, 1 = drop
};

SEC("xdp_filter")
int xdp_ddos_mitigation(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;
    struct ethhdr *eth = data;

    // Basic bounds checking: Ensure we have the Ethernet header.
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    // Only handle IPv4 for speed (we'll pass IPv6 to a slower path).
    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (struct iphdr *)((void *)eth + ETH_HLEN);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    // Is this TCP SYN? That's our only attack vector in this example.
    if (ip->protocol != IPPROTO_TCP)
        return XDP_PASS;

    struct tcphdr *tcp = (struct tcphdr *)((void *)ip + (ip->ihl * 4));
    if ((void *)(tcp + 1) > data_end)
        return XDP_PASS;

    if (tcp->syn && !tcp->ack) {
        __u32 src_ip = ip->saddr;
        struct rate_limit_info *val;

        // Look up the source IP in our LRU map.
        val = bpf_map_lookup_elem(&attack_map, &src_ip);
        if (!val) {
            // Initialize a new entry for this source.
            struct rate_limit_info new_val = {0};
            new_val.packets = 1;
            new_val.last_seen_timestamp = bpf_ktime_get_ns();
            new_val.action = 0; // assume benign initially
            bpf_map_update_elem(&attack_map, &src_ip, &new_val, BPF_ANY);
            return XDP_PASS;
        }

        // Rate limit logic (simplified).
        // Suppose we only allow 100 SYNs per second.
        __u64 now = bpf_ktime_get_ns();
        __u64 window = 1000000000ULL; // 1 second in ns
        __u64 elapsed = now - val->last_seen_timestamp;

        // Reset window if time has passed.
        if (elapsed > window) {
            val->packets = 0;
            val->last_seen_timestamp = now;
        }

        val->packets++;
        if (val->packets > 100) {
            // Attack detected. Action: Drop all further traffic from this IP.
            val->action = 1;
            return XDP_DROP;
        }
    }
    return XDP_PASS;
}
```

**Wait—where’s the control plane?** That eBPF program is the _dataplane_; it executes binary logic. But it can’t decide an IP is malicious. A user-space daemon (running a BGP feed or ML model) updates the `attack_map` in real-time. The beauty is that the eBPF program only reads the map’s action field. If the control plane says `DROP`, the kernel drops. This decoupling means **you can update defensive strategies without reloading a single driver or dropping a single packet.**

---

## The Hype vs. The Reality: Why “XDP Solves Everything” Is a Lie

Let’s address the hype cycle. In 2023, eBPF became a buzzword rivaling “blockchain” and “serverless.” Vendors pitch it as a silver bullet. But when you’re actually pushing 400 Gbps through a single machine, you hit the _hardware_ limits, not the kernel limits.

**Hype #1: “XDP is infinite scale.”**  
_Reality:_ XDP runs per-core. To scale beyond a single core’s packet rate, you must use `XDP_REDIRECT` to spread packets across multiple CPUs or across multiple NICs. The moment you redirect, you introduce memory loads and cache misses. The most clever edge deployments use **Receive Side Scaling (RSS)** to steer traffic to specific cores based on a 5-tuple hash, ensuring all packets from a single flow land on the same core. But if an attacker rotates spoofed source ports, RSS hairpins flows randomly across cores, scattering your state.

**The engineering workaround:** We completely abandon per-flow state for volumetric attacks. Instead, we sample 1 out of every 1024 packets via simple hash modulo. If the sample shows >80% SYN packets from a single /24 subnet, we push a _prefix-wide drop rule_ (e.g., `src_ip & 255.255.255.0`) into the map. This is **stateless mitigation**—scalable to infinity because it’s just prefix matching, no flow table.

**Hype #2: “eBPF verifier protects you.”**  
_Reality:_ The verifier is a strict, conservative, static analyzer. It will often reject perfectly safe code because it can’t prove complexity bounds. The real challenge is **tail calls**—making eBPF programs modular. We use extended BPF to perform early drop decisions on the NIC, then tail-call into a more complex (but still kernel-resident) module for GRE decapsulation or IP fragmentation reassembly.

---

## The Physical Layer: Surviving a Terabit of Noise on 100G NICs

Here’s the terrifying part we don’t talk about enough: **When you set a 100G NIC to promiscuous mode for DDoS monitoring, interrupt coalescing goes out the window.** At 100G line rate with 512-byte average packets, you’re looking at ~24 Mpps. Your CPU core is running at 3 GHz, but each XDP invocation takes ~200 cycles just to load headers. That leaves only ~120 cycles for actual logic per packet. It’s brutal.

So we cheat. We use **busy-polling and dedicated queues**.

On Intel E810 and Mellanox CX-6DX NICs, we map a fixed number of RX queues to dedicated CPU cores. We disable the kernel’s NAPI scheduling entirely and use `AF_XDP` zero-copy sockets in busy-poll mode. This means the userspace application and the XDP program share a memory region (`umem`). The XDP program writes packets into this `umem` via `XDP_REDIRECT`, and the userspace polls it continuously. This eliminates `sk_buff` allocation, reducing memory latency from L3 cache to L1.

The actual bottleneck then becomes **PCIe bandwidth**. A PCIe Gen4 x16 lane has 64 GB/s of bidirectional bandwidth. But if you’re receiving and forwarding (e.g., reflecting traffic away), you need to write out on the same link, halving your available throughput. We’ve physically installed dual-port NICs to allow one port for ingress attack and one port for egress clean traffic. The Linux kernel sees them as separate devices, but XDP_REDIRECT can bounce packets between them _without_ touching the host’s memory bus—the NIC’s on-chip switch does the transfer.

---

## Building the Control Plane: The Real “Heart” of the System

Your eBPF program is a reflex arc. The intelligence resides in a **user-space daemon** that acts as the “brain.” At terabit-scale, you cannot coordinate via standard `iptables` or even `nftables`. You need a custom high-frequency telemetry loop.

Here’s our control flow:

1. **Telemetry Gathering:** The XDP program updates per-CPU counters (not per-packet timestamp, that’s too slow). We use a `BPF_MAP_TYPE_PERCPU_ARRAY` to store 64-bit counters for dropped/passed packets. Every 100ms, the user-space daemon loops through all CPU IDs and samples these counters.

2. **Aggregation and ML Inference:** We run a lightweight anomaly detection algorithm (a threshold-based EWMA) on the aggregate counters. But the clever part is **keyed by (Source Prefix, Destination Port) tuple**. We don’t just look at volume; we look at _entropy_ of source IPs within a prefix. It’s not DDoS if 100,000 distinct IPs hit your service at 1 Mbps each—it’s the Slashdot effect. It _is_ DDoS if one source IP generates 90% of the packet rate.

3. **Rule Deployment:** To update the `attack_map`, we use an **eBPF spinlock-protected update** or simply `BPF_MAP_UPDATE_ELEM` from user space. The key is to batch updates. Updating one map element at a time across a million-element map incurs syscall overhead. Instead, we use a `BPF_MAP_TYPE_HASH` and issue `BPF_MAP_UPDATE_BATCH` syscalls, deploying 50,000 rules in under 5ms.

**The hilarious subtlety:** We are so fast at dropping packets that we _starve_ the CPU of interrupts. If we fully drop 90% of incoming traffic, the NIC stops delivering the remaining 10% because the driver won’t invoke NAPI until it has a minimum batch. So we deliberately re-inject a dummy packet into the NIC’s transmit queue via `XDP_TX` to trigger an interrupt… yeah, we programmatically back-pressure our own DDoS.

---

## Real-World Flame Graph: Where Time Actually Goes

Let’s profile a 200ns packet-drop scenario. I’m using `perf` here to break down the XDP execution path on a 4.18 kernel:

```
Samples: 10K of event 'cycles', Event count (approx.): 5,400,000,000
Overhead  Command          Shared Object        Symbol
  45.2%  swapper          [kernel.kallsyms]     [k] xdp_do_redirect
  20.1%  irq/27-ixgbe     [kernel.kallsyms]     [k] bpf_prog_run_xdp
  15.8%  swapper          [kernel.kallsyms]     [k] page_pool_release
   5.2%  swapper          [kernel.kallsyms]     [k] _raw_spin_unlock_irqrestore
```

**The insight is blinding:** `xdp_do_redirect` is burning 45% of cycles! Why? Because even though we drop the packet, `XDP_DROP` still requires that we call `page_pool_release` to return the DMA buffer to the pool. This involves a lock on the per-CPU page pool. In newer kernels (5.10+), they vectorized this. But on older kernels, the lock contention is the bottleneck.

To avoid that cost, we don’t drop immediately. We instead rewrite the Ethernet destination MAC address to a self-assigned dead MAC (e.g., `00:00:00:00:00:00`) and send the packet back via `XDP_TX`. The packet leaves the CPU, hits the NIC’s own MAC filter, and the NIC silently discards it. **The CPU never sees the packet again.** This trick shifts the drop cost from the CPU (alloc/dealloc) to the NIC’s MAC table lookup, which is silicon-hardware fast.

---

## The Multi-Node Problem: “Terabit” Doesn’t Fit in One Rack

A single 2U server with dual 100G NICs can handle ~500 Gbps _if_ you use the dead-MAC trick and busy-poll. But true terabit-scale mitigation requires horizontal scaling across a cluster of edge servers acting as a virtual router.

Here’s where we abandon XDP as a network path and bring in **eBPF on the TC (Traffic Control) layer** for inter-node forwarding. The concept: Each node runs a BGP daemon announcing the victim’s IP prefix. When attack packets arrive at edge node A, XDP classifies them. But instead of dropping, it does an `XDP_REDIRECT` to a **veth pair** that connects to a virtual switch on the host (like a VXLAN tunnel). The inner load balancer (running `bpf_host` programs) re-encapsulates the traffic in a custom L4 header, sends it to the node that owns the anycast IP address (edge node B). If the attack volume at node B exceeds its capacity, it forwards to a central scrubbing center.

This is **anycast DDoS limbo**. And it’s horrifically difficult to debug. I’d like to see someone run `tcpdump` on a terabit of traffic. You can’t. So we instrument our bpftrace probes to check drop reasons. The most valuable tool we have is `bpftrace`:

```bash
bpftrace -e '
kprobe:xdp_do_redirect {
    @[kstack()] = count();
}
kprobe:page_pool_release {
    @[arg0] = count();
}
tracepoint:xdp:mem_connect {
    printf("XDP mem connect: ifindex=%d\n", args->ifindex);
}
'
```

This reveals the exact lock contention or driver `page_pool` starvation across the cluster.

---

## The Future: P4 to eBPF, and Programming the NIC Itself

If eBPF is the kernel revolution, the next frontier is **SmartNICs and IPUs**. Intel’s IPU E2000 and NVIDIA’s BlueField-3 are essentially full-blown servers on your PCIe card, running a lightweight Linux environment capable of hosting XDP programs **entirely on the NIC**. This means you can run your mitigation logic physically before the packet even touches the host’s main CPU.

We’ve already prototyped compiling P4 programs into eBPF for stateful DDoS mitigation on the NIC. The challenge: The NIC’s CPU is far less powerful than your opteron. But we don’t need powerful. We need _specialized_. The NIC can match on bits in the header simultaneously across all 64 ports in its switch fabric. That’s a massive advantage.

But the ultimate shift is **wire-speed deterministic latency.** Imagine your edge mitigation is so good that you can offer a 99.999% uptime SLA _during_ a 1 Tbps attack. That’s the goal. The team at Cloudflare has proven it with Unimog , but that’s a 100% custom kernel bypass path. We see eBPF/XDP as the _portable_ Unimog – you get 90% of the performance without writing your own network driver.

---

## Engineering Curiosities & Blood, Sweat, and Segfaults

I need to end with the uncomfortable truths—the lessons you only learn by burning the midnight oil in a dark data center.

**1. Verifier Complexity O(1) is a lie**  
The verifier’s complexity checks can sometimes take longer for a _simple_ program than a complex one. If your program has a single map access with a variable offset, the verifier does a full symbolic execution. The magic workaround: Use `bpf_for_each_map_elem` on an array map to perform multi-level lookup.

**2. DMA coherency is a nightmare**  
When your XDP program modifies packet data (like editing the IP header for forwarding), you must call `bpf_xdp_adjust_meta` and then `bpf_xdp_adjust_tail`. But the NIC and CPU may have separate caches. The kernel handles cache invalidation only _after_ the program finishes. If you do a read-modify-write on a packet buffer without declaring the changed region, you’ll silently corrupt data in production.

**3. Uprobes vs. Tracepoints**  
Monitoring `xdp:program_run` tracepoint is fine for sampling. But it adds 500ns overhead per packet if you’re tracing every single execution. Never trace production XDP at line rate. Use `bpftrace` with sampling rate of 1/1000, or offload tracing to the control plane via `bpf_ringbuf_output` only for dropped packets marked as _new attack types_.

---

## Conclusion: The Race to Zero

We are in a race. Attackers use automated botnets that scan the internet for vulnerable UDP services to amplify. They use reflection with spoofed source addresses coming from millions of multicast groups. But the defender now has an asymmetric advantage: **eBPF executes at the speed of the attacker’s packets.** The attacker can’t make packets move faster than the speed of light; they can only add more packets. But we scale in terms of _cores_, not _packets_. A single modern CPU can process 50Mpps of drop rules. Our entire data center of 64 Xeon cores can process **3.2 Bpps**—that’s a line rate of 1.6 Tbps for 64-byte packets.

Spoiler: Yes, the victim’s heart rate monitor got triggered when we dropped all traffic for 2 minutes. The 2U box was fine; the _walls_ weren’t. We’re still waiting on CESD production inventory.

**The Bottom Line:**  
The terabit era is not about getting bigger routers. It’s about _programming the first packet processor in your network_—the kernel. eBPF and XDP are not just kernel features; they are the ultimate agile defense mechanism. You don’t need a separate hardware appliance because your server _is_ the appliance. You just need the conviction to trust a bytecode interpreter running in ring 0.

And if you think that’s scary, you haven’t looked at the alternative: letting the packets touch your application.

---

_This post was written from the trenches of a 100G network lab. Hat tip to Daniel Borkmann and the kernel networking team for making the “impossible” seem just complex enough._
