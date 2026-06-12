---
title: "The 100Gbps Gambit: How Netflix Rebuilt its Edge on QUIC"
shortTitle: "Netflix Rebuilds 100Gbps Edge with QUIC"
date: 2026-06-12
image: "/images/2026/06/12/the-100gbps-gambit-how-netflix-rebuilt-its-edge-on-quic.jpg"
---

The next time you settle in to watch _Stranger Things_ in 4K HDR, take a moment to consider the absolute chaos happening behind your screen. To deliver that pristine, 15-20 Mbps stream without a single stutter, a specialized Netflix Open Connect Appliance (OCA) somewhere in a data center near you is engaged in a high-stakes battle against one of the most hostile environments known to engineering: **the public internet.**

For over a decade, we relied on the battle-hardened combination of TCP and TLS. It was the gold standard. But as we pushed toward 4K as the default and expanded into regions with volatile mobile infrastructure, we hit a wall. TCP’s inherent design—its head-of-line blocking, its rigid congestion control, and its "chatty" handshakes—became a bottleneck for our most demanding subscribers.

To solve this, we didn't just tweak a few knobs. We re-engineered the entire transport layer of the Netflix CDN (Open Connect) to run on a purpose-built, kernel-optimized implementation of **QUIC**.

This is the story of how we migrated one of the world's largest CDNs to QUIC, the technical hurdles of doing so at 100Gbps+ speeds, and how we finally conquered adversarial packet loss to ensure "play" means _play_.

---

## The "TCP Wall": Why 4K Demanded a Paradigm Shift

To understand why we moved to QUIC, you have to understand the limits of TCP. TCP was designed in an era where wires were reliable and bandwidth was the primary constraint. Today, the constraint is often **latency and jitter.**

### The Head-of-Line Blocking Nightmare

In TCP, packets are a single, ordered stream. If Packet #2 is lost in transit, Packet #3, #4, and #5 must wait in the receiver’s buffer until #2 is retransmitted and arrives. This is **Head-of-Line (HOL) blocking**. For a 4K stream, where the video buffer needs to be constantly replenished to avoid a rebuffer, a single dropped packet in a congested "last mile" node could stall the entire pipeline, even if the subsequent packets were already sitting on the user’s device.

### The Handshake Tax

A typical TLS-over-TCP connection requires a multi-step dance:

1.  **TCP 3-way handshake** (1 RTT)
2.  **TLS 1.3 negotiation** (1 RTT)

That’s 2 Round Trip Times (RTTs) before a single byte of video data is sent. On a high-latency mobile network (say, 150ms RTT), the user is staring at a loading spinner for 300ms just for the metadata exchange.

### Ossification

TCP is baked into the kernels of every device and router on earth. Changing how TCP behaves (e.g., implementing a new congestion control algorithm) is nearly impossible because intermediate boxes (middleboxes) like firewalls often drop packets that don't look like "standard" TCP.

**QUIC (Quick UDP Internet Connections)** solves this by moving the transport logic into user-space (mostly) and encrypting almost everything—including the packet headers. To the network, it’s just UDP. To us, it’s a programmable, stream-aware transport layer.

---

## Architecture: Building a 100Gbps QUIC Stack in FreeBSD

Our Open Connect Appliances (OCAs) aren't just generic servers; they are highly tuned beasts running **FreeBSD**. They are designed to push 100Gbps to 400Gbps of encrypted video traffic from a single RU (Rack Unit).

Most QUIC implementations (like Google’s `quicly` or Cloudflare’s `quiche`) are user-space libraries. While user-space is great for flexibility, it is devastating for performance at Netflix-scale.

### The Context-Switching Problem

When you’re pushing 100Gbps, the overhead of moving data between the kernel (where the NIC lives) and user-space (where the QUIC library lives) is prohibitive. Every context switch burns CPU cycles. If we ran a standard user-space QUIC stack, our power efficiency would plummet, and we’d need three times as many servers to serve the same amount of traffic.

### The Solution: Kernel-Assisted QUIC (kTLS + Reference Implementation)

We took a hybrid approach. We leveraged **kTLS (Kernel TLS)**, a technology Netflix co-developed with the FreeBSD community.

- **TCP path:** `sendfile()` sends data directly from the disk cache to the NIC, with the kernel handling AES-GCM encryption in-line.
- **QUIC path:** We had to extend this. In QUIC, every packet has a unique header that must be encrypted. We modified the FreeBSD kernel to support **QUIC-specific header protection** and **packet pacing** directly in the network stack.

By keeping the "heavy lifting" (data movement and encryption) in the kernel while keeping the "control logic" (congestion state machine) in a highly optimized library, we achieved parity with TCP’s efficiency.

---

## Tackling Adversarial Packet Loss with BBRv2

The "adversarial" part of our migration involves the "last mile"—the connection between the ISP’s central office and your home router. In many regions, this involves "Bufferbloat," where routers have massive buffers that soak up packets, creating huge spikes in latency before they finally drop data.

Traditional TCP algorithms like **CUBIC** react to packet loss by slashing the transmission rate by 50%. On a 4K stream, this is a disaster. The bit rate drops, the quality degrades to 480p, and the user experience is ruined.

### Enter BBR (Bottleneck Bandwidth and Round-trip propagation time)

We implemented **BBRv2** within our QUIC stack. Unlike CUBIC, BBR doesn't look at packet loss as a primary signal of congestion. Instead, it builds a model of the network:

1.  **Max Bandwidth:** How fast can the pipe actually go?
2.  **Min RTT:** How long does it take for a packet to round-trip when the pipe is empty?

```python
# Conceptual BBR logic in our QUIC implementation
def on_ack_received(packet):
    current_rate = delivery_rate_estimator.sample()
    max_bandwidth = max(max_bandwidth_window, current_rate)
    min_rtt = min(min_rtt_window, packet.rtt)

    # Calculate the BDP (Bandwidth-Delay Product)
    target_inflight = max_bandwidth * min_rtt

    # Adjust pacing rate to stay just at the edge of the BDP
    set_pacing_rate(max_bandwidth * gain_factor)
    set_cwnd(target_inflight * 2)
```

By using BBR over QUIC, we can distinguish between **random packet loss** (interference on a Wi-Fi signal) and **congestive packet loss** (the link is actually full). This allows us to maintain high-throughput 4K streaming even when the network is dropping 2-3% of packets—a scenario where TCP would have crawled to a halt.

---

## The Engineering Curiosity: The "Big Copy" and Zero-Copy QUIC

One of the most fascinating technical hurdles was the `sendfile()` problem. In TCP, the kernel knows exactly what the packet looks like. In QUIC, the application (Netflix's streaming server process) needs to wrap every chunk of video in a QUIC frame.

Initially, this required a **"Big Copy"**:

1.  Read video data from disk into a user-space buffer.
2.  Wrap it in QUIC/UDP headers.
3.  Copy it back to the kernel to be sent to the NIC.

At 100Gbps, the memory bandwidth required for this "copy-around" is astronomical. It would saturate the PCIe bus and the CPU's memory controllers.

We solved this using **Advanced Buffer Management**. We modified our OCA software to use a "Headers-only" write. We tell the kernel: "Take the headers from this memory address, but take the 1400 bytes of video data directly from the disk-read buffer." This effectively gives us **Zero-Copy QUIC**. The CPU never actually "touches" the video data; it only manages the metadata.

---

## Solving the "Last Mile" Loss: QUIC's Secret Weapon

In 4K streaming, the biggest enemy is **Tail Latency**. A few packets taking 500ms to arrive can trigger a buffer underrun. QUIC gives us two specific tools we didn't have with TCP:

### 1. Connection Migration

Imagine you start a movie on your phone via Wi-Fi, then walk out the front door. Your phone switches to LTE. In the TCP world, the IP address changes, the socket breaks, and the Netflix app has to initiate a whole new connection. With QUIC, we use a **Connection ID**. As long as that ID remains the same, the session continues seamlessly across IP changes. No rebuffering.

### 2. Proactive Retransmission

Because QUIC is aware of different streams (e.g., the video stream vs. the audio stream vs. the metadata stream), we can prioritize them. If we detect high loss, our QUIC stack can choose to proactively retransmit the "Tail" of the video buffer—sending the same packet twice—to ensure it gets through the congestion, sacrificing a bit of bandwidth to guarantee latency.

---

## Infrastructure Scale: The Rollout

Migrating a global CDN to a new protocol isn't a "flip the switch" moment. It’s a multi-year phased rollout.

1.  **The Shadow Phase:** We initially ran QUIC in "shadow mode," where the client would establish a QUIC connection but only use it for non-critical telemetry. This allowed us to measure the CPU impact on our OCAs without affecting the user experience.
2.  **The A/B Test:** We ran massive A/B tests across different device categories (Smart TVs, iPhones, Android, Roku). We looked at:
    - **VMAF (Video Multi-Method Assessment Fusion):** Did the average picture quality go up?
    - **Rebuffer Rate:** Did we see a decrease in those annoying "Loading..." circles?
    - **Start Play Delay:** How fast did the first frame appear?

### The Results

The data was staggering. In "lossy" networks (especially in emerging markets), **QUIC reduced rebuffer rates by up to 20%.** Even in stable fiber networks, the **Time to First Frame** dropped by 100-300ms thanks to 0-RTT handshakes.

---

## Technical Deep Dive: The QUIC Packet Header Challenge

One of the most complex parts of the migration was the **Packet Number Encryption**. In TCP, packet sequence numbers are in the clear. This allows routers to help with reordering, but it also allows for "TCP Reset" attacks and middlebox interference.

QUIC encrypts the packet number. To do this at 100Gbps, we had to implement a specialized AES-ECB (Electronic Codebook) encryption path in the kernel.

```c
/* Simplified Kernel-level QUIC Header Protection */
void quic_protect_header(struct bio *video_payload, uint8_t *sample) {
    // Generate the mask using the header protection key
    uint8_t mask[16];
    AES_ECB_encrypt(sample, &hp_key, mask);

    // Apply the mask to the first byte and the packet number
    header->flags ^= (mask[0] & 0x0f); // For Short Headers
    for (int i = 0; i < pn_length; i++) {
        header->packet_number[i] ^= mask[i+1];
    }
}
```

Doing this for every single packet—roughly 8 million packets per second on a 100G link—requires the kernel to be incredibly lean. We utilized **SIMD (Single Instruction, Multiple Data)** instructions (AVX-512) on our Intel/AMD CPUs to parallelize this encryption, ensuring that the transport layer didn't become a CPU bottleneck.

---

## The "Adversarial" Test Case: 4K in a Crowded Apartment

To truly test our new stack, we looked at "Friday Night Peak." This is when an ISP’s node in a dense apartment complex is saturated. Everyone is streaming, gaming, and Zoom-calling at once.

In this environment, "ACK-clocking" (where a sender only sends new data when an old packet is acknowledged) often breaks down because ACKs are delayed or lost. Our QUIC implementation uses **Pacing**. Instead of sending a burst of 100 packets whenever an ACK arrives, we spread those packets out evenly over the RTT.

**Why this matters for 4K:**
A 4K burst can be huge. If you dump 1MB of data into a home router's tiny buffer all at once, you will cause a drop. By pacing the packets at the exact bit rate of the 4K stream (plus a small buffer-filling margin), we "thread the needle" through the congested network.

---

## Performance Summary: TCP vs. QUIC

| Metric                    | TCP + TLS 1.3               | QUIC (BBRv2)             |
| :------------------------ | :-------------------------- | :----------------------- |
| **Handshake Latency**     | 2 RTT                       | 0-1 RTT                  |
| **HOL Blocking**          | Present (Global)            | None (Per-stream)        |
| **Congestion Control**    | CUBIC (Loss-based)          | BBRv2 (Model-based)      |
| **Efficiency at Edge**    | High (sendfile)             | High (Custom kTLS-QUIC)  |
| **Resilience to 5% Loss** | Poor (Throughput collapses) | Excellent (Maintains 4K) |

---

## Lessons from the Trenches

Building and deploying a purpose-built QUIC stack at Netflix's scale taught us that the "standards" are just a starting point. To achieve true 4K performance under adversarial conditions, we had to:

1.  **Respect the Hardware:** You cannot ignore the cost of context switches and memory copies. If it doesn't run in the kernel (or a very clever DPDK-like setup), it won't scale to 100G.
2.  **Model the Network, Don't Just React:** Packet loss is a symptom, not always the disease. BBRv2's ability to model the pipe is a game-changer for high-bitrate video.
3.  **Observability is Everything:** When you encrypt the headers, your traditional network diagnostic tools (like `tcpdump` or ISP-level analytics) become blind. We had to build extensive **QLOG** (QUIC logging) infrastructure to understand why a specific stream in Sao Paulo was underperforming.

The migration to QUIC isn't just a technical upgrade; it's a fundamental shift in how we view the relationship between the server and the player. We've moved from "sending packets" to "managing a conversation." And as we look toward 8K and beyond, that conversation is only going to get more interesting.

The next time you're deep into a binge-watch and the quality doesn't even flicker despite your roommate starting a massive download, you'll know: that's the power of QUIC, kernel-level engineering, and a very smart congestion model working in perfect harmony.
