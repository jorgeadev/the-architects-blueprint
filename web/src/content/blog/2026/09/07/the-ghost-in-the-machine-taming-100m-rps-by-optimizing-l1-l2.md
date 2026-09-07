---
title: "The Ghost in the Machine: Taming 100M RPS by Optimizing L1/L2 Cache Locality in eBPF Service Meshes"
shortTitle: "eBPF Service Mesh: Optimizing Cache Locality for 100M RPS"
date: 2026-09-07
image: "/images/2026/09/07/the-ghost-in-the-machine-taming-100m-rps-by-optimizing-l1-l2.svg"
---

Imagine standing in a data center where the hum of cooling fans is the only sound, yet beneath the surface, your infrastructure is processing **100 million requests per second (RPS)**. At this astronomical scale, the traditional metrics we obsess over—CPU utilization, memory bandwidth, and disk I/O—become secondary. At the "bleeding edge" of networking, the battle for performance isn't fought in seconds or milliseconds. It is fought in **nanoseconds**, within the tiny, high-speed memory cells of the CPU’s L1 and L2 caches.

As organizations migrate from traditional sidecar-based service meshes (like Envoy-based Istio) to eBPF-powered, sidecar-less architectures (like Cilium or ambient mesh), a new set of bottlenecks has emerged. In a multi-tenant environment where hundreds of microservices share the same kernel space, we’ve encountered a silent killer of tail latency: **Cache Thrashing.**

When your service mesh is handling 100M RPS, a single L2 cache miss doesn't just slow down one request; it creates a micro-stutter that ripples through the entire pipeline, bloating your $P_{99.9}$ and $P_{99.99}$ latencies. This is the story of how we re-engineered our eBPF data plane to achieve micro-architectural harmony, ensuring that our instructions and data stay exactly where they belong: as close to the execution units as possible.

## The Hype and the Hardware Reality

For the past three years, eBPF has been the darling of the cloud-native world. The promise was simple: move observability, security, and networking into the kernel to bypass the "sidecar tax." By running programs in a sandboxed environment within the Linux kernel, we could eliminate the expensive context switches between user-space and kernel-space.

The industry rushed to adopt this. We saw the rise of "sidecar-less" service meshes, and the performance gains were immediate. However, as we pushed our clusters to the 100M RPS threshold, we hit a wall. We realized that while eBPF eliminates **macro-context switches** (User $\leftrightarrow$ Kernel), it introduces a new kind of **micro-context switching**.

In a multi-tenant mesh, the CPU is constantly jumping between different eBPF programs: one for Tenant A's rate limiting, another for Tenant B's mTLS, and a third for Tenant C's observability. Every time the CPU switches "context" between these eBPF programs, it risks evicting the "hot" data of the previous program from the L1 and L2 caches. At 100M RPS, these cache misses aggregate into a "latency storm."

## The Anatomy of the Bottleneck: Why L1/L2 Matters

To understand the fix, we have to look at the physics of the modern CPU.

- **L1 Cache:** ~0.5 - 1 ns latency. This is the "desk" where the CPU works.
- **L2 Cache:** ~3 - 7 ns latency. This is the "bookshelf" next to the desk.
- **L3 Cache:** ~15 - 25 ns latency. This is the "filing cabinet" in the corner.
- **Main Memory (RAM):** ~100+ ns latency. This is the "warehouse" across town.

When an eBPF program executes, it needs two things: **Instructions** (the code) and **Data** (the BPF maps containing state, configurations, or flow tables).

At 100M RPS, if our eBPF program’s state is constantly being booted to L3 or RAM because another tenant’s program just ran, we are essentially moving from the "desk" to the "warehouse" for every packet. In a world where a packet must be processed in under 100ns to maintain throughput, a 100ns RAM fetch is a death sentence for performance.

## Strategy I: Data Locality and the Per-CPU Map Revolution

In a multi-tenant eBPF environment, the most common data structure is the `BPF_MAP_TYPE_HASH`. It’s where we store everything from load-balancing lookups to rate-limit counters. However, standard hash maps are a nightmare for cache locality. They involve pointer chasing across non-contiguous memory, which almost guarantees an L2 miss.

### The Fix: Per-CPU Array Padding and Alignment

To combat this, we shifted our architecture toward `BPF_MAP_TYPE_PERCPU_ARRAY` for high-frequency state. But even then, we ran into **False Sharing**. False sharing occurs when multiple CPUs attempt to modify data that resides on the same **Cache Line** (typically 64 bytes).

If Tenant A's counter and Tenant B's counter are on the same cache line, the CPU's MESI (Modified, Exclusive, Shared, Invalid) protocol will force the caches to synchronize, even though the data is logically independent.

We implemented **Cache Line Alignment** for our BPF map values:

```c
struct tenant_stats {
    __u64 rx_packets;
    __u64 tx_packets;
    __u64 dropped;
    /* Pad to 64 bytes to prevent false sharing */
    __u64 _pad[5];
} __attribute__((aligned(64)));

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, MAX_TENANTS);
    __type(key, __u32);
    __type(value, struct tenant_stats);
} tenant_data_map SEC(".maps");
```

By ensuring every tenant's state starts on a new 64-byte boundary, we eliminated cache coherence traffic between cores. This alone reduced our $P_{99}$ latency by 12% at peak load.

## Strategy II: The Instruction Cache and Tail Call Optimization

One of the coolest features of eBPF is **Tail Calls** (`bpf_tail_call`). It allows one BPF program to call another without returning. This is essential for modularity in a service mesh. You might have a "base" program that tail-calls into a "firewall" program, which then tail-calls into a "router" program.

However, tail calls are essentially a "jump" in the instruction stream. If the target program isn't in the **Instruction Cache (i-cache)**, the CPU stalls.

### From Tail Calls to BPF-to-BPF Functions

Recent kernels (5.10+) have improved **BPF-to-BPF functions**. Unlike tail calls, these behave more like standard C functions. The eBPF Verifier and JIT (Just-In-Time) compiler can often inline these functions or arrange them contiguously in memory.

For our 100M RPS architecture, we moved away from a "chain of tail calls" to a single, monolithic eBPF "Super-Program" compiled using **Static Inlining**. By using the `__always_inline` attribute, we forced the compiler to place the code for all tenants into a single, contiguous block of instructions.

This reduced the "instruction footprint." Instead of jumping across different memory pages to find the code for "Rate Limiting" and "Logging," the CPU finds them all in one sequential stream, keeping the **L1 i-cache** "warm" and happy.

## Strategy III: BPF Task-Local Storage vs. Hash Lookups

When a packet arrives, we often need to associate it with a specific task or process. The traditional way is to take the PID or TGID, hash it, and look it up in a global BPF map.

At our scale, this lookup is a bottleneck. Even with a perfect hash function, you’re still looking up data in a map that likely lives in the L3 cache.

We pivoted to **BPF Task-Local Storage**. Introduced in more recent kernels, this allows us to attach eBPF data directly to the `task_struct` in the kernel.

```c
struct {
    __uint(type, BPF_MAP_TYPE_TASK_STORAGE);
    __uint(map_flags, BPF_F_NO_PREALLOC);
    __type(key, int);
    __type(value, struct tenant_context);
} tenant_ctx_storage SEC(".maps");

SEC("fentry/__sys_sendto")
int BPF_PROG(track_sendto, int fd, void *buff, size_t len, unsigned int flags)
{
    struct task_struct *task = bpf_get_current_task_btf();
    struct tenant_context *ctx = bpf_task_storage_get(&tenant_ctx_storage, task, 0, 0);

    if (ctx) {
        // Direct access to the context, no hash lookup required!
        ctx->last_send_ts = bpf_ktime_get_ns();
    }
    return 0;
}
```

The magic here is that the `task_storage` is often allocated physically near the `task_struct`. When the kernel is handling a syscall for a process, the `task_struct` is already in the L1/L2 cache. By storing our mesh-specific tenant context right next to it, we get the data for "free" (zero extra cache misses).

## The "Noisy Neighbor" in the Cache: Solving Multi-Tenancy Jitter

In a multi-tenant mesh, Tenant A might have 1,000 firewall rules, while Tenant B only has 5. If Tenant A’s massive rule-set is processed on the same CPU core as Tenant B’s, Tenant A will effectively "evict" Tenant B’s configuration from the L1/L2 cache every time it runs.

This is the classic **Noisy Neighbor** problem, but at the micro-architectural level.

### Hardware-Aware Scheduling: CPU Pinning and RSS

To solve this, we implemented a custom **XDP (Express Data Path) Load Balancer** that is "cache-aware." Using **RSS (Receive Side Scaling)** on the NIC, we ensure that packets for specific tenants are always routed to the same set of CPU cores.

By "pinning" Tenant A to Cores 0-7 and Tenant B to Cores 8-15, we created **Cache Isolation**. Tenant A's 1,000 firewall rules can occupy the L2 cache on Core 0 without ever touching the L2 cache on Core 8.

This architectural shift was the single biggest contributor to stabilizing our tail latency. The $P_{99.99}$ variance dropped from 500μs to less than 20μs.

## The Specter of Retpolines: The Hidden Cost of Security

Since the Specter and Meltdown vulnerabilities, the Linux kernel has used **retpolines** (return trampolines) to mitigate indirect branch speculation. Every time an eBPF program uses a helper function or a tail call, it might be hitting a retpoline.

At 100M RPS, the cost of these mitigations is massive. Retpolines essentially flush or bypass parts of the CPU's branch predictor, which is a major component of maintaining high instruction throughput.

We utilized **BPF Trampolines** and **CO-RE (Compile Once – Run Everywhere)** to ensure that our eBPF programs were using direct calls whenever possible. By leveraging **BTF (BPF Type Format)**, the kernel can verify that a function call is safe and "patch" the code at runtime to use a direct jump instead of an indirect one, bypassing the retpoline tax entirely.

## Quantifying the Gains: The Results of Micro-Optimization

After implementing these cache-locality optimizations, we ran a stress test on a cluster of 128-core Ampere Altra (ARM64) nodes, pushing them toward the 100M RPS target.

| Metric                  | Pre-Optimization | Post-Optimization | Improvement |
| :---------------------- | :--------------- | :---------------- | :---------- |
| **Throughput (RPS)**    | 65M              | 105M              | **+61%**    |
| **Avg Latency**         | 140μs            | 85μs              | **-39%**    |
| **$P_{99}$ Latency**    | 850μs            | 120μs             | **-85%**    |
| **$P_{99.99}$ Latency** | 4.2ms            | 210μs             | **-95%**    |
| **L2 Cache Miss Rate**  | 18.5%            | 2.1%              | **Massive** |

The numbers speak for themselves. While the average latency improved significantly, the **tail latency ($P_{99.99}$)** saw a staggering 95% reduction. This is because we eliminated the "outlier" events—those moments where a request had to wait for multiple RAM fetches because its data had been evicted from the cache.

## The Engineering Curiosity: The "Ghost" Miss

During our testing, we found a strange anomaly. On certain Intel Ice Lake processors, we were seeing L1 misses even when our data structures were perfectly aligned. We spent three days debugging this before realizing it was the **L1 Instruction Prefetcher**.

The CPU was trying to be "too smart." It saw a pattern in our eBPF execution and tried to prefetch instructions for Tenant C while we were still processing Tenant B. However, because our eBPF programs were loaded into different memory pages, the prefetcher was crossing a page boundary and triggering a **TLB (Translation Lookaside Buffer) miss**.

The fix was to use **HugePages** for the BPF instruction memory. By mapping the eBPF JIT-compiled code into 2MB HugePages instead of standard 4KB pages, we reduced TLB pressure and finally silenced the "ghost" in the machine.

## Lessons from the Trenches

Optimizing for 100M RPS taught us that at a certain scale, the software and hardware are no longer separate entities. You cannot write high-performance eBPF code without understanding the L1/L2 cache hierarchy of the processor it runs on.

Here are the key takeaways for any team building high-scale eBPF infrastructure:

1.  **Alignment is not optional:** Use `__attribute__((aligned(64)))` for all per-CPU data to prevent false sharing.
2.  **Favor Arrays over Hashes:** If your keys are dense (like tenant IDs), use `BPF_MAP_TYPE_PERCPU_ARRAY`. It’s a contiguous memory block that the CPU prefetcher loves.
3.  **Minimize the Jump:** Use BPF-to-BPF functions and static inlining. Keep your hot path in a single i-cache footprint.
4.  **Isolate the Tenants:** Use RSS and CPU pinning to give each tenant their own "cache sandbox."
5.  **Look at the hardware counters:** Use tools like `perf` and `bpftool` to monitor `L1-dcache-load-misses` and `LLC-load-misses`. If these numbers are high, your code logic doesn't matter—the hardware is waiting on the memory bus.

## The Path Forward

As we look toward the future, the next frontier is **eBPF-offload to SmartNICs**. By moving these cache-optimized eBPF programs out of the host CPU and into the dedicated silicon of a network card, we can push the 100M RPS boundary even further, perhaps even reaching 1B RPS on a single rack.

But even there, the principles remain the same. Whether it's an x86 core, an ARM Neoverse, or a specialized DPU, the bottleneck is always the movement of data. By respecting the hierarchy of memory and the reality of physics, we can build service meshes that aren't just "fast enough," but are truly invisible.

The "sidecar-less" revolution was just the beginning. The real work is in the nanoseconds.
