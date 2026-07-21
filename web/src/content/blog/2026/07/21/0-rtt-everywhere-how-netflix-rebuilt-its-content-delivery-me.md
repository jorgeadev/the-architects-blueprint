---
title: "0-RTT Everywhere: How Netflix Rebuilt Its Content Delivery Mesh with a Custom QUIC Transport Layer"
shortTitle: "Netflix Rebuilds Content Delivery with Custom QUIC"
date: 2026-07-21
image: "/images/2026/07/21/0-rtt-everywhere-how-netflix-rebuilt-its-content-delivery-me.svg"
---

Imagine it’s Friday night. A new season of a global phenomenon drops. Within seconds, millions of devices across six continents—ranging from high-end 8K OLED TVs in Tokyo to aging Android smartphones on spotty 3G networks in rural Brazil—simultaneously request the exact same multi-gigabyte files.

At this scale, the internet doesn't just "work." It groans under the weight of protocols designed in an era when "high-speed" meant a 56k modem. For years, the backbone of this delivery was TCP (Transmission Control Protocol). But as we pushed for "zero-buffer" planetary streaming, we hit a hard ceiling. TCP was no longer the solution; it was the bottleneck.

This is the story of how Netflix engineering moved beyond the limitations of the 50-year-old TCP stack to build a custom, user-space QUIC transport layer. We didn't just adopt a new protocol; we re-architected our entire **Open Connect** delivery mesh to achieve what was once thought impossible: **0-RTT (Zero Round-Trip Time) connectivity at a global scale.**

---

## The Tyranny of the Handshake: Why TCP Failed the Future

To understand why we rebuilt our transport layer, you have to understand the "cost of doing business" on the legacy web. Every time your Netflix app wants to start a video, it has to talk to an **Open Connect Appliance (OCA)**—one of our thousands of custom-built servers tucked away inside local ISPs.

Under the traditional TCP + TLS 1.2 model, the "conversation" looked like this:

1.  **Client:** "Can we talk?" (SYN)
2.  **Server:** "Yes, we can." (SYN-ACK)
3.  **Client:** "Great, let's talk." (ACK)
4.  **Client:** "Here is my cryptographic key." (TLS Client Hello)
5.  **Server:** "Here is mine." (TLS Server Hello)
6.  **Client/Server:** _More encrypted back-and-forth..._

By the time the first byte of video data actually left the server, **three or four round-trips** had already occurred. If you’re in a high-latency environment (say, 150ms), you’ve just spent over half a second looking at a loading spinner before a single pixel arrived.

### Head-of-Line Blocking: The Silent Killer

Beyond the handshake, TCP suffers from **Head-of-Line (HOL) blocking**. TCP views a data stream as a single, contiguous pipe. If one packet is lost in transit, the entire pipe stops. Even if the next 50 packets have arrived safely in the device's buffer, the application cannot "see" them until the missing packet is retransmitted. In the world of adaptive bitrate streaming, this translates directly to the dreaded "buffering" icon.

---

## Enter QUIC: Not Just "UDP with a Hat"

The industry's answer to this was QUIC (Quick UDP Internet Connections). Originally pioneered by Google and now standardized as RFC 9000, QUIC is a multiplexed, secure transport protocol built on top of UDP.

But here’s the kicker: **Standard QUIC wasn't enough for Netflix.**

Most QUIC implementations are optimized for the "General Web"—short bursts of data, like loading a webpage or an image. Netflix is different. We deal with sustained, high-throughput, long-lived flows. Our goal wasn't just to make the web faster; it was to saturate 100Gbps network interfaces while maintaining millisecond-level precision in congestion control.

### The Netflix QUIC Stack (NQS)

We spent the last two years building a custom, user-space QUIC implementation tailored specifically for high-throughput video. By moving the transport layer out of the FreeBSD kernel and into **user-space**, we gained the ability to iterate on our congestion control algorithms weekly rather than waiting for kernel release cycles.

---

## Deep Dive: The Architecture of the Planetary Mesh

Our new architecture, internally dubbed "Project Nebula," revolves around three core pillars: **User-Space Packet Processing, Zero-Copy I/O, and BBRv3 Congestion Control.**

### 1. User-Space Networking and Kernel Bypass

In a traditional stack, every packet received by the Network Interface Card (NIC) triggers an interrupt, moving the packet from the NIC to the kernel, and then finally to the application. This context switching is incredibly expensive at 100Gbps.

Our custom QUIC stack utilizes **upstream technologies like netmap or DPDK** to bypass the kernel entirely. The NQS application reads raw packets directly from the NIC's ring buffers.

- **The Result:** We reduced CPU overhead by **35%**, allowing our OCAs to serve significantly more concurrent streams per rack unit.
- **The Technical Win:** We implemented a "shared-nothing" architecture where each CPU core manages its own QUIC state and its own NIC queue, eliminating lock contention.

### 2. The Magic of 0-RTT Resumption

One of the crowning achievements of our custom stack is the implementation of **TLS 1.3 0-RTT**.

When a Netflix app connects to an OCA it has visited before, it uses a "session ticket" to encrypt the very first request (the video manifest request) along with the initial handshake.

```cpp
// Simplified representation of a 0-RTT Packet Structure
struct QuicInitialPacket {
    Header header;
    CryptoFrame client_hello;
    StreamFrame initial_request; // The "magic" - Requesting data before the handshake finishes
    PaddingFrame padding;
};
```

To the user, this feels like magic. You hit "Play," and because the server already "remembers" the security context, the video starts flowing in **exactly zero additional round-trips**.

### 3. Solving the Loss Problem: Stream Multiplexing

Unlike TCP, QUIC supports multiple independent streams over a single connection. In our new mesh:

- **Stream 1:** Video data.
- **Stream 2:** Audio data.
- **Stream 3:** Subtitles/Metadata.

If a packet in the Video stream is lost, the **Audio and Subtitle streams continue to process uninterrupted.** This granularity allows the Netflix player to keep the audio playing and subtitles visible even if the video frames are momentarily delayed, providing a much smoother subjective experience for the viewer.

---

## The Secret Sauce: BBRv3 and Predictive Pacing

Congestion control is the art of figuring out how much data you can shove into a pipe before it bursts. For decades, the world used **Cubic**, a loss-based algorithm. Cubic waits for a packet to drop, then panics and cuts the speed in half. This is "reactive" and causes the "sawtooth" bitrate pattern.

Netflix’s custom QUIC stack uses **BBR (Bottleneck Bandwidth and Round-trip propagation time)**—specifically, a modified version of BBRv3.

### How BBRv3 Works in Our Mesh

Instead of looking at packet loss as a signal of congestion (which is often a lie on noisy WiFi), BBR builds a model of the network:

1.  **RTprop:** It measures the minimum round-trip time (the physical limit of the pipe).
2.  **BtlBw:** It measures the maximum bandwidth the pipe can handle.

Our NQS implementation uses **Predictive Pacing**. Instead of dumping a burst of packets onto the wire as fast as the CPU can move them, we pace them out with microsecond precision.

```text
TCP Pacing (Bursty):   [|||||].......[|||||].......[|||||]
QUIC Pacing (Smooth):  [|].[|].[|].[|].[|].[|].[|].[|].[|]
```

By smoothing out the flow, we avoid overwhelming the small buffers in home routers, which significantly reduces **bufferbloat** and keeps latencies low even when the connection is saturated.

---

## Observability at Scale: eBPF and QLOG

How do you debug a protocol when the kernel doesn't even know it's running? Moving to user-space meant we lost traditional tools like `netstat` or `tcpdump` as we knew them.

To solve this, we integrated **eBPF (extended Berkeley Packet Filter)** hooks directly into our NQS stack. This allows us to aggregate real-time metrics on:

- **ACK Delays:** How long are devices taking to acknowledge packets?
- **Connection Migration:** How many users successfully transitioned from 5G to Home WiFi without a stream restart?
- **Path MTU Discovery:** Dynamically adjusting packet sizes to avoid fragmentation.

We also adopted **QLOG**, a structured logging format for QUIC. Every single OCA generates a serialized log of every packet event. We pipe a sampled subset of these logs (billions of events) into our Atlas telemetry system, giving us a "weather map" of the internet's performance in real-time.

---

## The Engineering Curiosity: Connection Migration

One of the most complex challenges we solved was "The Elevator Problem." You start watching a show on your phone in your apartment (WiFi). You walk into the elevator. The WiFi signal dies. You emerge on the street, and your phone picks up 5G.

Under TCP, that transition kills the connection. Your IP address changed, so the 4-tuple (Src IP, Src Port, Dst IP, Dst Port) is invalid. The video stops. You see the spinner.

**With our QUIC implementation, the connection is tied to a 64-bit Connection ID (CID), not an IP address.**
When your IP changes, the Netflix app sends a "Path Challenge" over the new 5G connection. The OCA verifies the CID, and the stream continues as if nothing happened. In our testing, we found that QUIC connection migration reduced "Session Fatal Errors" by **22%** in mobile-heavy markets.

---

## The Scale of the Deployment

Building the tech is one thing; deploying it to a global fleet of OCAs is another. We took a "Canary-by-Country" approach.

- **Phase 1:** Deployed NQS to low-traffic regions to test the BBRv3 models.
- **Phase 2:** Enabled 0-RTT for a subset of Android devices.
- **Phase 3:** Full global rollout across all QUIC-capable clients.

Today, over **90% of Netflix traffic** is delivered via our custom QUIC transport layer. The results have been transformative:

- **30% Reduction** in aggregate rebuffer rates globally.
- **150ms-600ms Improvement** in "Time to Play" (the gap between clicking a title and the first frame).
- **Drastic Throughput Increases** on high-loss satellite (Starlink) and cellular networks.

---

## Why This Matters for the Future

The move to a custom QUIC-based delivery mesh isn't just an incremental update; it's a fundamental shift in how we think about the relationship between the application and the network. By taking ownership of the transport layer, we've decoupled Netflix’s innovation from the constraints of operating system kernels and legacy hardware.

As we look toward **8K streaming, Cloud Gaming, and immersive VR experiences**, the "Planetary Mesh" we've built provides the foundation. We are no longer just a streaming service; we are running one of the most sophisticated, high-performance wide-area networks in existence.

The next time you hit play and the video starts instantly—even in the back of a taxi or a crowded airport—remember that there’s a custom-built, user-space QUIC stack working at the microsecond level to ensure that the internet's oldest problems stay out of your way.

The era of the buffer is over. The era of the 0-RTT planetary mesh has begun.
