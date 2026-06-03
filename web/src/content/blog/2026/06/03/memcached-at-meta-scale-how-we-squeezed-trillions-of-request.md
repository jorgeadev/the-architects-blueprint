---
title: "🚀 Memcached at Meta Scale: How We Squeezed Trillions of Requests/Second Out of a 20-Year-Old Cache"
shortTitle: "Memcached at Meta: Trillions of Requests/Second"
date: 2026-06-03
image: "/images/2026/06/03/memcached-at-meta-scale-how-we-squeezed-trillions-of-request.jpg"
---

**The moment your Facebook feed loads, you've just touched one of the most brutally optimized distributed systems on Earth.**

You probably don't think about it. You scroll. You double-tap. The app feels instant. But behind that millisecond response lies a war fought at the network layer, where **Meta's Memcached fleet handles more queries per second than all the world's search engines combined.**

Let me show you what that actually looks like under the hood.

---

## The Hook That Pulls You In

Imagine a system so fast that **adding network latency between servers actually _reduces_ throughput**—not because the network is slow, but because the CPU spends more time waiting for packet acknowledgments than processing data. That's the kind of paradox you hit when you're pushing **trillions of requests per day** through a single caching layer.

In 2023, Meta published [a paper](https://research.facebook.com/publications/scaling-memcached-at-facebook/) that quietly dropped a bomb on the distributed systems community. They revealed that their production Memcached cluster **routinely handles 200 billion requests per second** during peak traffic. To put that in perspective:

- That's **2.3 million queries per millisecond**
- Each query must complete in **under 1 millisecond**
- The cache hit rate consistently exceeds **99.6%**
- The system has been running **for over 15 years without a global outage**

This isn't just "scaling up." This is **rewriting the laws of physics for data access**.

---

## Why Memcached? Why Not Redis? Why Not Custom?

Here's the spicy truth: **Meta's engineers hate Memcached**.

They've said it publicly. The data structures are primitive. The memory allocator is a disaster at scale. There's no built-in replication, no persistence, no security. By every modern standard, it's a terrible choice.

But here's the thing: **Memcached's simplicity is its superpower.**

At Meta's scale, **predictable latency trumps advanced features**. Redis with its rich data types introduces unpredictable CPU spikes. Custom systems introduce bugs. Memcached does one thing—**O(1) key-value lookups over TCP**—and does it so simply that engineers can reason about every single cache miss.

This is the first lesson of Meta's architecture: **Do one thing perfectly, then optimize the hell out of the surrounding infrastructure.**

---

## The Three-Layer Architecture That Defeated Physics

Let me break down the actual deployment topology. This isn't theoretical—this is what runs in Meta's fleet today.

### Layer 1: The Frontend Farm (The "Mcrouter" Layer)

Every web server at Meta runs a local **Mcrouter** instance. This is Meta's homegrown routing proxy that turns Memcached from a simple daemon into a **distributed hash table with global coordination**.

```text
Web Server A
  └─ Local Mcrouter (process)
       ├─ Memcached Pool 1 (US-East)
       ├─ Memcached Pool 2 (US-West)
       └─ Memcached Pool 3 (EU)

Web Server B
  └─ Local Mcrouter (process)
       ├─ Memcached Pool 1 (US-East)
       ├─ Memcached Pool 2 (US-West)
       └─ Memcached Pool 3 (EU)
```

**The critical design choice:** Mcrouter runs as a **process local to each web server**, not as a standalone cluster. Why? Because **every microsecond of routing overhead compounds**.

- **No additional network hop**—Mcrouter communicates with Memcached servers over the same rack switches
- **In-process connection pooling**—reuses TCP connections across all requests
- **Dynamic topology discovery**—Mcrouter learns server failures and pool assignments via a gossip protocol that converges in **under 100ms**

### Layer 2: The Cache Tiers (Why You Need 3 Separate Pools)

Most engineers think "one big cache pool." Meta runs **three distinct tiers per region**:

| Tier         | Size    | Latency Budget | Eviction Policy | Use Case                     |
| ------------ | ------- | -------------- | --------------- | ---------------------------- |
| **Regional** | 100+ TB | <500μs         | LRU             | Hot user data, session state |
| **Replica**  | 50+ TB  | <1ms           | LRU             | Read replicas of hot keys    |
| **Frontend** | 10+ TB  | <100μs         | None\*          | Pinned, never-evict data     |

**Wait, a tier with no eviction?** Yes. The **Frontend tier** stores data that _must never be evicted_—like authentication tokens and routing metadata. This is a radical departure from standard Memcached behavior. Meta achieved this by modifying the Memcached source to support **key pinning** with custom slab allocator policies.

### Layer 3: The Shared Memory Secret Weapon

Here's where it gets wild. Meta doesn't actually run Memcached as a standalone process on their web servers. They use **shared memory regions** to bypass the overhead of inter-process communication entirely.

```
Web Server Process
  ├─ Request Handler Thread
  │    └─ Maps to Shared Memory Region A
  ├─ Another Handler Thread
  │    └─ Maps to Shared Memory Region B
  └─ Mcrouter Process
       └─ Also maps to Region A & B
```

This means **the web server's request handlers and Mcrouter both access the same in-memory cache without any serialization or copying**. The data is just _there_—a pointer away.

At this point, you're not "getting data from cache." You're **reading memory that was already cache-hot for your process**.

---

## The Network Stack: Where Most Systems Die

Memcached's original implementation uses a **single-threaded event loop** with `epoll` or `kqueue`. At Meta's scale, that's a joke. They've completely rewritten the I/O layer.

### The Problem with Traditional Memcached I/O

Standard Memcached:

```
Client → TCP connect → SYN/ACK Handshake → Send request → Server parses → Send response
```

At 200 billion requests/second, the TCP handshake alone would consume **all available CPU** on the switching fabric.

### Meta's Solution: `mutilate` + Kernel Bypass

Meta developed **`mutilate`** (now open-source as part of their Memcached fork), which implements:

1. **UDP for reads, TCP for writes**: Because 99% of traffic is reads, and UDP avoids the TCP slow start bottleneck
2. **Kernel bypass with DPDK**: Data Plane Development Kit bypasses the kernel network stack entirely:
    - No TCP stack processing
    - No socket buffer copies
    - Direct NIC-to-application memory mapping
3. **Connection batching**: A single Mcrouter instance can send **thousands of cache requests in a single send() call**, amortizing system call overhead

The result? **Per-core throughput increased from 500K req/s to 6M req/s**—a 12x improvement without changing the Memcached protocol.

---

## The Slab Allocator Nightmare (And How They Fixed It)

Memcached's slab allocator is famously fragile. It pre-allocates memory into slabs of fixed sizes (64B, 128B, 256B, etc.). If a key-value pair doesn't fit neatly into a slab, **memory fragmentation explodes**.

At Meta's scale, this was causing **20-30% memory waste**. Their fix is a masterclass in practical engineering:

### The Arena Allocator

Instead of fixed slabs, Meta's Memcached uses **arena allocation** with dynamic slab growth:

```c
// Simplified pseudo-code
typedef struct {
    char* base;        // Start of arena
    size_t used;       // Current usage
    size_t capacity;   // Max capacity
    pthread_mutex_t lock;  // Per-arena lock
    void* last_alloc;  // For fast O(1) freeing
} arena_t;

// On allocation:
void* arena_alloc(arena_t* arena, size_t size) {
    pthread_mutex_lock(&arena->lock);
    void* ptr = arena->base + arena->used;
    arena->used += size;
    arena->last_alloc = ptr;
    pthread_mutex_unlock(&arena->lock);
    return ptr;
}
```

This is **dramatically simpler** than the original slab allocator. It trades memory fragmentation for **linear allocation speed**. And because Meta's workloads are dominated by **small, uniformly-sized objects** (session tokens, user IDs), fragmentation is minimal.

But here's the genius: **They never free individual allocations.** The arena is only reclaimed when an entire page (4KB) is evicted. This eliminates the need for garbage collection or defragmentation entirely.

---

## Consistency: The Elephant in the Room

How does Meta handle cache consistency when you have **2000+ Memcached servers** and **every write must be instantly visible**?

**They don't.** At least, not in the traditional sense.

### The "Invalidate, Don't Update" Mantra

Meta's rule is simple:

- **Writes go to the database first**
- **The database asynchronously invalidates the cache**
- **Cache misses are acceptable; stale data is not**

This means Mcrouter doesn't use cache-coherence protocols like MESI. Instead, it tracks **invalidation queues**:

```text
Database Write → Invalidation Queue (Redis Stream) → Mcrouter hears invalidation → Marks key as "maybe stale" → Next read triggers fresh fetch
```

### The "Lease" Mechanism for Thundering Herds

When a popular key is invalidated (e.g., "trending_video_123"), thousands of servers immediately request it from the database. This **thundering herd** can crush the DB.

Meta's fix: **Leases**. When Mcrouter sees the first cache miss for a key, it returns a **lease token** to one server:

```
Server A: GET key → MISS → Receives lease token #42
Server B: GET key → MISS → Receives "LEASE_DENIED"
Server A: SET key value WITH TOKEN #42 → Cache updates
Server B: RETRY GET key → HIT
```

This ensures **only one server ever goes to the database for a given key at a time**. The lease token prevents stale writes from out-of-order responses.

---

## The "No Failures" Myth: How They Survive at Scale

Meta's SREs love to say: **"Everything fails, all the time."** At 200B req/s, you have:

- **1 server failure every 3 minutes** (due to hardware faults)
- **2 network link drops per hour** (from optical transceiver failures)
- **Uncountable packet corruption** (cosmic rays flipping bits in DRAM)

### The "N+2" Redundancy Model

Instead of N+1 (standard), Meta uses N+2 for their cache pools:

```text
Pool for "user_sessions"
  ├─ 10 active servers
  ├─ 1 standby (warm)
  └─ 1 cold spare (offline, can be provisioned in 5 seconds)
```

The **cold spare** is a machine that isn't even powered on. But because Meta's orchestration system can **PXE-boot and configure a server in 5 seconds**, a cold spare is statistically always available before a second failure occurs.

### The "Rolling Degradation" Protocol

When a cache server starts dying (e.g., memory errors increasing), it doesn't just crash. It enters **degraded mode**:

1. **Stops accepting writes** (stops growing its dataset)
2. **Serves reads only** (still useful for 30-60 seconds)
3. **Drains its data** (sends most frequently accessed keys to neighbors)
4. **Signals "dying"** to Mcrouter, which re-routes traffic

This graceful degradation means **no sudden traffic spikes** to other servers—the load is spread over minutes, not milliseconds.

---

## The Hardest Lesson: Why Simplicity Wins

I've saved the most important insight for last. Meta's engineers could have built a cutting-edge distributed cache with:

- CRDT-based conflict resolution
- Multi-master replication
- Automatic sharding
- Rich query capabilities

They didn't. They **kept Memcached's insane simplicity** and spent all their engineering effort on:

- **Network optimization** (DPDK, batching)
- **Memory efficiency** (arena allocator)
- **Failure resilience** (leases, degradation)
- **Observability** (every cache miss is logged with a stack trace)

The result is a system where **the core caching logic is 200 lines of C**, but the supporting infrastructure is **50,000+ lines of auxiliary code**.

This is the ultimate engineering lesson: **Complexity belongs in the infrastructure, not in the protocol.**

---

## What This Means for Your Architecture

You probably don't need 200 billion req/s. But Meta's approach reveals principles that apply at any scale:

1. **Measure everything, then optimize the bottleneck.** For Meta, it was network I/O. For you, it might be memory bandwidth or serialization overhead.
2. **Accept eventual consistency** for read-heavy workloads. Cache invalidation is expensive—design your system to tolerate it.
3. **Use leases or similar throttling** to protect your database from thundering herds. Even 100 req/s can overwhelm a Postgres instance.
4. **Prefer process-local caching** with shared memory over remote caches. The difference between a pointer dereference and a network round trip is **1000x** in latency.

**The next time you write a `cache.get(key)` in production, remember:** you're standing on the shoulders of a system that had to solve problems most engineers never even imagine.

And if your cache miss rate exceeds 1%, someone at Meta is probably having a very bad day.

---

_Want to dive deeper? Meta's engineering blog has the full paper on [Scaling Memcached at Facebook](https://research.facebook.com/publications/scaling-memcached-at-facebook/). I also highly recommend exploring their open-source [Mcrouter](https://github.com/facebook/mcrouter) code—it's a masterclass in C++ network programming._

**What's your experience with scaling caches? Drop a comment—I'd love to hear about your war stories.**
