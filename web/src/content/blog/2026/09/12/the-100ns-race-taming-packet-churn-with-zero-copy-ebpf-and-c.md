---
title: "The 100ns Race: Taming Packet Churn with Zero-Copy eBPF and Custom Ring Buffers"
shortTitle: "100ns Networking: Zero-Copy eBPF and Custom Ring Buffers"
date: 2026-09-12
image: "/images/2026/09/12/the-100ns-race-taming-packet-churn-with-zero-copy-ebpf-and-c.svg"
---

It’s 3:00 AM, and the edge ingress nodes are screaming.

On the Grafana dashboard, the PPS (Packets Per Second) counter for the main load-balancer cluster has just ticked past 8 million. Normally, this wouldn't be an issue; we built our stack on eBPF and XDP (Express Data Path) specifically to handle this kind of heat. But tonight is different. The latency p99s are spiking, and the CPU usage across the packet-processing cores is jagged. We aren't hitting a bandwidth limit—the 100G NICs have plenty of headroom—but we are hitting a much more insidious wall.

We are suffering from **Packet Churn**.

In the world of high-frequency networking, Packet Churn is the silent killer. It’s the overhead incurred not by the data itself, but by the relentless cycle of allocating, tracking, and freeing the metadata associated with millions of tiny packets every second. When you’re operating at 10M PPS, you have exactly **100 nanoseconds** to process each packet before the next one arrives on that specific RX queue. If your memory allocator takes 40ns and your hash lookup takes 50ns, you’ve already lost.

This is the story of how we re-architected our load balancers to push past the 10M PPS barrier by moving away from standard BPF maps and embracing a custom ring-buffer allocator combined with zero-copy RSS (Receive Side Scaling) hashing.

## The Hype vs. The Hard Reality of eBPF

If you’ve followed the tech news over the last three years, you’ve heard that eBPF is the "superpower" that turned the Linux kernel into a programmable microkernel. The hype is real: being able to run sandboxed code in the kernel at the hook points of the network driver (XDP) is a generational leap over traditional `iptables` or even `userspace` DPDK (Data Plane Development Kit) in terms of maintainability.

However, the "Standard eBPF Path" often promoted in tutorials—using a `BPF_MAP_TYPE_HASH` to store session state and `bpf_perf_event_output` to ship data to userspace—falls apart at massive scale.

At 10M PPS, the standard eBPF hash map becomes a bottleneck due to **lock contention** (if using shared maps) or **CPU cache misses** (as the map grows larger than the L3 cache). We realized that to stay under our 100ns-per-packet budget, we had to stop treating the kernel like a managed environment and start treating it like a raw, bare-metal hardware registers.

## The Bottleneck: Why Standard Allocators Fail at 10M PPS

When a packet hits the NIC, the driver allocates a `xdp_buff`. Our job as load balancer engineers is to parse that packet, decide which backend server it belongs to, update some statistics, and either forward it or drop it.

The "churn" happens because for every packet, we need to store "flow state." Standard Linux memory management is too slow. Even eBPF’s internal helpers have overhead. When you are processing millions of flows, the translation from a packet's 5-tuple (Source IP, Dest IP, Source Port, Dest Port, Protocol) to a memory address in a hash map involves:

1.  **Hashing the 5-tuple** (Expensive CPU cycles).
2.  **Walking the bucket list** in the hash map (Potential cache misses).
3.  **Atomic increments** for counters (Instruction pipeline stalls).

We observed that at peak load, **60% of our CPU time** was spent simply managing the memory associated with these flows, not actually routing packets. We needed a way to allocate memory for flow state that was as fast as a pointer increment.

---

## Architecture Shift 1: The Custom Ring-Buffer Allocator

To solve the allocation churn, we moved away from dynamic hash maps and implemented a **pre-allocated, per-CPU slab-style ring buffer** directly in the kernel bypass path.

### The Design Philosophy

Instead of asking the kernel for memory when a new packet arrives, we "carve out" a massive contiguous block of memory at boot time. This memory is divided into fixed-size slots, each capable of holding our internal `flow_metadata` struct.

We implemented a **Ring-Buffer Allocator** using two simple pointers: `head` and `tail`.

- **The Head:** Points to the next free slot.
- **The Tail:** Points to the oldest active slot.

When a packet arrives, the eBPF program doesn't perform a complex map lookup. Instead, it performs a bitwise operation on the packet's hardware-generated hash (more on that later) to find a slot index. If the slot is empty or expired, it claims it.

### The Technical Implementation (Simplified eBPF C)

```c
struct flow_slot {
    __u64 last_seen;
    __u32 backend_id;
    struct flow_stats stats;
};

// A per-CPU array acting as our raw memory slab
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __type(key, __u32);
    __type(value, struct flow_slot);
    __uint(max_entries, 1 << 20); // 1 Million slots per core
} flow_slab SEC(".maps");

SEC("xdp")
int lb_ingress(struct xdp_md *ctx) {
    __u32 slot_idx = get_zero_copy_hash(ctx) & ( (1 << 20) - 1 );

    struct flow_slot *slot = bpf_map_lookup_elem(&flow_slab, &slot_idx);
    if (!slot) return XDP_ABORTED;

    // Check for collisions or expiration without heavy locks
    if (slot->last_seen < current_time - FLOW_TIMEOUT) {
        // Re-initialize slot for new flow
        initialize_slot(slot, ctx);
    }

    update_metrics(slot);
    return route_packet(slot);
}
```

By using a power-of-two size (1 << 20), we replace the expensive `%` (modulo) operator with a simple `&` (bitwise AND) to find the index. At 10M PPS, the difference between a division and a bitwise AND is measurable in milliseconds of total latency.

---

## Architecture Shift 2: Zero-Copy RSS Hashing

This is where we get into the "Kernel Bypass" territory. Usually, when a packet arrives, the NIC calculates a hash (RSS Hash) to decide which CPU core should handle the packet.

In a standard stack, the eBPF program then _re-calculates_ a hash of the 5-tuple to look up the flow in a map. **This is redundant.** The hardware has already done the work!

### Leveraging `xdp_md` and Hardware Metadata

Modern NICs (like the Mellanox ConnectX-6 or Intel E810) can be configured to pass the hardware-calculated hash directly to the XDP program. This is known as "Metadata Hinting."

By using **Zero-Copy RSS Hashing**, we extract the hash directly from the DMA (Direct Memory Access) descriptor that the NIC wrote into host memory. We then use this hardware hash as our index into the Ring-Buffer Allocator.

**The result?** We skip the most CPU-intensive part of packet processing (the hash calculation) entirely. The CPU never even has to touch the packet's payload headers to know where to store the state. It just looks at the metadata provided by the NIC.

### Why this matters for "Packet Churn"

By avoiding the hash calculation and the map lookup, we reduce the "instructions per packet" (IPP) count significantly. In our benchmarks:

- **Standard eBPF Hash Map Path:** ~210 instructions per packet.
- **Zero-Copy Ring-Buffer Path:** ~85 instructions per packet.

This reduction allows a single CPU core to handle nearly **3x the traffic** before it hits the 100ns threshold.

---

## The "False Sharing" Trap and How We Dodged It

When building a high-PPS system, you have to be obsessed with the **L1 Cache**.

One of the biggest issues we faced during the re-architecture was "False Sharing." This happens when two different CPU cores try to update data that happens to reside on the same **Cache Line** (usually 64 bytes). Even if they are updating different variables, the CPU's cache coherency protocol (MESI) will force the cores to sync, effectively locking the bus.

We solved this by ensuring our `flow_slot` structure is **Cache-Line Aligned**.

```c
struct flow_slot {
    __u64 last_seen;
    __u32 backend_id;
    struct flow_stats stats;
} __attribute__((aligned(64))); // Force alignment to 64-byte boundaries
```

By aligning the struct, we guarantee that no two slots overlap on a cache line. This turned our "jagged" latency graphs into a flat, beautiful line, even as PPS increased.

---

## Managing the State: The Garbage Collection Problem

In a traditional hash map, you might use a userspace agent to periodically crawl the map and delete old entries. At 10M PPS, a userspace crawler is too slow and creates too much contention.

Our custom Ring-Buffer Allocator uses a **Lazy Reclamation** strategy. Instead of an active "cleaner" process, the eBPF program itself handles expiration.

When the hash points to a slot, we check the `last_seen` timestamp. If the timestamp is older than our threshold (e.g., 30 seconds), we simply overwrite the data. This "Circular" approach means we never have to "delete" anything. The memory is just a continuous loop of state that refreshes itself.

This leads to a highly deterministic system:

1.  **Fixed Memory Footprint:** We know exactly how much RAM the load balancer will use (Number of Slots \* 64 bytes).
2.  **No Allocation Latency:** We never call `malloc` or `bpf_map_update_elem`.
3.  **No GC Pauses:** There is no garbage collector to stall the pipeline.

---

## The Results: 10M PPS and Beyond

After deploying the Zero-Copy RSS and Ring-Buffer architecture, the results were staggering.

- **CPU Utilization:** Dropped from 85% at 8M PPS to 30% at 10M PPS.
- **P99 Latency:** Dropped from 120 microseconds to 15 microseconds (measured from NIC ingress to egress).
- **Throughput Max:** In synthetic testing, we successfully pushed a single node to **24M PPS** before seeing any packet loss—a limit imposed by the PCIe bus bandwidth, not the CPU.

### The "Wait, what about collisions?" Question

Savvy engineers will ask: "If you're using a fixed-size ring buffer and a hardware hash, what happens if two different flows hash to the same slot?"

In a traditional database, this is a disaster. In a **stateless/soft-state load balancer**, this is a calculated trade-off. By sizing our ring buffer large enough (e.g., 1 million slots per core), the probability of a "collision" of two _active_ flows is statistically negligible (less than 0.001% in our traffic profile). For those rare cases, the connection simply resets—a small price to pay for the ability to handle a massive DDoS attack or a viral traffic spike without the entire infrastructure falling over.

---

## Engineering Lessons from the Trenches

What did we learn from re-architecting at this scale?

### 1. The Kernel is a Suggestion, the Hardware is the Law

eBPF gives you the tools to ignore the kernel's default networking stack. If you want to go fast, stop thinking about "Sockets" and "Interfaces" and start thinking about "DMA Descriptors" and "PCIe Lanes." The closer you get to the metal, the faster you go.

### 2. Micro-optimizations are Macro-impactful

At 10M PPS, saving 10 nanoseconds per packet is the equivalent of saving **100 milliseconds every second** of CPU time. When you multiply that across a cluster of 100 nodes, you are saving literal megawatts of power and thousands of dollars in cloud spend.

### 3. Observability is Harder at Scale

Standard tools like `tcpdump` or `bpf_trace_printk` will crash your system at 10M PPS. We had to build custom "sampling" eBPF programs that only looked at 1 out of every 10,000 packets to debug our logic without causing a self-inflicted DDoS.

## The Road Ahead: Merging XDP and io_uring?

As we look to the future, we are exploring the integration of our eBPF ring buffers with **io_uring** for even faster userspace signaling. The goal is a completely unified "Zero-Copy" path from the wire to the application and back, where the CPU never has to copy a single byte of data.

The Packet Churn problem isn't "solved"—as link speeds move from 100G to 400G and 800G, the budget per packet will shrink from 100ns to 25ns. We are already planning our next move. But for now, our ingress nodes are calm, our p99s are flat, and we can finally get some sleep.

Until the next 3:00 AM alert, that is.

---

**Are you dealing with massive PPS scale or eBPF performance bottlenecks?** Let's dive into the details in the comments. Whether you're fighting cache misses or wrestling with the BPF verifier, the "100ns race" is one we're all running together.
