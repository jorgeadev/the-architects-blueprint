---
title: "The Billion-Request Sprint: How Cloudflare’s Pingora Smashed Tail Latencies with Rust"
shortTitle: "How Cloudflare’s Pingora Slashed Tail Latencies with Rust"
date: 2026-09-16
image: "/images/2026/09/16/the-billion-request-sprint-how-cloudflare-s-pingora-smashed-.svg"
---

Imagine you are standing at the edge of the internet. Every second, tens of millions of requests from every corner of the globe slam into your infrastructure. For over a decade, the industry standard for handling this onslaught was NGINX—a battle-hardened, C-based titan. But as the web evolved into a complex mesh of HTTP/3, gRPC, and massive connection pools, the titan started to stumble.

At Cloudflare, the stakes weren’t just about "uptime"; they were about **P99.99 tail latencies.** When you're proxying trillions of requests, a "minor" 50ms spike for 0.1% of users translates to millions of frustrated people.

Enter **Pingora**.

In 2022, Cloudflare did the unthinkable: they began migrating their entire edge proxy infrastructure from NGINX to a homegrown, Rust-based framework. The result? A **70% reduction in median latency** and a staggering **95% reduction in 99th percentile tail latencies.**

This isn't just a story about "Rust is fast." It’s a masterclass in systems engineering, memory safety at scale, and the deconstruction of how modern proxies should handle the lifecycle of a request. Let’s look under the hood.

---

## The Architecture of a Bottleneck: Why NGINX Had to Go

To understand why Pingora is a marvel, we have to understand the architectural debt of NGINX. NGINX follows a **process-based model**. When NGINX starts, it spawns a number of worker processes (usually one per CPU core).

While this model provides excellent isolation (if one worker crashes, the others live), it introduces a fatal flaw for a global-scale proxy: **The Connection Silo.**

1.  **Poor Connection Reuse:** In NGINX, connection pools are bound to individual worker processes. If Worker A has an established, idle keep-alive connection to an origin server, but a new request hits Worker B, Worker B cannot use Worker A’s connection. It must initiate a new TCP/TLS handshake.
2.  **The Thundering Herd:** When a surge of traffic arrives, the OS kernel wakes up multiple worker processes to accept the new connections. This causes massive context-switching overhead and CPU contention.
3.  **Rigid Extensibility:** Extending NGINX usually meant writing C modules (terrifying for memory safety) or using Lua (powerful, but with a performance ceiling and its own "Stop the World" garbage collection issues).

As Cloudflare scaled, these "micro-inefficiencies" compounded. The handshake overhead alone was adding milliseconds of latency to requests that _should_ have been near-instant.

---

## Pingora’s Multi-Threaded Revolution

Pingora was designed from day one as a **multi-threaded architecture** rather than a multi-process one. In the world of C, multi-threading at edge scale is a recipe for catastrophic memory corruption and race conditions. But in **Rust**, the compiler is your guardian.

By using a multi-threaded model, Pingora allows all worker threads to share the same memory space. This fundamentally changes the economics of connection pooling.

### The Global Connection Pool

Because all threads can access a shared pool, the "Connection Silo" problem vanishes. If _any_ thread has an open connection to an origin server, _any other_ thread can grab it.

**The impact is massive:**

- **Reduced Handshakes:** Cloudflare reported that Pingora reduced the number of new handshakes by orders of magnitude.
- **TTFB (Time to First Byte) Improvements:** By eliminating the 3-way TCP handshake and the multi-step TLS negotiation for the majority of requests, the "cold start" of a request was virtually eliminated.

### The Role of Tokio and Async Rust

Pingora leverages `Tokio`, the industry-standard async runtime for Rust. However, they didn't just use it "out of the box." They optimized the task scheduling to ensure that high-priority proxying tasks aren't blocked by background maintenance (like logging or metrics).

In a typical async environment, if a task takes too long to yield (computational heavy lifting), it "starves" the executor. Pingora uses a customized **work-stealing scheduler**. If one CPU core is overwhelmed, other idle cores can "steal" pending requests from its queue, ensuring that no single request gets stuck behind a heavy payload.

---

## Eliminating the "Long Tail": Engineering for Sub-Millisecond Latency

When we talk about "sub-millisecond tail latencies," we aren't talking about the average. We are talking about the **P99 and P999**—the requests that, for some reason, take 10x or 100x longer than the rest.

In Pingora, the quest for the sub-millisecond tail involved three core engineering pillars: **Zero-copy, Lock Contention Minimization, and Deterministic Memory Management.**

### 1. The Zero-Copy Holy Grail

In a proxy, every time you copy data from a kernel buffer to a user-space buffer, or from one part of the application to another, you burn CPU cycles and increase the chance of a cache miss.

Pingora utilizes **Zero-copy parsing**. When a request comes in, Pingora doesn't "copy" the HTTP headers into new string objects. Instead, it uses **slices**—pointers to the original memory buffer where the data already lives.

```rust
// A conceptual look at how Pingora might handle header slices
struct RequestHeader<'a> {
    method: &'a [u8],
    path: &'a [u8],
    version: HttpVersion,
}

impl<'a> RequestHeader<'a> {
    fn parse(buffer: &'a [u8]) -> Self {
        // Instead of allocating new strings, we reference the existing buffer
        let method = &buffer[0..3]; // "GET"
        // ... logic to parse the rest
        Self { method, path, version }
    }
}
```

By minimizing allocations, Pingora keeps the CPU's L1/L2 caches "warm" with actual data rather than management overhead.

### 2. Nuking Lock Contention

In a multi-threaded environment, "Locks" (Mutexes) are the silent killers of performance. If 24 threads are all trying to update the same "Request Counter" or "Connection Pool," they will spend more time waiting for the lock than doing actual work.

Pingora's engineers employed **Lock-free data structures** and **Atomic primitives** wherever possible. Instead of one giant lock for the connection pool, they used **sharded data structures**.

Imagine a parking lot. Instead of having one gate where everyone has to wait for one attendant, you have 16 gates. The "shards" are determined by a hash of the destination IP, meaning threads rarely contend for the same lock unless they are talking to the exact same origin server at the exact same microsecond.

### 3. Avoiding the Garbage Collection Tax

This is where Rust truly shines over Go or Java. In Go, the Garbage Collector (GC) must periodically scan memory to find unused objects. Even with modern "low-latency" GCs, there are "STW" (Stop The World) moments or background CPU spikes that inevitably cause a jitter in the tail latencies.

**Rust has no Garbage Collector.**

Memory is reclaimed the exact moment it goes out of scope. In Pingora, this means the latency profile is **deterministic**. A request handled at 2 PM will have the exact same memory overhead as one handled at 4 AM, regardless of how much memory is currently being used by other threads.

---

## The "Hype" vs. The Substance: Why Rust Wasn't Just a Trend

When Cloudflare announced they were moving to Rust, the "Rustaceans" cheered, and the skeptics rolled their eyes, calling it a "rewrite for the sake of a rewrite." But the technical substance behind the move was undeniable.

### Safety as a Performance Metric

In C, a `use-after-free` or a `buffer overflow` isn't just a security risk; it’s a performance killer. When NGINX crashed due to a memory bug (which happened, despite its maturity), the process had to restart, the caches were lost, and the system entered a "warm-up" phase that spiked latencies.

Rust's **ownership and borrowing** rules mean that Pingora is mathematically guaranteed to be free of these specific memory bugs.

**This allows for "Fearless Concurrency."** Engineers could implement aggressive optimizations—like sharing complex state between threads—that they would never have dared in C. The performance gains didn't come from Rust being "faster" at adding numbers; they came from Rust allowing engineers to build a **more complex, more efficient architecture** that would be too dangerous to build in C.

---

## Compute at Scale: The Infrastructure Impact

Pingora isn't just a software triumph; it’s a massive win for Cloudflare’s bottom line and environmental footprint.

- **CPU Savings:** By moving to Pingora, Cloudflare reduced their overall CPU usage by about **70%** compared to NGINX for the same traffic load. In a data center environment, that translates to thousands of servers that can now be used for other tasks (like Cloudflare Workers).
- **Memory Efficiency:** The memory footprint dropped by **67%**. This is largely due to the shared connection pooling. NGINX workers were often duplicating memory for the same metadata; Pingora stores it once.

### Handling HTTP/3 and QUIC

HTTP/3 is based on QUIC, which runs over UDP. Unlike TCP, which the kernel handles, QUIC is almost entirely implemented in user-space. This puts a massive burden on the proxy.

Pingora’s architecture allowed Cloudflare to integrate their `quiche` library (also written in Rust) seamlessly. The asynchronous nature of Pingora is perfectly suited for the packet-based flow of QUIC, allowing for sub-millisecond processing of encrypted packets even under heavy load.

---

## Life of a Request in Pingora: A Technical Walkthrough

To see how all this results in sub-millisecond wins, let's trace a single request through the Pingora lifecycle.

1.  **The Entry (Zero-Copy Arrival):**
    A packet arrives at the NIC. Pingora's listener thread (using `epoll` or `io_uring` via Tokio) picks it up. Instead of copying the packet, it hands a pointer to the buffer to a worker thread.

2.  **The Filter Chain:**
    Pingora uses a modular "Phase" system. Unlike NGINX's rigid module system, Pingora's phases are Rust traits.

    ```rust
    pub trait ProxyHttp {
        fn request_filter(&self, _session: &mut Session) -> Result<bool>;
        fn upstream_peer(&self, _session: &mut Session) -> Result<Box<Peer>>;
        // ... more phases
    }
    ```

    Each "filter" (Rate limiting, WAF, Bot management) runs in order. Because these are native Rust functions, the compiler inlines them, eliminating the overhead of function calls or jumping between different memory segments.

3.  **The Connection Grab:**
    The request needs an upstream connection. Pingora checks the **Lock-Free Sharded Connection Pool**. It finds an existing TLS 1.3 session to the origin. No handshake is needed.

4.  **Header Transformation:**
    Pingora needs to add a `CF-Ray` header. In NGINX, this might involve a re-allocation of the entire header block. In Pingora, it uses a **vector-based header map** that allows for O(1) or O(log n) insertions with minimal memory movement.

5.  **The Stream:**
    As the origin server streams data back, Pingora uses **Asynchronous Pipes**. Data is pulled from the upstream socket and pushed to the downstream socket in chunks. If the client is slow, Pingora’s backpressure mechanism kicks in, pausing the upstream read to avoid memory bloating—a common issue in less sophisticated proxies.

6.  **Telemetry (Non-Blocking):**
    Metrics are updated using **Atomic integers**. There is no "logger" process slowing things down. The data is pushed to a ring buffer and processed out-of-band.

---

## The Engineering Curiosity: "The Cold Start" Mitigation

One of the most impressive "hidden" features of Pingora is how it handles the **"Thundering Herd"** at the edge.

When a new edge node spins up, it has no open connections. In the old NGINX world, this would cause a massive spike in latency as the node performed millions of handshakes simultaneously.

Pingora implements **Adaptive Connection Rate Limiting**. It "warms up" connections intelligently. If it detects a surge of requests for a specific origin, it doesn't just open 10,000 connections at once. It opens them in waves, reusing the first few to satisfy the initial burst while scaling the pool in the background. This prevents the origin server from being "DDOSed" by its own proxy—a common problem during traffic shifts.

---

## Beyond the Proxy: The Future of Pingora

Cloudflare didn't just build Pingora for themselves. They've open-sourced parts of it, signaling a shift in how we think about edge networking.

The success of Pingora proves that **System-Level Programming 2.0 (Rust)** is ready for the most demanding environments on Earth. It demonstrates that the trade-off between "Safety" and "Speed" is a false dichotomy. By choosing a language that enforces safety, you gain the architectural freedom to build systems that are significantly faster than their "unsafe" predecessors.

The sub-millisecond tail latency achieved by Pingora isn't the result of a single "silver bullet." It is the result of:

- **Moving from Processes to Threads** to enable global state sharing.
- **Leveraging Rust’s Borrow Checker** to eliminate the overhead of garbage collection and memory safety checks at runtime.
- **Deeply Optimizing the Async Runtime** to ensure work is distributed evenly across the CPU.
- **A Zero-Copy Mindset** that treats every byte moved as a potential bottleneck.

As we move toward a world of 100Gbps networking and beyond, the lessons of Pingora serve as a blueprint for the next generation of high-performance infrastructure. The titan has been replaced, and the new king is written in Rust.
