---
title: "Taming the Beast: Optimizing the BEAM Scheduler for Multi-Terabit Message Relays"
shortTitle: "Optimizing BEAM Schedulers for Terabit Message Relays"
date: 2026-08-31
image: "/images/2026/08/31/taming-the-beast-optimizing-the-beam-scheduler-for-multi-ter.svg"
---

In the world of high-concurrency engineering, there is a legendary name that commands respect: **The BEAM**. The Erlang Virtual Machine (VM) has been the backbone of systems that "never die" for decades, powering everything from massive telecommunication switches to the infrastructure of WhatsApp.

But here’s the thing about "infinite scalability"—it’s a lie. Or, more accurately, it’s a moving target.

At WhatsApp, we aren't just dealing with "high traffic." We are dealing with a deluge of data that would melt most conventional stacks. When you are relaying **multi-terabits of encrypted message data per second** across a global cluster of thousands of nodes, the "shared-nothing" philosophy of Erlang meets the cold, hard reality of modern CPU architecture.

Even the BEAM, with its magnificent preemptive scheduler, eventually hits a wall. That wall is called **Lock Contention**.

Today, we’re going to peel back the layers of the `erts` (Erlang Run-Time System). We’ll look at why the default scheduler behavior fails at the "terabit-scale," how we identified the microscopic friction points in the scheduler’s load-balancing logic, and the radical optimizations required to keep latencies in the sub-millisecond range while the world chats.

---

## The Scale: When 2 Billion Users Say "Hello"

Before we dive into the C code of the VM, let’s frame the problem. WhatsApp handles billions of users. At any given millisecond, millions of processes are being spawned, sending messages, and terminating.

In a standard Erlang environment, you might have a few hundred or thousand processes. In our environment, a single bare-metal machine might be managing **millions of concurrent Erlang processes**. These processes are responsible for:

1.  **TLS Termination:** Heavy cryptographic lifting.
2.  **Message Routing:** Parsing headers and looking up destinations in sharded `ets` tables.
3.  **State Management:** Keeping track of user presence and delivery receipts.

The BEAM is uniquely suited for this because it uses **Schedulers** (usually one per logical CPU core). These schedulers act like tiny operating systems, running Erlang processes in "time-slices" called **Reductions**.

The theory is perfect: if one process goes rogue and enters an infinite loop, the scheduler just kicks it off after 4,000 reductions and lets someone else play. But when you scale to 128-core machines with NUMA (Non-Uniform Memory Access) topologies, the overhead of managing those schedulers starts to cost more than the work they are actually doing.

---

## The Anatomy of the Bottleneck: The Global Run Queue vs. Work Stealing

In the early days of SMP (Symmetric Multi-Processing) Erlang, there was a global run queue. Every scheduler grabbed work from one line. As you can imagine, the lock on that one line became the hottest spot in the universe.

Modern BEAM (OTP 20+) uses **per-scheduler run queues**. This was a massive leap forward. Schedulers mostly mind their own business, pulling processes from their own local queue. To keep all cores busy, the BEAM uses **Work Stealing**. If Scheduler #1 is idle, it looks at Scheduler #2’s queue and tries to "steal" some processes.

### The Problem at Multi-Terabit Scale

When you are pushing terabits of data, your processes are extremely short-lived. They wake up, relay a packet, and go back to sleep. This causes the schedulers to oscillate rapidly between "Active" and "Idle" states.

In a high-churn environment, "Work Stealing" becomes a source of **extreme lock contention**. Schedulers are constantly trying to lock each other's queues to see if there is work to steal. On a 128-core box, the cache-line bouncing caused by these locks actually slows down the actual message relaying logic. We found that our CPUs were spending up to **20% of their cycles just fighting over scheduler locks.**

---

## Deep Dive: Hunting the Spinlock

To solve this, we had to go deep into the `erts` source. Specifically, we looked at how the BEAM handles **"Busy Waiting."**

When a scheduler runs out of work, it doesn't immediately go to sleep. Sleeping is expensive—it involves a syscall to the OS kernel, which takes thousands of nanoseconds. Instead, the scheduler "busy waits." It loops for a while, hoping a message arrives for one of its processes or a new process gets spawned.

### The Optimization: `+sbwt` and `+scl`

We experimented with the `+sbwt` (scheduler busy wait threshold) flag. By default, the BEAM tries to be a good citizen. We found that for message relays, we needed to be **aggressive**.

We tuned our VM flags to ensure schedulers stayed awake longer, even if they were doing nothing. Why? Because the cost of waking up a CPU core (and the subsequent L1/L2 cache misses) was higher than the power-saving benefit of letting it sleep.

But the real breakthrough came from **Scheduler Compact Load (`+scl`)**.

By default, the BEAM tries to spread the load across all schedulers to maximize throughput. However, at our scale, spreading the load across two different CPU sockets (NUMA nodes) was killing us. Accessing memory across the QPI/UPI link (the bridge between two physical CPUs) adds significant latency.

We flipped the logic. We configured the BEAM to **compact the load**. We wanted to fill up Scheduler 1, then Scheduler 2, then Scheduler 3, keeping the work localized on as few cores and as few memory controllers as possible.

```bash
# Our specialized VM arguments for high-throughput relay nodes
erl +S 128:128 \      # Use 128 schedulers
    +scl false \      # Disable load balancing, use load compaction
    +sub true \       # Enable scheduler utilization balance
    +sbwt very_long \ # Keep schedulers awake to avoid wake-up latency
    +swt very_low \   # Wake up schedulers quickly when work arrives
    +stbt db \        # Bind schedulers to logical processors (Very important!)
    -env ERL_MAX_ETS_TABLES 100000
```

---

## The "Port" Problem: The Hidden Global Lock

In Erlang, every network socket is a **Port**. Historically, Ports in the BEAM were not as "concurrent" as processes. There was a time when a single lock protected the entire Port table. While that has been improved, there is still significant contention when thousands of processes are all trying to perform I/O simultaneously.

When relaying terabits of data, the kernel’s network stack is pushing packets into the BEAM's `pollset`. If you have 100,000 active TCP connections, the internal `erts_poll` mechanism becomes a bottleneck.

### The Breakthrough: Multi-Poll Sets

One of the most significant optimizations we implemented (and contributed back to the community in various forms) was the move toward **decentralized poll sets**.

By ensuring that specific schedulers handled specific sets of ports, we reduced the need for cross-scheduler communication. We utilized the `+spp` (Parallel Port Scheduling) flag to allow the VM to parallelize the execution of port tasks.

```erlang
%% Optimization: Ensuring Port tasks don't block the scheduler
%% By setting parallel_signal_optimizations, we allow the VM to
%% handle port events without a global lock.
erlang:system_flag(parallel_signal_optimizations, true).
```

This change alone resulted in a **15% increase in throughput** for our TLS-heavy relay traffic.

---

## Sharding the Registry: Beyond `gproc` and `syn`

When a message arrives at WhatsApp, we need to know where to send it. This usually involves a lookup: "Where is User A connected?"

In a small Erlang app, you might use the built-in `register/2` or an ETS table. At our scale, a single ETS table for the entire connection registry is a nightmare. Even with `read_concurrency` enabled, the write-lock for new connections entering or leaving the system creates a massive bottleneck.

### The "Striping" Strategy

We moved to a **Log-Structured, Sharded Registry**. Instead of one table, we shard the registry across 64 or 128 ETS tables (matching our scheduler count).

When a process needs to find a user, it hashes the UserID and hits the specific shard. This effectively eliminates lock contention for lookups.

But there’s a catch: **The "Thundering Herd" of Sockets.**
When a network glitch happens and 1 million clients reconnect simultaneously, they all try to write to the registry at once. By sharding the tables, we distribute that write pressure.

```erlang
%% Example of a simple Sharded ETS lookup
get_socket(UserId) ->
    Shard = erlang:phash2(UserId, ?NUM_SHARDS),
    TabName = list_to_atom("registry_shard_" ++ integer_to_list(Shard)),
    case ets:lookup(TabName, UserId) of
        [{UserId, Socket}] -> {ok, Socket};
        [] -> {error, not_found}
    end.
```

By coupling this sharding with **Scheduler Affinity**—ensuring the process doing the lookup is running on the same NUMA node as the memory for that ETS shard—we reduced L3 cache misses by nearly 30%.

---

## The Dirty Little Secret: Dirty Schedulers

Sometimes, Erlang isn't the right tool for the job. Specifically, doing heavy NIF (Native Implemented Function) calls for things like `Zstd` compression or specialized `XXHash` calculations can block a scheduler. If a NIF takes longer than 1ms, it violates the "Soft Real-Time" promise of the BEAM.

Previously, we had to manually chunk our C code to play nice with reductions. With the introduction of **Dirty Schedulers**, we can offload these blocking CPU-bound tasks to a separate pool of threads.

For our relay logic, we use Dirty Schedulers for:

1.  **Complex Protobuf Parsing:** Some of our legacy schemas are deep and gnarly.
2.  **Image Thumbnailing on the Fly:** When a user sends a photo, we generate a blur-hash.

By moving these to dirty schedulers, the "Regular" schedulers stay free to do what they do best: **Relaying bytes.**

---

## Real-World Impact: The Numbers

So, what does this actually look like in production?

Before these optimizations, our "Relay-Edge" nodes would start seeing "Scheduler Collapse" at around 40Gbps of throughput. The CPU usage would hit 90%, but the actual work done was low—most of that 90% was **spinlocks and kernel context switching.**

After implementing NUMA-aware scheduling, port parallelism, and ETS sharding:

- **Throughput:** Increased from 40Gbps to **120Gbps+ per node.**
- **Tail Latency (p99):** Dropped from 150ms to **12ms** during peak traffic spikes.
- **Power Efficiency:** We reduced the number of physical servers required to handle the same global load by **35%.**

---

## Engineering Curiosities: The "Ghost" in the L3 Cache

One of the weirdest bugs we found during this optimization journey was related to **False Sharing**.

We noticed that two schedulers running on Core 0 and Core 1 were slowing each other down, even though they were working on completely different processes. Using `perf c2c` (Cache-to-Cache), we discovered they were both updating two different counters that happened to sit on the same **64-byte cache line**.

Every time Scheduler 0 updated its counter, it invalidated the cache line for Scheduler 1. The CPU had to keep fetching the data from the L3 cache or Main Memory, even though the data hadn't "really" changed for the other scheduler.

**The Fix?** We added "padding" to our internal C structs in our NIFs to ensure that hot counters always sit on their own cache line. It’s a low-level trick that feels like black magic, but at terabit scale, it’s the difference between a smooth system and a jittery one.

```c
struct scheduler_counters {
    uint64_t messages_relayed;
    char _pad[56]; // Pad to 64 bytes to prevent false sharing
    uint64_t bytes_processed;
    char _pad2[56];
};
```

---

## The Philosophy of Performance

What we’ve learned at WhatsApp is that the BEAM is an incredible starting point, but it isn't a silver bullet. The "Magic" of Erlang is its ability to give you the primitives to build concurrent systems, but once you reach the physical limits of the hardware, you have to stop thinking in terms of "Processes" and start thinking in terms of **Memory Barriers, Cache Lines, and NUMA Topologies.**

Optimizing the BEAM scheduler isn't about making the code "faster." It’s about **removing friction.** It’s about ensuring that when a packet arrives from the fiber optic cable, it finds a clear, unblocked path through the CPU and back out to the wire.

We continue to push the boundaries of what the BEAM can do. Every time someone hits "Send" on a WhatsApp message, they are benefiting from decades of Erlang heritage, refined by the brutal, uncompromising demands of multi-terabit engineering.

### Key Takeaways for Your Own Infrastructure:

- **Bind your Schedulers:** On large multi-core machines, use `+stbt db` to prevent the OS from moving schedulers between cores.
- **Watch your NUMA:** If you have multiple sockets, use `+scl false` to keep work localized and avoid the QPI/UPI bottleneck.
- **Shard your ETS tables:** Don't let a single lock be the bottleneck for your entire application.
- **Measure Lock Contention:** Use `lcnt`, the Erlang lock profiler, to find where your schedulers are fighting.

The BEAM is a beast. If you treat it right, it will carry the weight of the world. Just make sure you aren't making it fight itself.
