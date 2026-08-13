---
title: "When Trillions of Requests Collide: How Facebook Tames the Thundering Herd"
shortTitle: "Facebook: Taming the Thundering Herd at Scale"
date: 2026-08-13
image: "/images/2026/08/13/when-trillions-of-requests-collide-how-facebook-tames-the-th.svg"
---

Imagine you are a backend engineer at Facebook (Meta). It’s a quiet Tuesday afternoon until a celebrity with 100 million followers posts a single photo. Within milliseconds, hundreds of thousands of concurrent requests slam into the edge tier. The cache—your first line of defense—looks for the data. But there’s a problem: the metadata for that post was just invalidated due to a minor update.

In a naive system, those 100,000 requests would see a "cache miss" and simultaneously sprint toward your underlying database. This is the **Thundering Herd**. It’s not just a performance dip; it’s a recursive failure event that can melt down entire data centers in seconds. At Facebook’s scale, where we deal with **trillions of objects** and **quadrillions of queries per day**, a thundering herd isn't just an edge case—it's the apex predator of distributed systems.

In this deep dive, we’re going into the trenches of how Facebook manages cache invalidation at hyperscale. We’ll explore the evolution from simple Memcached setups to the sophisticated **Delos** consensus protocol, the **McSqueal** invalidation pipeline, and the logic of **Leases** that keeps the world’s largest social graph from collapsing under its own weight.

---

## The Anatomy of the Stampede

Before we look at the cure, we have to understand the pathology. In a typical distributed cache (like Memcached or Redis), a "cache stampede" or thundering herd occurs when:

1.  A high-read-concurrency key (a "hot key") expires or is invalidated.
2.  Multiple parallel worker threads/processes identify the miss.
3.  All workers attempt to recompute or fetch the value from the upstream database simultaneously.

At hyperscale, "multiple" means 50,000+ requests hitting a MySQL shard at the exact same microsecond. The database, already under load, slows down. Because the database is slow, the cache stays empty longer, leading to _more_ incoming requests piling into the database queue. Eventually, the database runs out of connections, memory, or CPU, and it crashes.

When it reboots, it’s immediately greeted by the same 50,000 requests. **Game over.**

---

## Strategy 1: The Gatekeeper Pattern (Leases)

Facebook’s first major breakthrough in this space was the implementation of **Leases** within their modified Memcached (and later in **TAO**, the distributed data store for the social graph).

The logic is elegantly simple but technically difficult to implement at low latency. When a client experiences a cache miss, the cache doesn't just say "I don't have it." Instead, it issues a **Lease Token**.

### How the Lease Logic Works:

1.  **Request 1** asks for `user_data:123`. It’s a miss.
2.  The Cache grants a **64-bit lease token** to Request 1 and says: "You are the chosen one. Go fetch this from the DB."
3.  **Requests 2 through 10,000** ask for the same key 5 milliseconds later.
4.  The Cache sees it has already issued a lease. It tells these requests: **"Wait a moment."**

In a technical sense, the cache node acts as a **serialization point**. Instead of 10,000 database queries, only one goes through.

### Stale-While-Revalidate

But what if we don't want the other 9,999 requests to wait? For social media, "slightly old" data is often better than "no data." Facebook’s cache implements a **stale data return** policy. If a key is invalidated, the cache can keep the old version for a few seconds (the "grace period").

While the "chosen" request (the leaseholder) fetches the fresh data, everyone else gets the stale version. This ensures the p99 latency remains flat even during a thundering herd event.

```cpp
// Pseudocode for Lease Logic in a Cache Node
Value Get(Key k) {
    Entry e = Cache.Lookup(k);
    if (e.is_valid()) {
        return e.value;
    }

    if (e.has_active_lease()) {
        if (config.allow_stale) {
            return e.stale_value; // Prevent the herd by serving old data
        }
        return ERR_RETRY_LATER; // Tell client to back off for 10ms
    }

    LeaseToken token = GenerateLease(k);
    return LeaseRequired(token); // Tells the client to go to the DB
}
```

---

## Strategy 2: McSqueal and the Invalidation Pipeline

Caching isn't just about reading; it's about making sure you aren't reading "lies." At Facebook's scale, the biggest challenge isn't the _misses_—it's the **invalidations**.

When you change your profile picture, that change must be reflected globally. If you have 50 cache clusters around the world, how do you tell all of them "Delete the old photo" without creating a thundering herd of re-fetches or, worse, a network broadcast storm?

Enter **McSqueal**.

McSqueal is a high-throughput, distributed log-delivery system. Instead of every web server trying to send invalidation packets to every cache server (which would result in $O(N \times M)$ connections), McSqueal taps into the **database commit logs**.

### The Flow:

1.  A user updates a row in a MySQL shard.
2.  A local daemon (**InvalAgent**) tails the MySQL binlog.
3.  The agent batches these changes and sends them to a **McSqueal Router**.
4.  The Router fan-outs the invalidations to the specific cache clusters that need them.

By decoupling the invalidation from the application logic, Facebook ensures that even if an application server crashes, the cache will eventually be consistent with the database. But there’s a catch: **Invalidation Storms**. If a mass-update happens (e.g., a privacy setting change for millions of users), the invalidation pipeline can lag.

If the invalidation is delayed, users see old data. If it's too fast and uncoordinated, it triggers a thundering herd. To fix this, Facebook utilizes **Ordered Delivery and Versioning**.

---

## Strategy 3: Moving to Consensus with Delos

As Facebook moved from a collection of "best-effort" caches to a more integrated Social Graph (TAO), they realized that simple TTLs (Time-to-Live) and leases weren't enough for their control plane and metadata. They needed **strong consistency** for certain operations without the overhead of a traditional Paxos-based database for everything.

The hype around "Distributed Consensus" (Paxos, Raft) often focuses on the "happy path." But at hyperscale, the overhead of consensus is the enemy.

### The Delos Architecture

Facebook developed **Delos**, a platform for building replicated state machines. Unlike traditional systems that bake a specific consensus protocol (like Raft) into the database, Delos uses a **Virtual Log**.

This is a game-changer for mitigating thundering herds at the metadata level. The Virtual Log can switch its underlying implementation (from a simple shared log to a full Paxos implementation) without the upper-layer applications knowing.

**Why does this matter for the Thundering Herd?**
Metadata (the "map" of where data lives) is the ultimate hot key. If the metadata service fails or lags, every single request in the entire infrastructure fails. Delos allows Facebook to maintain a **replicated, highly available log of all cache-routing changes**. By having a consistent, ordered view of the world, cache nodes don't have to "guess" or "race" to update their routing tables. They follow the log.

---

## Strategy 4: Regional vs. Global Consistency (The FlightTracker Approach)

The thundering herd problem is exacerbated by **geo-replication**. Facebook operates data centers globally. If a user in Singapore updates a post, and a user in New York immediately tries to read it, the New York cache might still have the old value.

A common "fix" is to invalidate all caches globally. But global invalidation is the "nuclear option"—it’s expensive and risky.

### FlightTracker: The "Read-Your-Writes" Savior

To prevent the herd while maintaining sanity, Facebook uses a system called **FlightTracker**. It tracks the "recent writes" of a specific user.

1.  When you write data, the ID of the update (the Sequence Number) is stored in FlightTracker.
2.  When you (or your friends) read data, the query includes a "minimum version" requirement.
3.  The cache checks: "Do I have version $X$ or higher?"
4.  If the cache only has version $X-1$, it doesn't just error out. It uses its **internal shard-mapping** to find a replica that _does_ have the update, or it waits a few milliseconds for the invalidation pipeline to catch up.

This **coalesces** the requests. Instead of 1,000 requests hitting the DB because they are impatient for an update, FlightTracker tells the system to "hold on" for the specific version, ensuring that only the necessary amount of "re-fetching" occurs.

---

## The Technical "Deep Magic": Probabilistic Early Recomputation

If you wait for a key to expire (TTL = 0) before fetching it, you are guaranteed to hit a thundering herd if the key is hot. The lease prevents the DB from dying, but the _latency_ for the 9,999 users still spikes.

Facebook engineers use a statistical trick known as **Probabilistic Early Recomputation (PER)**.

Instead of:
`if (current_time > expiry_time) { fetch_from_db(); }`

They use:
`if (current_time + (fetch_duration * -log(random())) > expiry_time) { fetch_from_db(); }`

### Why this is genius:

As the key approaches its expiration time, the probability of a worker thread deciding to "refresh it early" increases.

- 10 seconds before expiry: 1% chance a request will refresh it.
- 1 second before expiry: 50% chance.
- At expiry: 100% chance.

By "staggering" the refresh probability, one lucky request will trigger the cache update **before the key actually dies**. To the rest of the world, the key never expires, and the cache hit rate for that hot key stays at 100%. **The herd is dispersed before it even forms.**

---

## Infrastructure Scale: The Numbers

To appreciate why these strategies are necessary, let’s look at the hardware and traffic metrics involved in Facebook’s cache layer (based on their publicly shared engineering data):

- **Cluster Size:** Thousands of servers per region.
- **Throughput:** Hundreds of millions of requests per second per cluster.
- **Memory:** Petabytes of aggregate RAM in the Memcached/TAO tier.
- **Latency Budget:** A cache hit is expected in **sub-200 microseconds** (p50). A cache miss that goes to a DB (even with a lease) can take **10-100 milliseconds**.

That **500x difference** in latency is why a thundering herd is so dangerous. If 0.1% of your traffic suddenly shifts from the 200us bucket to the 100ms bucket, your application server thread pool will exhaust in less than a second.

---

## Implementing the "In-Flight" Request Buffer

In the most recent iterations of Facebook’s service mesh, the responsibility for mitigating herds has started to shift from the cache itself to the **sidecar proxies**.

When an application sends a request for a key, the proxy (similar to Envoy but heavily customized) checks an internal **"In-Flight Map."**

- **Step A:** Request for `Key_A` comes into the Proxy.
- **Step B:** Proxy checks if there is already an active request for `Key_A` from this same host or container.
- **Step C:** If yes, it "attaches" the new request to the existing one.
- **Step D:** When the first response comes back, the Proxy multicasts the result to all callers.

This happens at the **L7 (Application) layer**. It’s the final fail-safe. If the cache is down and the database is struggling, the service mesh ensures that at least on a per-host basis, we are being as efficient as possible.

---

## Lessons for the Modern Architect

You might not be running a social network with 3 billion users, but the "Thundering Herd" is coming for your Kubernetes cluster the moment you scale. Whether you are using Redis, Cloudflare Workers, or a custom Go cache, the principles Facebook pioneered are your blueprint:

1.  **Don't just expire; Leasify.** Never allow a cache miss to trigger an uncontrolled number of upstream fetches. Use a mutex or a lease.
2.  **Stale is better than slow.** In a distributed system, "perfectly fresh" is the enemy of "available." Use `stale-while-revalidate`.
3.  **Probabilistic Recomputation.** If you have very hot keys, don't wait for them to die. Let a random request "volunteer" to refresh the key early.
4.  **Listen to your logs.** Invalidation should be an event-driven pipeline (like McSqueal), not an afterthought in your API code.

Facebook’s journey from a single PHP server to a global mesh of Delos-backed state machines shows that **caching is not just a "key-value store."** It is a complex, living organism that requires sophisticated consensus and traffic shaping to survive.

The next time you see a celebrity post go viral and the site stays up, remember: there isn't just one "cache" making that happen. There’s a silent army of Lease tokens, McSqueal routers, and probabilistic algorithms holding back the herd.

**Happy Scaling.**
