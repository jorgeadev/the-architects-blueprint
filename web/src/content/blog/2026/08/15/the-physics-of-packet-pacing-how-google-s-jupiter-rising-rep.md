---
title: "The Physics of Packet Pacing: How Google’s Jupiter Rising Replaced Load Balancers with Nanosecond Control"
shortTitle: "Google Jupiter Rising: Replacing Load Balancers with Nanosecond Control"
date: 2026-08-15
image: "/images/2026/08/15/the-physics-of-packet-pacing-how-google-s-jupiter-rising-rep.svg"
---

Imagine you are trying to coordinate a symphony where every musician is located in a different city, and the conductor is traveling at the speed of light. Now, imagine that if a single violinist plays a note three microseconds late, the entire orchestra grinds to a halt, and you lose five million dollars in compute time.

This isn't a metaphor. This is the reality of networking at the **ExaFLOPS scale**.

As we transition from the era of "General Purpose Cloud" to the era of "AI Supercomputing," the fundamental laws of networking are being rewritten. The industry has hit a wall where traditional distributed load balancers—the workhorses of the Web 2.0 era—are no longer fast enough. They are too "chatty," too high-latency, and too disconnected from the underlying physics of the wire.

Google’s recent revelations regarding its **Jupiter Rising** architecture represent a seismic shift in how we think about moving data. They’ve moved away from software-defined load balancing and toward **in-network congestion control** and **hardware-level packet pacing**.

Today, we’re going deep into the stack. We’re going to analyze how Google bypassed the speed-of-light limitations of traditional CPUs to build a fabric capable of supporting the world's largest AI clusters.

---

## The Death of the Software Load Balancer

For the last decade, the industry standard for handling massive traffic was **Maglev** (Google’s distributed software load balancer). It was brilliant: a fleet of commodity servers running optimized C++ that used consistent hashing to distribute packets. It was flexible, scalable, and perfect for YouTube or Gmail.

But then came **Large Language Models (LLMs)** and **TPU v4/v5 pods**.

In a traditional web environment, traffic is "north-south" (client to server). It consists of millions of tiny, independent flows. If one packet is delayed, one user waits an extra 50ms. No big deal.

In an AI training cluster, traffic is "east-west" (server to server). It consists of massive, synchronized bursts known as **All-Reduce** operations. Thousands of TPUs or GPUs calculate gradients, then simultaneously broadcast them to every other node. This creates the **Incast Problem**: a synchronized tidal wave of packets hitting a single switch port at the exact same nanosecond.

### Why Software Fails at 800G

When you are running 800Gbps links, the "time per packet" is infinitesimally small. A 1500-byte MTU packet at 800Gbps passes by in about **15 nanoseconds**.

A modern CPU takes roughly **100 nanoseconds** just to access main memory (LLC miss). By the time a software-based load balancer even "sees" a packet header, dozens of other packets have already backed up in the buffer. The CPU is simply too slow to "pace" the traffic.

This leads to:

1.  **Micro-bursts:** Short-lived spikes that overflow switch buffers.
2.  **Tail Latency ($P_{99}$):** The slowest packet dictates the speed of the entire AI training step.
3.  **Bufferbloat:** Switches trying to hold onto too much data, increasing jitter.

To solve this, Google had to move the "brain" of the network out of the software and into the **physics of the silicon.**

---

## Enter Jupiter Rising: The Physical Layer Evolution

Jupiter is Google’s data center interconnect (DCI). "Jupiter Rising" isn't just an upgrade; it’s a philosophical shift toward **Optical Circuit Switching (OCS)** and **Direct-to-Device Pacing**.

### 1. The Apollo OCS and Palomar

The first major breakthrough in Jupiter Rising is the removal of the "middleman" switch where possible. Google developed **Apollo**, an Optical Circuit Switch. Unlike traditional packet switches that convert photons to electrons, read a header, and convert back to photons, Apollo uses MEMS (Micro-Electro-Mechanical Systems) mirrors to physically steer light.

- **The Physics:** By eliminating the electrical conversion, you eliminate the queueing delay entirely. The latency is literally just the time it takes light to travel through the fiber.
- **The Benefit:** At the ExaFLOPS scale, you can reconfigure the entire topology of your data center to match the communication pattern of your AI model (e.g., a 3D Torus for TPU pods).

### 2. The Shift to In-Network Telemetry (INT)

If you aren't using a centralized load balancer to tell packets where to go, how do you avoid congestion? You make the network **self-aware**.

Google utilizes **P4-programmable pipelines** and custom silicon to embed telemetry directly into the packet headers as they fly through the switch. This is known as **In-band Network Telemetry**.

```p4
/* Simplified P4 Concept for In-Network Telemetry */
control TransitPipeline(inout headers hdr, inout metadata meta) {
    apply {
        if (hdr.ipv4.isValid()) {
            // Append current switch ID and egress queue depth to the packet
            hdr.telemetry.push_front({
                switch_id: MY_ID,
                queue_depth: standard_metadata.deq_qdepth,
                timestamp: standard_metadata.enq_timestamp
            });
        }
    }
}
```

By the time a packet reaches its destination, it carries a "diary" of exactly how congested every switch was along its path. The receiver then sends this metadata back to the sender in an ACK, allowing the sender to adjust its "pace" with microsecond precision.

---

## The Anatomy of Packet Pacing: Swift and Falcon

The core of Google's strategy is a protocol called **Swift**. Swift is the successor to traditional TCP/IP congestion control (like BBR or CUBIC) but designed specifically for the data center.

### The Problem with "Loss-Based" Congestion

Old-school TCP waits for a packet to be **dropped** before it slows down. In an ExaFLOPS cluster, a dropped packet is a catastrophe. It triggers a retransmission timeout, which stalls the entire AI compute synchronization.

### Swift: Delay-Based Pacing

Swift doesn't wait for loss. It measures **One-Way Delay (OWD)**.

Google’s NICs (Network Interface Cards), specifically the **gVNIC** and the custom **Falcon** transport, use hardware-level timestamps to measure the time difference between when a packet was sent and when it was received, with **nanosecond accuracy**.

If the delay increases by even 2 microseconds, Swift knows that a buffer somewhere in the Jupiter fabric is starting to fill up. It immediately slows down the "pacing" of the next packet.

#### The "Leaky Bucket" in Silicon

Instead of sending a "burst" of 100 packets and then waiting, the NIC hardware implements a **Hardware Pacer**. It calculates the exact inter-packet gap required to maintain a steady flow.

If the allowed rate is 100Gbps, the hardware ensures a gap of exactly **12 nanoseconds** between every packet. This turns a "spiky" traffic pattern into a "smooth" fluid flow, preventing the "Incast" tidal wave from ever forming at the switch.

---

## The Architecture: From Centralized to Edge-Enforced

In the old model, a Load Balancer (LB) sat in the middle:
`Sender -> Switch -> LB -> Switch -> Receiver`

In the **Jupiter Rising** model, the "Load Balancer" doesn't exist as a discrete entity. It is a distributed function of the **Edge (NIC)** and the **Fabric (OCS/Switch)**.

### 1. Flowlet Switching

Jupiter uses a technique called **Flowlet Switching**. Instead of pinning a "flow" (a TCP connection) to a single path, it breaks the flow into "flowlets"—bursts of packets separated by enough time that they can be reordered without issue.
The fabric dynamically routes these flowlets across different optical paths based on the real-time congestion data provided by the telemetry we discussed earlier.

### 2. Direct-to-Host Load Balancing

Google uses a system called **Orion**, which is the control plane for Jupiter. Orion talks to the host NICs directly. If a specific spine switch in the Jupiter fabric is overheating or congested, Orion updates the routing tables on the **hosts** (the sender), not just the switches.

This is a massive architectural shift: **The intelligence has moved to the edge.**

---

## The ExaFLOPS Scale: Why This Matters for AI

Why go to all this trouble? Can't we just buy bigger switches?

No. We are reaching the physical limits of **SerDes** (Serializer/Deserializer) speeds. As we move to 1.6Tbps and 3.2Tbps networking, the power required to move electrons across a copper backplane becomes prohibitive.

### The Synchronization Tax

AI training is a "Bulk Synchronous Parallel" (BSP) process.

- **Step 1:** Compute gradients.
- **Step 2:** Sync gradients with all 16,384 other GPUs.
- **Step 3:** Update weights.

If your network has "jitter" (variable latency), Step 2 takes as long as the slowest packet. In a traditional network, the difference between the fastest and slowest packet ($P_{99}$ vs $P_{50}$) can be 10x.

By using **Packet Pacing** and **In-Network Congestion Control**, Google has reduced that jitter to almost zero. They’ve turned the network into a deterministic "bus," much like the traces on a motherboard, but at the scale of a data center.

### Real-World Impact

In Google’s published data on Jupiter Rising, they noted that shifting to this hardware-enforced pacing and OCS-based topology allowed them to:

1.  **Reduce Power Consumption by 40%:** Optical switching doesn't need the massive fans and cooling that electrical switching requires.
2.  **Improve Throughput by 30%:** By eliminating micro-bursts, they can run their links at 95% utilization without dropping packets.
3.  **Scale to 13,000+ TPU Clusters:** Traditional CLOS networks struggle with cable complexity at this scale; Jupiter’s optical fabric makes it plug-and-play.

---

## Engineering Curiosities: The "Falcon" Transport

We can't talk about Jupiter without mentioning **Falcon**, Google's custom reliable transport protocol that replaces TCP for high-performance workloads.

Falcon is built into the NIC hardware. It handles:

- **Selective Acknowledgments (SACK):** Much more aggressive than TCP's version.
- **Connectionless semantics:** It doesn't have the "Three-way handshake" overhead of TCP.
- **Hardware Retransmit:** If a packet is lost, the NIC hardware re-sends it without ever interrupting the host CPU.

This is where the "Physics" meets the "Code." By implementing Falcon in the hardware, the "Time to Retransmit" drops from **milliseconds (Kernel-space)** to **microseconds (Hardware-space)**.

```python
# Conceptual view of Falcon's Pacing Logic (simplified)
class FalconNIC:
    def __init__(self, target_bandwidth_gbps):
        self.inter_packet_gap_ns = (1500 * 8) / target_bandwidth_gbps
        self.last_sent_time = nanoseconds_now()

    def send_packet(self, packet):
        now = nanoseconds_now()
        target_time = self.last_sent_time + self.inter_packet_gap_ns

        if now < target_time:
            # Busy-wait or hardware-timer sleep to ensure physical spacing
            spin_wait_until(target_time)

        self.physically_transmit(packet)
        self.last_sent_time = nanoseconds_now()
```

---

## The Hype vs. The Reality

There is a lot of hype around "AI Networking" right now—InfiniBand vs. Ethernet is the big debate.

- **The Hype:** "Ethernet is dead for AI because of collisions and overhead."
- **The Reality:** Google proved that Ethernet (or "Ethernet-plus") is very much alive. By stripping away the legacy parts of the protocol (the software load balancers, the slow TCP stack) and keeping the physical framing, they built something that rivals InfiniBand in performance while maintaining the scale of the Internet.

The "secret sauce" isn't a faster cable; it's the **mathematical precision of the pacing**. It’s the realization that at the ExaFLOPS scale, the network is no longer a collection of cables—it is a single, massive, distributed computer backplane.

---

## The Road to 10 ExaFLOPS

As we look toward the next generation of infrastructure, the lessons from Jupiter Rising are clear:

1.  **Software is the bottleneck:** We must move congestion logic into the silicon.
2.  **Light is better than Electricity:** Optical Circuit Switching is the only way to scale the "core" of the data center without melting the power grid.
3.  **Telemetry is the lifeblood:** You cannot manage what you cannot measure in nanoseconds.

Google’s shift from distributed load balancers to in-network control marks the end of the "Software-Defined Networking" era as we knew it and the beginning of the "Physics-Defined Networking" era.

For the rest of us, this means the tools we use—RDMA, RoCE v2, and even standard Linux networking—are about to undergo a massive hardware-accelerated transformation. The orchestra is getting faster, and the conductor is finally learning to move at the speed of light.
