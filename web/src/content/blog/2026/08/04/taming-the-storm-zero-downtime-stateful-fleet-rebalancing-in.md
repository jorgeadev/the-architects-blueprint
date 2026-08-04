---
title: "Taming the Storm: Zero-Downtime Stateful Fleet Rebalancing in Netflix’s Open Connect"
shortTitle: "Zero-Downtime Stateful Fleet Rebalancing in Netflix Open Connect"
date: 2026-08-04
image: "/images/2026/08/04/taming-the-storm-zero-downtime-stateful-fleet-rebalancing-in.svg"
---

It’s Friday night, 8:00 PM. A new season of a global phenomenon—think _Stranger Things_ or _Squid Game_—has just dropped. Across the globe, millions of devices wake up simultaneously. Within seconds, Netflix’s traffic spikes from a steady hum to a roaring torrent of bits. In the background, thousands of Open Connect Appliances (OCAs)—our custom-built content delivery servers—are pumping out terabits of data per second.

But what happens when one of those servers needs a critical kernel patch? Or when a localized network congestion event requires us to shift 100Gbps of traffic from one rack to another without a single frame dropping for the viewer?

In the world of massive-scale content delivery, this is the **Thundering Herd** problem, compounded by the challenge of **Stateful Rebalancing**. If we simply "shut off" a server, we trigger a stampede of reconnection requests to the remaining fleet, potentially toppling the very infrastructure meant to provide redundancy.

Today, we’re going behind the scenes of Open Connect to explore how we solved zero-downtime stateful fleet rebalancing. We’ll dive into the kernel-level sorcery, the BGP steering mechanics, and the orchestration logic that keeps your movie playing while we swap the engine out of the plane mid-flight.

---

## The Architecture of Open Connect: A Primer

To understand rebalancing, you first have to understand the **Open Connect Appliance (OCA)**. Unlike many CDNs that rely on generic cloud VMs, Netflix builds its own hardware and optimizes the entire software stack—from the BIOS to the application layer.

Our OCAs run a highly tuned version of **FreeBSD**. Why? Because FreeBSD’s network stack and `sendfile(2)` implementation allow us to push over 400Gbps of encrypted TLS traffic from a single 1U server.

### The Control Plane vs. The Data Plane

- **The Data Plane:** This is the OCA itself, sitting deep inside an ISP's network (IXPs). It stores the bits and serves the bytes.
- **The Control Plane:** A set of microservices running in AWS (the "Netflix Cloud") that tracks which content is on which OCA and directs your Netflix app to the "best" server based on proximity, health, and load.

The challenge is that a video stream isn't a "stateless" request like a small JSON blob. It’s a **long-lived stateful session**. A single 4K stream can last two hours and maintain a persistent TCP connection. If we break that connection abruptly, the client-side player might stall, buffer, or fail-over to a distant server, increasing latency and costs.

---

## The Thundering Herd: Why Naive Rebalancing Fails

Imagine a cluster of 10 OCAs, each handling 80Gbps. One server reports a hardware pre-failure (S.M.A.R.T. errors on an NVMe drive).

If we simply pull that server out of the rotation:

1. **The Instant Drop:** 80Gbps of traffic suddenly vanishes.
2. **The Reconnection Spike:** Thousands of clients simultaneously realize their TCP socket is dead.
3. **The Herd:** All those clients hit the Netflix Control Plane at the exact same millisecond asking for a new URL.
4. **The Saturation:** The remaining 9 servers suddenly see a massive spike in SYN packets, SSL handshakes, and disk I/O requests.

This is the **Thundering Herd**. It doesn't just affect the servers; it stresses the ISP’s routers and our global steering services. To avoid this, we needed a way to move traffic that is **gradual, stateful, and transparent.**

---

## The Secret Sauce: Progressive Draining and "Soft" BGP Handoffs

Rebalancing in Open Connect isn't a binary "On/Off" switch. It’s a multi-stage orchestration we call **The Graceful Decline.**

### 1. BGP Path Prepend and Metric Manipulation

Most of our OCAs communicate with ISP routers via **BGP (Border Gateway Protocol)**. To start rebalancing, we don't just stop advertising routes. Instead, we use **AS Path Prepending**.

By making the path to a specific OCA appear "longer" or "less desirable" to the router, we signal the network to prefer other OCAs for _new_ connections. Crucially, the router will still deliver packets for _existing_ connections to the original OCA because of flow-affinity in the router’s hardware (ECMP - Equal-Cost Multi-Path).

### 2. The Steering Service "Weight" Shift

Simultaneously, the OCA communicates its status to the Netflix Control Plane in AWS. We implement a **Draining State**.
The control plane’s steering algorithm uses a "Server Weight" metric. When an OCA enters maintenance mode, its weight doesn't go to zero immediately. It drops to a value that says: _"Do not give this server new sessions unless absolutely necessary, but allow it to continue serving current ones."_

---

## Deep Dive: The Kernel-Level Handoff

What if we need to update the actual NGINX binary or the TLS library on the OCA? This is where the engineering gets really interesting. We can’t wait 2 hours for every single user to finish their movie.

We utilize a technique involving **Unix Domain Sockets** and **File Descriptor Passing**.

### The Anatomy of the Handoff

When we deploy a new version of our delivery process, we don't want to drop the thousands of active TCP sockets. Here’s how we do it:

1.  **Spawn the Successor:** The new version of the delivery service starts up alongside the old one.
2.  **Shared Listening:** Using `SO_REUSEPORT`, both processes can theoretically listen on the same port, but this doesn't help with existing connections.
3.  **Passing the Torch:** The "Old" process uses `sendmsg()` to pass the file descriptors (FDs) of active TCP connections to the "New" process over a Unix domain socket.
4.  **State Migration:** Along with the FD, we pass a serialized blob of the "Session State"—how many bytes were sent, the current TLS keys, and the congestion window (CWND) parameters.
5.  **The Cutover:** The New process takes over the socket, and the Old process exits. To the client (your TV), the TCP connection never broke. The sequence numbers remain perfectly synced.

```c
/* Simplified conceptual snippet of FD passing for stateful rebalancing */
struct msghdr msg;
struct cmsghdr *cmsg;
int fds[1]; // The TCP socket to pass
// ... setup msg and iov ...

cmsg = CMSG_FIRSTHDR(&msg);
cmsg->cmsg_level = SOL_SOCKET;
cmsg->cmsg_type = SCM_RIGHTS;
cmsg->cmsg_len = CMSG_LEN(sizeof(int));
memcpy(CMSG_DATA(cmsg), fds, sizeof(int));

if (sendmsg(unix_socket, &msg, 0) < 0) {
    perror("Failed to pass stateful FD");
}
```

---

## Managing the Cache: The "Cold Start" Problem

Rebalancing isn't just about TCP connections; it’s about **data**. If we move a user from OCA-A to OCA-B, but OCA-B doesn't have the specific chunk of _The Crown_ that the user was watching, the rebalance fails. We get a "Cache Miss."

A cache miss on an OCA is expensive. It means the OCA has to fetch that content from a "Tier 1" library server or the AWS backbone, introducing latency.

### The Predictive Fill

Before we take an OCA offline for scheduled maintenance, our "Fill Service" looks at the traffic patterns. If we know we’re going to shift 5,000 users to a neighboring rack, we **pre-stage** the most popular content on those neighbor OCAs.

We use a **heat map algorithm** that calculates:

- **P(Content | User_Segment):** The probability that a user in a specific ISP region will request a specific title.
- **Delta-Sync:** We only sync the bits that the destination servers are missing.

By the time the BGP weights shift, the destination fleet is already "warm," ensuring that the transition is invisible to the end user.

---

## Handling the "Flash Crowd" with Adaptive Rate Limiting

Even with BGP prepending and weight shifts, the internet is unpredictable. A sudden BGP flap in a major ISP can send a "Flash Crowd" to an OCA that isn't ready for it.

To solve this, we implemented **BBR (Bottleneck Bandwidth and Round-trip propagation time)** at the transport layer, but we added a Netflix-specific twist: **Application-Aware Congestion Control.**

If an OCA detects that its CPU or memory bandwidth is hitting a "Thundering Herd" threshold, it starts communicating with the client-side player using custom HTTP headers (e.g., `X-Netflix-Load-Shed: true`). The Netflix app on your device is smart. When it sees this, it voluntarily backs off and tries a secondary URL, effectively performing **Client-Side Rebalancing**.

---

## Infrastructure at Scale: The Numbers

To give you an idea of the scale we’re managing:

- **Thousands of OCAs** globally.
- **Tbps of throughput** rebalanced daily.
- **Zero-Copy Architecture:** We use `sendfile` and kTLS (Kernel TLS) so that data moves from the NVMe drive to the Network Interface Card (NIC) without ever being touched by the CPU.

When we rebalance, we are moving the equivalent of several Library of Congresses every second. The engineering precision required to do this without "glitching" the video is the result of years of iteration on the FreeBSD kernel and our own routing logic.

---

## The Role of eBPF in Modern Observability

You can't rebalance what you can't see. In our recent iterations, we've moved heavily toward **eBPF (Extended Berkeley Packet Filter)** for real-time observability during rebalancing events.

eBPF allows us to run sandboxed programs in the kernel without changing the kernel source code. During a fleet rebalance, we use eBPF to:

- Monitor **TCP Retransmission rates** in real-time. If retransmissions spike on a specific BGP path during a shift, our automation automatically rolls back the change.
- Track **TTFB (Time to First Byte)** per session.
- Observe **Interrupt Latency** on the NICs to ensure the rebalancing isn't starving the CPU.

This granular visibility allows us to turn what used to be a "fingers crossed" maintenance window into a fully automated, self-healing process.

---

## Beyond the Herd: The Future of Stateful Edge Computing

The lessons we learned from solving the Thundering Herd on Open Connect are now influencing how we think about "Stateful Edge Computing."

As we move toward more interactive content and features that require even lower latency, the "State" we need to manage isn't just a video file; it's the entire memory state of a specialized application. The principles remain the same:

1. **Decouple the session from the process** (FD passing).
2. **Signal the network early** (BGP/Steering).
3. **Warm the destination** (Predictive Caching).
4. **Trust, but Verify** (eBPF Observability).

The next time you’re watching a movie and it stays in crisp 4K despite your local ISP having a minor meltdown, remember: there’s a complex, highly orchestrated dance happening at the edge of the network. We’re moving terabytes, shifting routes, and swapping kernels—all so you can keep your eyes on the screen, and not on the loading spinner.

---

**Engineering Curiosity:** _Want to dive deeper into our FreeBSD optimizations? Check out our previous posts on kTLS and why we choose to upstream our changes back to the FreeBSD community. At Netflix scale, the kernel is our playground._
