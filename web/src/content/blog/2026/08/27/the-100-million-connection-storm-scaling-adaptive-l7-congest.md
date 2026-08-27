---
title: "The 100 Million Connection Storm: Scaling Adaptive L7 Congestion Control in the Era of Real-Time Infrastructure"
shortTitle: "Scaling Adaptive L7 Congestion Control for 100 Million Connections"
date: 2026-08-27
image: "/images/2026/08/27/the-100-million-connection-storm-scaling-adaptive-l7-congest.svg"
---

Imagine this: It’s 3:00 AM. A minor routing flap in a Tier-1 network provider triggers a momentary disconnect for a subset of your users. In a traditional REST-based world, this is a blip. But you aren't running a traditional app. You are managing a global real-time fabric—a gaming powerhouse, a fintech giant, or a massive IoT telemetry hub—supporting **100 million concurrent WebSocket connections.**

Within seconds, that "minor blip" transforms into a catastrophic event. As those 100 million devices realize their stateful connection is severed, they don't just sit there. They retry. All of them. Simultaneously.

This is the **Thundering Herd**. It is the ultimate boss fight for infrastructure engineers. When 100 million TLS handshakes hit your edge at the same millisecond, your CPU usage doesn't just spike; it liquefies. Your load balancers, once the pride of your fleet, begin to drop like flies.

At this scale, traditional "static" rate limiting is a blunt instrument that often does more harm than good. To survive, we had to move beyond simple thresholding and implement **Adaptive L7 Congestion Control** directly within the Service Mesh. This is the story of how we engineered a system to breathe with the network, surviving the storm by turning our infrastructure into a living, reacting organism.

---

## The Physics of the 100M Connection Problem

To understand the solution, we first have to respect the sheer physics of the problem. Handling 100 million concurrent WebSockets isn't just "Web 2.0 but bigger." It is a fundamental shift in how we think about resource allocation.

### The Memory Wall

In a stateless environment, memory is ephemeral. In a stateful WebSocket world, **memory is your primary constraint.** Each connection requires a file descriptor, a TCP buffer, and a slice of application-layer state. Even with a highly optimized stack, if each connection consumes just 10KB of overhead (between the kernel and the proxy), 100 million connections require **1 Terabyte of RAM** just to exist.

### The Handshake Apocalypse

The "Thundering Herd" isn't just about data; it’s about the **Cost of Entry.** A TLS 1.3 handshake requires asymmetric cryptography. Doing 100 million of those in a compressed window creates a CPU demand that exceeds the capacity of almost any cloud-native auto-scaling group. If your system takes 10ms of CPU time per handshake, 100 million handshakes require **1 million CPU-seconds.** If you want to recover in 10 seconds, you need 100,000 cores ready to roar.

### The Ghost of L4 Past

Traditionally, we solved congestion at Layer 4 (TCP). We used TCP Backlog queues and SYN cookies. But L4 is blind. It doesn't know if the incoming connection is a high-priority "Active User" or a "Background Telemetry Probe." It doesn't know if your downstream microservice is actually healthy or if it’s just returning 503s at lightning speed. To solve this, we had to move the intelligence to **Layer 7 (Application Layer)**.

---

## Why the Service Mesh? (The Envoy Advantage)

When we started this journey, the hype around Service Meshes like Istio and Linkerd was at an all-time high. Critics argued that adding a sidecar proxy (Envoy) adds latency. But at 100M connections, the sidecar isn't a tax—it’s an **insurance policy.**

By using **Envoy Proxy** as our data plane, we gained a programmable interceptor at every hop. The Service Mesh allows us to decouple the "Business Logic" from the "Network Resilience Logic." Our developers focus on the WebSocket payload; our infrastructure team focuses on the **Adaptive Concurrency Limits.**

### The Architecture: Global Edge to Local Sidecar

Our architecture follows a tiered approach:

1.  **Global Anycast Edge:** Initial TLS termination and massive DDoS mitigation.
2.  **Regional L7 Load Balancers:** Envoy instances running on "Bare Metal" cloud instances to minimize virtualization overhead.
3.  **The Mesh Data Plane:** Sidecar proxies running alongside the WebSocket servers, managing local backpressure.

---

## Implementing Adaptive Congestion Control

The core of our solution is the **Gradient Controller Algorithm**, implemented as a custom Envoy filter. Unlike static rate limits (e.g., "10,000 requests per second"), adaptive limits use a feedback loop to determine the optimal number of concurrent requests.

### The Math of the Gradient

We borrowed concepts from TCP Vegas and Netflix’s `concurrency-limits` library. The formula for our limit adjustment looks like this:

$$NewLimit = CurrentLimit \times \left( \frac{RTT_{ideal}}{RTT_{actual}} \right) + QueueSize$$

- **$RTT_{ideal}$:** The round-trip time of a request when the system is under no load.
- **$RTT_{actual}$:** The current rolling average P99 latency.
- **$QueueSize$:** A small constant to allow for "burstiness" without triggering a throttle.

If the actual latency rises (meaning the downstream service is struggling), the gradient becomes less than 1, and the limit shrinks. If the service is healthy, the limit expands.

### Envoy Configuration: The Circuit Breaker 2.0

We didn't just use the built-in Envoy circuit breakers; we extended them using **WASM (WebAssembly) filters.** This allowed us to inject complex logic into the proxy path without recompiling the entire Envoy binary.

```yaml
# A snippet of our Adaptive Limiter Logic in Envoy (Conceptual)
http_filters:
    - name: envoy.filters.http.wasm
      typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.http.wasm.v3.Wasm
          config:
              name: "adaptive_limiter"
              root_id: "concurrency_control"
              vm_config:
                  runtime: "envoy.wasm.runtime.v8"
                  code:
                      local:
                          filename: "/etc/envoy/filters/limit_gradient.wasm"
              configuration:
                  # The "Ideal" latency threshold for this specific microservice
                  target_latency_ms: 50
                  # The maximum we ever want to scale to per instance
                  max_concurrency: 50000
                  # The aggressiveness of the backoff
                  backoff_factor: 0.85
```

---

## Deep Dive: Tuning the Linux Kernel for 100M+ Connections

You cannot reach 100 million connections on a default Linux distro. You’ll hit the "C10k problem" on steroids before you even get to the application layer. Our engineering team had to perform deep-tissue surgery on the kernel.

### 1. File Descriptor Limits

The default limit of 1024 is laughable at this scale. We pushed `fs.file-max` into the tens of millions.

```bash
sysctl -w fs.file-max=20000000
# Also tuning the per-process limit in /etc/security/limits.conf
* soft nofile 1000000
* hard nofile 1000000
```

### 2. The Ephemeral Port Problem

With millions of connections, you quickly exhaust the ephemeral port range (usually 32k-61k). We solved this by:

- Using multiple virtual IP addresses (VIPs) per load balancer.
- Enabling `net.ipv4.tcp_tw_reuse` to allow the kernel to recycle sockets in the `TIME_WAIT` state.

### 3. Memory Management: The `tcp_mem` Tunable

The kernel allocates memory for TCP buffers. At scale, this can trigger the Out-of-Memory (OOM) killer even if your application isn't using much RAM.

```bash
# tcp_mem is measured in pages. This tells the kernel:
# [low, pressure, high] thresholds for total TCP memory usage
sysctl -w net.ipv4.tcp_mem='1000000 2000000 3000000'
```

### 4. Interrupt Coalescing and RSS

At 100M connections, the "Interrupt Storm" is real. We utilized **RSS (Receive Side Scaling)** to distribute network interrupt processing across all CPU cores. Without this, Core 0 would hit 100% utilization (handling interrupts) while the other 63 cores sat idle.

---

## The "Adaptive" Secret Sauce: Priority-Aware Shedding

When the "Thundering Herd" arrives, and the adaptive limit starts shrinking, who gets kicked out?

If you drop connections randomly, you might kill a user’s high-value transaction while keeping a background heart-beat alive. We implemented **L7 Priority Levels** within our WebSocket handshake.

- **Priority 0 (Critical):** Active user interactions, payment processing.
- **Priority 1 (Standard):** Real-time updates, chat messages.
- **Priority 2 (Background):** Analytics, telemetry, "seen" receipts.

When our Adaptive Congestion Controller detects a breach of the latency threshold, it doesn't just start a "Random Early Detection" (RED) drop. It initiates **Priority-Aware Shedding.**

1.  It first rejects all new Priority 2 connection requests.
2.  If latency stays high, it begins severing existing Priority 2 connections with a `CloseFrame` (Code 1001 - Going Away).
3.  Only in extreme "Lifeboat" scenarios does it ever touch Priority 0.

This ensures that while the "herd" is thundering, the most valuable "cattle" are protected.

---

## Solving the "Stateful Reconnect" Loop

One of the unique challenges with WebSockets is the **State Transfer.** When a client reconnects, they often ask: _"What did I miss while I was gone?"_

If 100 million clients ask that question at once, your database will explode. We implemented a **Jittered Backoff with Delta-Compression.**

### Exponential Jitter

Instead of a standard `reconnect_interval * 2`, we use a randomized jitter:

```javascript
function getReconnectDelay(retries) {
    const base = 1000; // 1 second
    const max = 60000; // 1 minute
    const delay = Math.min(max, base * Math.pow(2, retries));
    return delay + Math.random() * delay * 0.5; // Add 50% randomness
}
```

This flattens the spike of reconnections into a manageable "plateau."

### Delta-Updates

The Service Mesh sidecar caches the last 30 seconds of "High-Priority" messages. When a client reconnects within that window, the **Envoy Sidecar fulfills the "What did I miss?" request directly from its local cache**, never letting the request hit the backend database. This saved us an estimated 80% in DB IOPS during recovery events.

---

## Testing the Untestable: Simulating 100 Million Users

How do you know it works? You can't just run `ab` or `wrk` on your laptop.

We built a distributed load-testing engine called **"The Kraken."** It consists of thousands of small "Agent" nodes distributed across 10 global cloud regions. Each agent uses an asynchronous, non-blocking I/O loop (built on Rust and `tokio`) to maintain 50,000+ WebSocket connections.

### The Chaos Experiment

We purposely took down a regional cluster to trigger a "Herd" of 10 million connections moving to a neighboring region. We watched the metrics in real-time:

- **T+5s:** Neighboring region CPUs spike to 80%.
- **T+7s:** Adaptive Congestion Control kicks in. P99 latency hits the 100ms ceiling and stays there.
- **T+10s:** Envoy begins "Priority 2" shedding. The "Background" traffic is rejected.
- **T+60s:** The system stabilizes. Latency drops. The limits automatically expand as the "Priority 2" users are slowly let back in.

**Total Downtime for Priority 0 Users: 0 seconds.**

---

## Reflections on the Real-Time Frontier

The hype around "Real-Time" often focuses on the "Cool" factor—live cursors, instant notifications, and seamless gaming. But the technical substance of real-time infrastructure is actually about **management of failure.**

At 100 million concurrent connections, the network is no longer a reliable pipe; it’s a volatile environment. Implementing Adaptive L7 Congestion Control shifted our mindset from "Build it big enough so it doesn't break" to **"Build it smart enough so it knows how to break gracefully."**

The Service Mesh, once seen by many as a complex layer of abstraction, proved to be the essential tool for this intelligence. By moving the congestion logic into Envoy and tuning the underlying Linux kernel to its breaking point, we moved past the "Thundering Herd" and into a future where 100 million connections isn't a crisis—it’s just another Tuesday.

### The Key Takeaways for Your Stack:

- **Don't trust static limits.** Your hardware's capacity changes based on the complexity of the requests. Go adaptive.
- **Understand the Kernel.** Cloud-native doesn't mean "Kernel-agnostic." If you’re doing stateful scale, `sysctl` is your best friend.
- **Priority is everything.** Treat your traffic like an ER triage unit. Not all packets are created equal.
- **Jitter everything.** Synchronicity is the enemy of scale.

The road to 1 billion connections is now open. The only question is: Is your mesh ready for the storm?
