---
title: "The Billion-Dollar Memory Pressure Valve: How Google Uses CXL Tiering to Throttling Hotspots in Borg"
shortTitle: "Google CXL Tiering: Managing Memory Pressure in Borg"
date: 2026-06-06
image: "/images/2026/06/06/the-billion-dollar-memory-pressure-valve-how-google-uses-cxl.jpg"
---

Imagine you’re managing a fleet of millions of servers. You’ve spent the last two decades perfecting the art of packing containers into those servers with the efficiency of a Tetris grandmaster. This is **Borg**, Google’s legendary cluster manager. But you’ve hit a wall—not a compute wall, but a **Memory Wall**.

In the modern data center, DRAM accounts for nearly **40% of the total cost of ownership (TCO)**. Worse, while CPU cores are multiplying like rabbits, memory bandwidth and capacity per core are actually shrinking. To make matters even more stressful, memory utilization across a cluster is never uniform. You have "hotspots"—nodes where memory bandwidth is choked—while other nodes sit on stranded, idle gigabytes of RAM they can't share.

Enter **CXL (Compute Express Link)**.

For the past few years, CXL has been the darling of hardware conferences, promised as the "holy grail" of data center architecture. But while most of the industry was still debating the specs, Google was already busy figuring out how to bake CXL into the very fabric of Borg.

This is the story of how Google moved beyond simple DRAM and embraced **Heterogeneous Memory Tiering** at a planetary scale to kill hotspots and rescue stranded resources.

---

## The "Stranded Memory" Problem: Why Borg Needed a New Trick

Before we dive into the CXL plumbing, we have to understand the crisis Borg was facing. In a standard NUMA (Non-Uniform Memory Access) architecture, a CPU is tightly coupled to its local DRAM.

If a task running on "Machine A" needs 64GB of RAM but the machine only has 32GB free, Borg can’t just "borrow" RAM from "Machine B" next door, even if Machine B is sitting completely idle. That memory is **stranded**.

Across Google’s entire footprint, the amount of stranded memory is staggering. We’re talking about petabytes of silicon that are powered on, consuming electricity, but doing absolutely zero work.

Furthermore, we have the **Hotspot Dilemma**. Some workloads (like BigTable or Spanner) are memory-bandwidth hungry. They might not use _all_ the capacity, but they saturate the memory bus, causing "interference" that slows down every other neighbor on that machine.

Google’s solution? **Pond**.

Pond is the internal name for Google’s logic that leverages CXL to create a "flexible" memory tier. Instead of every byte of RAM being "Gold" (expensive, fast, local), Google introduced "Silver" memory—CXL-attached DRAM that is slightly higher latency but significantly more flexible and cheaper to scale.

---

## The Plumbing: How CXL Changes the Physical Logic

CXL is an open-standard interconnect built on top of the physical PCIe Gen5/Gen6 layers. But unlike PCIe, which is designed for "talkative" peripherals like GPUs or NICs, CXL provides **cache coherency**.

In the context of Borg, CXL allows Google to plug "Memory Expansion" modules into the PCIe slots. This creates a secondary tier of memory. From the Linux kernel’s perspective, this looks like a **CPU-less NUMA node**.

### The Hierarchy of a CXL-Enabled Borg Node:

1.  **Tier 0 (Local DRAM):** Ultra-low latency (~100ns), high bandwidth. This is where the kernel and high-priority execution stacks live.
2.  **Tier 1 (CXL Memory):** Slightly higher latency (+50ns to 200ns depending on the hop), but still byte-addressable.
3.  **Tier 2 (Far Memory/SSD Swap):** The "cold storage" of memory, managed via zswap or similar compressed mechanisms.

The magic happens when Borg stops treating memory as a monolithic block and starts treating it as a **dynamic, tiered liquid.**

---

## Transparent Page Placement (TPP): The Brains in the Kernel

You can’t just throw CXL memory at a server and hope for the best. If you place a latency-sensitive "User Request" thread into CXL memory, your p99 tail latencies will spike, and your SREs will be paged at 3:00 AM.

To solve this, Google engineered and upstreamed **TPP (Transparent Page Placement)** to the Linux kernel. TPP is the mechanism that automatically manages the "migration" of memory pages between Tier 0 (DRAM) and Tier 1 (CXL).

### How the Migration Logic Works:

Google uses a "Top-Down" approach to memory health. The kernel constantly monitors **Page References**.

- **Demotion:** When the local DRAM (Tier 0) becomes full, the kernel doesn't trigger the OOM (Out of Memory) killer or start swapping to disk. Instead, it identifies "cold" pages—memory that hasn't been touched in a few seconds—and **demotes** them to the CXL Tier.
- **Promotion:** If a CPU suddenly starts hitting a page that was moved to the CXL tier (a "hot" page in a "cold" zone), the TPP mechanism triggers a "Page Fault" and **promotes** that page back to the local DRAM.

This happens at a sub-millisecond scale, completely transparent to the application. Your Go or Java binary has no idea its variables are physically moving between different sticks of RAM.

---

## Throttling Hotspots: The Borg Scheduler’s New Superpower

Borg is a **Predictive Scheduler**. It doesn't just look at what a container is doing _now_; it uses machine learning models to predict what the container will do in ten minutes.

With CXL tiering, Borg's "Admission Control" becomes much more aggressive. In the old days, if a machine had 128GB of RAM, Borg might only allocate 100GB to ensure a "safety buffer" against hotspots. That 28GB was "Tax."

With CXL, Borg uses a strategy called **Overcommitment with a Safety Valve**:

1.  **The "Safety Valve":** Borg can now pack containers until the local DRAM is 95% full.
2.  **Bandwidth Throttling:** If a specific workload starts "hammering" the memory controller (creating a hotspot), Borg instructs the TPP layer to aggressively move that workload's non-essential pages to the CXL tier.
3.  **Isolation:** By moving the "cold" pages of a noisy neighbor to the CXL bus, Borg clears up the local memory bandwidth for the "victim" applications that need the low-latency DRAM.

Essentially, CXL acts as a **buffer for volatility.** It allows Borg to absorb spikes in memory demand without having to migrate entire containers across the network—a process that is slow and expensive.

---

## The Scale of the Challenge: NUMA-Awareness at 100,000 Nodes

At Google's scale, the standard Linux NUMA balancing isn't enough. Google’s engineers found that the default kernel behavior often led to "Ping-Ponging"—where pages are constantly moved back and forth between DRAM and CXL, consuming the very bandwidth they were trying to save.

To fix this, Google implemented **Hardware-Assisted Telemetry**. Modern CPUs (like Intel's Sapphire Rapids or AMD's Genoa) provide "Instruction Based Sampling" (IBS).

Google’s version of Borg reads these hardware counters to identify exactly _which_ lines of code are causing the memory pressure. If Borg sees that a specific "Job ID" is consistently causing page promotions, it will eventually re-schedule that job onto a "Fat Node" with more local DRAM, rather than letting it thrash the CXL tier.

### The "Pond" Cost Efficiency Formula:

Google calculates the success of this architecture using a simple but brutal metric:
$$CostPerGb = \frac{(Price_{DRAM} \times \%_{DRAM}) + (Price_{CXL} \times \%_{CXL})}{TotalUtilization}$$

By shifting 20-30% of a node’s memory capacity to CXL-attached modules (which use cheaper, slightly older DRAM chips or higher-density layouts), Google achieves a **significant reduction in TCO** without a statistically significant hit to application performance.

---

## Software-Defined Memory: The Code Perspective

What does this look like for a Google engineer? Most of the time, it’s invisible. But for high-performance systems like the Search Index or YouTube's transcoding engine, engineers can give "hints" to Borg.

```protobuf
// A hypothetical Borg Task Spec with CXL awareness
task_requirement {
  compute: 16_cores
  memory_tiering: ENABLED

  // High-priority pages stay in local DRAM
  tier_0_reservation: 4GB

  // Can expand into CXL for cache and buffers
  tier_1_limit: 32GB

  // If the CXL tier is saturated, start throttling
  hotspot_policy: AGGRESSIVE_DEMOTE
}
```

By allowing applications to explicitly define their "Hot Working Set," Borg can ensure that the most critical data never leaves the fastest silicon, while the "cruft" (logs, initialization buffers, etc.) lives in the CXL tier.

---

## Dealing with the "Tail": The Latency Impact

In the world of planetary-scale services, the average latency is a lie. Everything is about the **p99.99**.

The biggest risk of CXL tiering is the "Tail Latency Spike." If a user request arrives and the required data has been demoted to CXL, that extra 100ns of latency can ripple through the microservice stack, turning into a 100ms delay at the edge.

Google mitigates this through **Proactive Promotion**.

Instead of waiting for a "Page Fault" (which is reactive), Borg’s telemetry tracks patterns. If a specific RPC (Remote Procedure Call) is known to access a certain memory block, Borg can trigger a "warm-up" signal to the kernel to move those pages back to Tier 0 _before_ the request even hits the application.

This is "Software-Defined Hardware" in its purest form.

---

## Beyond Expansion: The Future of CXL 3.0 Fabrics

What Google is doing now is mostly "CXL 1.1/2.0"—point-to-point memory expansion. But the roadmap for Borg is even more ambitious: **Memory Pooling via CXL 3.0 Fabrics.**

In a CXL 3.0 world, memory is no longer inside the server. It’s in a separate chassis—a "Memory Appliance."

Imagine a rack where 10 servers are all connected to a central pool of 2 Terabytes of RAM via a CXL switch. Borg can then dynamically assign memory to Server A, then "unplug" it and give it to Server B in microseconds, without any data moving across the Ethernet network.

This turns memory into a **true utility**, like electricity. You don't buy a server with 128GB of RAM; you buy a server with "Compute" and lease "Memory" from the rack-level pool as needed.

---

## The Lessons for the Rest of Us

Google’s journey with CXL and Borg reveals a fundamental shift in how we think about computers. We are moving away from the "Fixed Box" model of server design and toward a "Disaggregated" model.

The takeaways for the broader engineering community are clear:

1.  **Memory is the new bottleneck:** As we move toward LLMs and massive data processing, managing the "Memory Wall" is more important than raw CPU cycles.
2.  **Tiering is inevitable:** The era of "all-DRAM-all-the-time" is ending. We must prepare our software stacks to be "Latency-Aware."
3.  **The Kernel is the key:** Success in this space requires a deep marriage between the orchestrator (Borg/Kubernetes) and the kernel (Linux TPP).

Google has proven that you can save billions in capital expenditure by introducing a little bit of "Silver" memory into a "Gold" world. By using CXL to throttle hotspots and rescue stranded resources, they haven't just made Borg more efficient—they’ve redefined the architecture of the modern data center.

As CXL-capable hardware becomes more accessible to the enterprise via new Intel and AMD chips, the strategies pioneered inside Google's data centers will soon become the standard for any organization running at scale. The "Memory Wall" isn't going away, but thanks to CXL and intelligent scheduling, we’ve finally found a way to climb over it.
