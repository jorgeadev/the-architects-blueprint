---
title: "The Edge Stampede: How We Solved the Multi-Tenant Thundering Herd with Adaptive Backpressure"
shortTitle: "Solving Multi-Tenant Thundering Herds with Adaptive Backpressure"
date: 2026-09-06
image: "/images/2026/09/06/the-edge-stampede-how-we-solved-the-multi-tenant-thundering-.svg"
---

Imagine it’s 3:00 AM. You’re on call. Suddenly, your monitoring dashboard turns into a sea of crimson. Request latency on your edge compute nodes is spiking from 15ms to 15,000ms. Your origin servers are screaming under a load 100x their capacity.

The culprit? A "Thundering Herd."

But this isn't just any thundering herd. This is a **multi-tenant edge stampede**. In a world of serverless functions, WebAssembly (Wasm) runtimes, and global distribution, the traditional ways we handle traffic spikes are failing. When thousands of distributed edge nodes simultaneously realize they have a cache miss and rush the origin at the exact same millisecond, you don't just have a performance hit—you have a systemic collapse.

At our scale, we handle millions of requests per second across thousands of independent customer workloads. Solving this required more than just "adding more servers." It required a fundamental rethink of how we handle congestion and data locality.

In this deep dive, we’re going under the hood of our latest architectural evolution: a dual-pronged system utilizing **Adaptive Backpressure** and **Predictive Caching** to tame the herd and ensure 99.99% availability, even during the most volatile traffic spikes.

---

## The Anatomy of the Multi-Tenant Stampede

In a single-tenant environment, a thundering herd is predictable. You know your app; you know your traffic patterns. In a **multi-tenant edge platform**, the variables explode.

You have thousands of distinct customers. One might be a boutique e-commerce site, another a global news agency, and another a high-frequency trading bot. They all share the same underlying compute fabric. When a viral event hits—a "Breaking News" alert or a sneaker drop—the edge nodes (the "herd") all reach for the same resources simultaneously.

### The Problem: Cascading Cache Misses

The edge is essentially a massive, distributed cache for compute and data. The "herd" problem typically triggers during a **cold start** or a **cache expiration**.

1.  **The Trigger:** A popular asset (like a Wasm binary or a large JSON blob) expires from the edge cache globally.
2.  **The Rush:** 5,000 edge nodes receive requests for that asset at the same time.
3.  **The Collapse:** All 5,000 nodes see a cache miss. Instead of one node fetching the data and sharing it, all 5,000 nodes initiate a "fetch" to the origin.
4.  **The Death Spiral:** The origin server, overwhelmed by 5,000 concurrent heavy requests, slows down. This increases the time the edge nodes spend waiting, which consumes more local resources (memory, file descriptors), eventually leading to the edge node itself becoming unresponsive.

This is the "Stampede." And if you’re sharing infrastructure, a stampede for Tenant A can trample the resources allocated for Tenant B.

---

## Part 1: Request Collapsing and the "Single Flight" Pattern

Before we get into the "Adaptive" and "Predictive" parts, we have to look at the first line of defense: **Request Collapsing**.

The most basic way to stop a herd is to ensure that for any given resource, only _one_ request is actually in flight to the origin at a time. In the Go ecosystem, this is often handled by the `singleflight` group.

```go
// A simplified look at request collapsing
var g singleflight.Group

func getAsset(key string) ([]byte, error) {
    v, err, shared := g.Do(key, func() (interface{}, error) {
        return fetchFromOrigin(key) // Only one of these runs at a time per key
    })

    if err != nil {
        return nil, err
    }
    return v.([]byte), nil
}
```

**The Edge Limitation:** Traditional `singleflight` works great on a single machine. But at the edge, you have nodes in Tokyo, London, and New York. If 100 nodes in Tokyo all hit the same regional mid-tier cache, you need that collapsing to happen at the **regional level**, not just the local process level.

We implemented what we call **Global Request Collapsing**. When an edge node misses its local L1 cache, it sends a "claim" to a regional coordinator (L2). The coordinator tracks "in-flight" fetches. If a fetch is already happening for that specific hash, the L2 coordinator puts the request into a "wait queue" and streams the response to all waiters once the first fetch completes.

---

## Part 2: Moving from Static Limits to Adaptive Backpressure

Request collapsing solves the "duplicate work" problem, but it doesn't solve the "too much work" problem. What happens when the origin is legitimately slow, or the sheer volume of _unique_ requests is too high?

Traditional systems use **Fixed Rate Limiting**. (e.g., "Tenant A gets 1,000 requests per second"). This is blunt and inefficient.

- If the system is healthy, why cap them at 1,000?
- If the system is dying, 1,000 might still be too many.

### The Philosophy of Adaptive Backpressure

We moved away from hard limits toward a system based on **Control Theory**. We treat our edge-compute-to-origin pipeline like a pipe with variable pressure.

Our implementation is inspired by **TCP BBR (Bottleneck Bandwidth and Round-trip propagation time)**. Instead of waiting for packet loss (or 5xx errors) to slow down, we constantly measure the **bandwidth-delay product**.

#### The Metrics that Matter:

1.  **Queue Depth:** How many requests are waiting for a worker thread?
2.  **Origin Latency (RTT):** How long is the round-trip taking?
3.  **CPU Steal/Pressure:** Is the underlying hardware struggling to context-switch?

### The Algorithm: The PID Controller for Traffic

We use a PID (Proportional-Integral-Derivative) controller to dynamically adjust the "Backpressure Value" ($B$).

$$B(t) = K_p e(t) + K_i \int e(t) dt + K_d \frac{de(t)}{dt}$$

Where $e(t)$ is the error between our target latency and the actual latency.

**How it works in practice:**
As the origin begins to slow down (the "Initial Stall"), the _Derivative_ component of our controller sees the rate of change in latency spiking. Even if we haven't hit the "Max Latency" threshold yet, the system starts **shedding load**.

We don't just drop requests randomly. We use **Weighted Priority Queuing**:

- **Health Checks:** Highest priority.
- **Stateful API calls:** High priority.
- **Static Assets:** Low priority (can be retried later).
- **Background Tasks:** Lowest priority.

By pushing "Backpressure" back to the edge node, we tell the edge: _"Hey, the origin is struggling. Don't even bother sending this low-priority request. Fail fast and let the client retry with exponential backoff."_

---

## Part 3: Predictive Caching—Solving the Problem Before it Happens

Backpressure is a reactive solution. It saves the system from dying, but the user still sees an error or a delay. To provide a "premium" experience, we need to be **proactive**.

This is where **Predictive Caching** comes in. If we can predict the stampede, we can pre-warm the cache.

### The "Heat Map" Architecture

In a multi-tenant environment, we track the "Access Velocity" of every asset. Most assets follow a Power Law distribution (a few are very popular, most are never seen again).

We implemented a **Global Pulse Service** that aggregates metadata about cache misses in real-time.

1.  **The Detection:** The Pulse service sees that a specific Wasm binary (Asset X) just had 50 misses in 10 different geographic regions within 200ms.
2.  **The Prediction:** The system identifies this as the start of a "Viral Event."
3.  **The Propagation:** Before the other 400 edge nodes even receive their first request for Asset X, the Pulse service issues a "Pre-Warm" command.

### Machine Learning at the Edge?

We don't use a heavy LLM for this. That would be too slow. Instead, we use a **Streaming Sketches (Count-Min Sketch)** and a **Linear Regression model** running inside our Rust-based data plane.

The model looks at:

- **Temporal Locality:** Did this happen at the top of the hour? (Common for cron jobs/scheduled tasks).
- **Referrer Spikes:** Is the traffic coming from a specific social media domain?
- **Tenant History:** Does Tenant A usually have "bursty" traffic on Friday nights?

When the confidence score hits a threshold (e.g., > 0.85), we trigger a **Background Prefetch**. The edge node fetches the asset from the origin using "spare" bandwidth (lowest priority) before the user even asks for it.

### Code Snippet: The Prefetch Logic (Rust)

```rust
async fn handle_request(req: Request) -> Response {
    let cache_key = derive_cache_key(&req);

    // Check L1 cache
    if let Some(cached_res) = L1.get(&cache_key) {
        // Record hit for the Pulse Service (Async)
        Pulse::record_hit(&cache_key);
        return cached_res;
    }

    // It's a miss. Check if a prefetch is already in progress.
    if let Some(waiter) = PrefetchManager::get_waiter(&cache_key) {
        return waiter.await;
    }

    // No prefetch? This node is the "leader" for this fetch.
    let response = fetch_and_stream_to_cache(req).await;

    // Notify the Pulse Service that we've had a cold start
    Pulse::record_miss(&cache_key).await;

    response
}
```

---

## Part 4: The Scale of the Challenge

When you're operating at our scale—thousands of nodes across 200+ cities—the "Thundering Herd" isn't just about HTTP requests. It's about every layer of the stack.

### 1. The DNS Stampede

Before the HTTP request even happens, the client does a DNS lookup. If a million clients all do a lookup at once, your DNS infrastructure becomes the bottleneck. We solved this by using **Anycast IP routing** combined with very aggressive TTLs for "hot" records, and by implementing DNS-level load shedding.

### 2. The TLS Handshake Problem

Each "herd" member needs to establish a TLS connection. The cryptographic overhead of thousands of simultaneous handshakes can max out CPU on an edge node.

- **Solution:** We use **TLS Session Resumption** and **OCSP Stapling** to minimize the round-trips and compute required for every new connection in the stampede.

### 3. The Wasm Cold Start

In a multi-tenant edge compute platform, the "asset" being fetched is often the code itself (e.g., a WebAssembly module). Loading a 10MB Wasm module, instantiating the runtime, and setting up the sandbox takes time.

- **The Optimization:** We don't just cache the Wasm binary; we cache the **initialized snapshot** of the VM. By using a technique similar to the one used in Firecracker microVMs, we can "resume" a pre-initialized execution state in sub-millisecond times.

---

## Dealing with "Noisy Neighbors" in a Stampede

In a multi-tenant world, the biggest fear is that Tenant A’s viral success causes Tenant B’s API to fail.

We solve this using **Hierarchical Token Buckets (HTB)** for resource allocation. Every tenant has a "Committed Information Rate" (CIR) and a "Peak Information Rate" (PIR).

- **CIR:** The bandwidth/compute you are guaranteed.
- **PIR:** The "burst" you can have if the system has spare capacity.

During a Thundering Herd event, our **Adaptive Backpressure** system immediately clamps everyone down to their **CIR**. If the stampede continues and even the CIR-level traffic is threatening the node's stability, we use **Fair Queuing** to ensure that the "Elephant Flows" (the tenant causing the stampede) are the ones seeing the highest drop rate, while "Mice Flows" (small, steady tenants) continue unaffected.

---

## Hardware-Level Acceleration: eBPF and XDP

To make backpressure truly "zero-latency," we can't wait for the request to reach the application layer (Layer 7) to drop it. If we’re under a massive DDoS-style stampede, we need to drop packets at the kernel level.

We use **eBPF (Extended Berkeley Packet Filter)** and **XDP (eXpress Data Path)**.

When our control plane detects that a specific tenant’s origin is failing, it pushes an eBPF map update to the edge nodes. The XDP program running in the NIC (Network Interface Card) driver checks incoming packets. If a packet is destined for a "stalled" service, the NIC drops it immediately.

**This happens before the packet even reaches the Linux networking stack.** This allows a single edge node to shed millions of requests per second with negligible CPU usage.

---

## Lessons from the Trenches: Why "Retry" is a Dangerous Word

One of the most surprising things we learned while building this was that **client-side retries are often the "gasoline" on the fire.**

If an edge node returns a 503 (Service Unavailable), most modern SDKs will automatically retry. If 10,000 clients retry at the same time, the herd grows exponentially.

**Our Fix: The "Retry-After" Header.**
We started aggressively using the `Retry-After` HTTP header. But instead of a static value, we calculate the value based on the **PID controller's error margin**. If the origin is slightly slow, we say `Retry-After: 1`. If it's in a death spiral, we say `Retry-After: 30`.

More importantly, we implemented **Jitter**. We never tell every client to retry in 5 seconds. We tell one to retry in 4.2s, another in 5.8s, and another in 6.1s. This "shatters" the herd into a manageable stream of requests.

---

## The Results: Resilience by Design

By combining these strategies, we’ve seen a dramatic shift in our platform’s stability:

- **Origin Load Reduction:** During "Viral Events," origin traffic spikes are now capped at **3x** the baseline, compared to the **50x-100x** spikes we saw previously.
- **Tail Latency (p99):** In multi-tenant contention scenarios, p99 latency remained under **150ms**, whereas it previously trended toward timeouts (>30s).
- **Cache Hit Ratio:** Predictive caching has increased our effective cache hit ratio for "hot" assets from **88% to 99.4%**.

---

## The Future: Intent-Aware Networking

We’re not done. The next frontier is **Intent-Aware Networking**. Instead of just looking at "Access Velocity," we’re training models to understand the _intent_ of the code running at the edge.

Is this code fetching a stock price? (Very time-sensitive). Is it fetching a profile picture? (Less time-sensitive). By understanding the _semantics_ of the workload, we can make even smarter backpressure decisions—ensuring that the most critical data always finds a clear path through the stampede.

The edge is a chaotic place. It’s a frontier where the laws of centralized computing break down. But with a combination of Control Theory, predictive heuristics, and low-level kernel magic, we can turn a thundering herd into a disciplined parade.

**Are you interested in building the future of the edge?** We’re always looking for engineers who love diving into the guts of distributed systems, eBPF, and Wasm. Check out our careers page and help us tame the next stampede.
