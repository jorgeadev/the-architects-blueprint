---
title: "The 100Tbps Handshake: Why We Ditched LRU for ML-Driven Cache Admission at the Edge"
shortTitle: "100Tbps Edge Caching: Replacing LRU with ML-Driven Admission"
date: 2026-09-12
image: "/images/2026/09/12/the-100tbps-handshake-why-we-ditched-lru-for-ml-driven-cache.svg"
---

Imagine a river. Not a gentle stream, but a Category 5 hydraulic surge—100 Terabits of data per second flowing across a global network of PoPs (Points of Presence). In this environment, every millisecond of latency is a mile of distance, and every unnecessary disk write is a ticking time bomb for hardware longevity.

For decades, the industry standard for managing this flow has been **LRU (Least Recently Used)**. It’s elegant, it’s simple, and at 100Tbps, it is fundamentally broken.

Over the last eighteen months, we embarked on a radical re-engineering of our global edge tier. We didn't just tweak our eviction settings; we fundamentally moved the "intelligence" of the cache from the back door (eviction) to the front door (**admission**). By replacing heuristic-based caching with **Machine Learning-Driven Admission Policies**, we’ve seen a 12% increase in Cache Hit Ratio (CHR), a 40% reduction in SSD write amplification, and a significant drop in p99 tail latency.

Here is how we did it.

---

### The Architecture of Failure: Why LRU Can’t Keep Up

To understand why we moved away from LRU, we have to look at the anatomy of a modern cache miss. In a traditional LRU setup, the logic is "Admission by Default." When a request comes in for an object not in the cache, the edge node fetches it from the origin, serves it to the user, and immediately writes it to the local cache. If the cache is full, the "oldest" (least recently used) object is kicked out to make room.

This worked brilliantly when web traffic followed a predictable Pareto distribution (the 80/20 rule). But the modern web is a different beast. We are dealing with:

1.  **The "One-Hit Wonder" Problem:** Statistically, up to 60% of objects requested at the edge are requested exactly once. In an LRU system, you waste precious SSD IOPS writing an object that will never be requested again, only to evict a "hot" object that was actually useful.
2.  **Scan Pollution:** When a search engine crawler or a malicious bot scrapes millions of unique, low-value assets, it effectively "flushes" your cache, replacing high-value video chunks or API responses with garbage data.
3.  **Write Amplification Factor (WAF):** At 100Tbps, the sheer volume of writes required to maintain an LRU cache can burn through enterprise-grade NVMe drives in months.

We realized that the problem wasn't how we were _evicting_ data; it was that we were _admitting_ too much junk. We needed a bouncer at the door, not just a janitor at the back.

---

### The Paradigm Shift: Admission vs. Eviction

The core philosophy of our new architecture is **Probabilistic Admission**. Instead of asking, "What should we throw away?" our servers now ask, **"Is this object worth the cost of storing?"**

This is where the ML comes in. At the edge, we have roughly 10-15 microseconds to make an admission decision before we incur a latency penalty that offsets the benefit of caching. You can't run a 175-billion parameter LLM in that window. You need something lean, mean, and hyper-optimized for the data plane.

#### The Feature Set

Our model doesn't care about the _content_ of the file (it doesn't look at pixels or text). It looks at the **metadata context**. We feed our model a vector consisting of:

- **Request Frequency (via Count-Min Sketch):** How many times have we seen this specific Hash ID in the last $N$ seconds?
- **Content-Type & Size:** Is this a 2KB JSON fragment or a 5MB binary chunk?
- **Origin Health:** What is the current latency of the upstream origin? (If the origin is fast, the "value" of caching is lower).
- **TTL (Time to Live):** How long is the object valid for?
- **Geographic Popularity:** Is this object trending in this specific PoP or globally?

---

### Engineering the "Bouncer": The ML Stack at the Edge

We couldn't afford the overhead of a Python-based inference engine. Every microsecond counts. Our production stack involves a hybrid approach where training happens out-of-band, and inference happens in the fast path.

#### 1. The Lightweight Model: Logistic Regression & Decision Trees

We settled on a combination of **Logistic Regression** and highly compressed **Gradient Boosted Decision Trees (GBDTs)**. These models are mathematically simple enough to be represented as a series of if-else statements or a single matrix multiplication in C++.

#### 2. The Feedback Loop: Shadow Caching

How do you train a model to know what _should_ have been cached? We implemented **Shadow Caching**. For every request, the ML model makes a "virtual" decision. Even if we don't cache the object, we record its metadata in a compact Bloom filter. If that object is requested again shortly after, the model receives a "Positive" signal (it would have been a cache hit). If it’s never seen again, it’s a "Negative" signal.

#### 3. Integration with eBPF and XDP

To handle the telemetry required for these models at 100Tbps, we leverage **eBPF (Extended Berkeley Packet Filter)**. We hook into the socket layer to extract request features without context-switching to user-space. This allows us to maintain a "Global Feature Map" in shared memory that the caching daemon can read with near-zero latency.

```cpp
// Simplified pseudo-code of the Admission Logic in the Caching Engine
bool should_cache(RequestMeta meta) {
    // 1. Check if it's an administrative override
    if (meta.priority == HIGH) return true;

    // 2. Extract features for the ML Model
    float freq = frequency_sketch.estimate(meta.hash);
    float size_score = normalize_size(meta.content_length);
    float origin_score = origin_health_map.get(meta.origin_id);

    // 3. Inference: Simple Logistic Regression
    // weights are updated every 10 minutes from the central training service
    float logit = (freq * W_FREQ) + (size_score * W_SIZE) + (origin_score * W_ORIGIN) + BIAS;
    float probability = 1.0 / (1.0 + exp(-logit));

    // 4. Probabilistic Decision
    return (drand48() < probability);
}
```

---

### The Infrastructure Challenge: Scaling to 100Tbps

Scaling this logic across thousands of nodes requires a sophisticated control plane. We treat our global network as a single distributed organism.

#### Distributed Feature Aggregation

A video chunk might be "cold" in a London PoP but "exploding" in New York. If we only used local data, the London PoP would reject the chunk several times before finally admitting it. We solve this using a **Global Frequency Sketch**. Using a low-bandwidth gossip protocol, PoPs exchange high-level summaries of "trending" Hash IDs. This allows a node in Paris to "pre-warm" its admission model based on traffic patterns seen in Tokyo.

#### Tackling the "Flash Crowd"

In a breaking news event, traffic can spike from 1Gbps to 100Gbps in seconds. Traditional ML models often struggle with non-stationary data (data where the underlying distribution changes rapidly).

To handle this, we implemented an **"Emergency Heuristic Switch."** If the derivative of the request rate exceeds a certain threshold, the system partially bypasses the ML admission policy and moves into a "Aggressive Admission" mode to ensure that the origin isn't crushed by the sudden load. Once the traffic stabilizes, the ML model (which has now been fed the new data) takes over again.

---

### Hardware Longevity: Saving the SSDs

One of the most unexpected wins of this transition was the impact on our physical infrastructure. In the LRU era, our **Write Amplification Factor (WAF)** was a constant headache.

In a standard SSD, writing 1GB of data often results in several GBs of internal NAND writes due to garbage collection and wear leveling. When you cache "one-hit wonders," you are effectively killing your drives for zero gain.

By moving to ML-driven admission, we reduced our daily write volume by **40%**.

- **Old LRU Model:** 150TB written per node/day.
- **New ML Model:** 90TB written per node/day.

This doesn't just save money on hardware; it increases the "IOPS Budget" available for reading data. Because the drive is doing less background maintenance (garbage collection), read latencies are more consistent, leading to a much smoother "Fast Path" for the end user.

---

### The "Hype" vs. Reality: Why Not "AI" Everything?

It's tempting to throw a Transformer at every engineering problem these days. We've seen startups claiming to use "Generative AI for Packet Routing." In our experience, that is often architectural overkill.

At 100Tbps, the "AI" isn't the star—the **Systems Engineering** is. The real challenge wasn't picking the model (Logistic Regression is decades old); it was building the **data pipeline** that could feed that model at line rate without dropping packets.

We saw several "Hype-driven" approaches fail during the R&D phase:

1.  **Reinforcement Learning (RL):** While great in theory for cache optimization, the "Reward" signal (a cache hit) is too delayed and noisy for real-time edge updates.
2.  **Centralized Inference:** Trying to send request metadata to a central "Brain" PoP resulted in a 50ms latency penalty—completely defeating the purpose of a cache.

The winning strategy was **Decentralized Inference with Centralized Training**. We train the models on massive GPU clusters using historical logs, then push the optimized weight matrices to the edge every few minutes.

---

### Real-World Impact: The Numbers

After rolling this out globally, the results were staggering.

- **Cache Hit Ratio (CHR):** We saw a global average increase of **12%**. In certain regions with high "Long Tail" traffic (like Southeast Asia), the improvement was as high as **18%**.
- **Origin Bandwidth Savings:** That 12% CHR improvement translates to hundreds of gigabits per second that we _don't_ have to fetch from customer origins, significantly lowering their cloud egress bills.
- **CPU Overhead:** Surprisingly, the CPU usage for the ML inference was lower than the CPU usage previously spent on managing complex LRU doubly-linked lists and hash maps at high concurrency.

| Metric                  | Legacy LRU | ML-Driven Admission | Change |
| :---------------------- | :--------- | :------------------ | :----- |
| **Global CHR**          | 72%        | 84%                 | +12%   |
| **P99 Latency**         | 45ms       | 32ms                | -28%   |
| **SSD Life Expectancy** | 2.1 Years  | 3.8 Years           | +80%   |
| **Origin Traffic**      | 28Tbps     | 16Tbps              | -42%   |

---

### The Road Ahead: Predictive Pre-fetching

Moving from LRU to ML Admission was just Phase 1. Now that we have an intelligent bouncer at the door, our next goal is **Predictive Pre-fetching**.

If our models can predict with 90% certainty that an object _will_ be requested in the next 500ms, we can pull it from the origin before the user even asks for it. This moves us from "Reactive Caching" to "Proactive Content Distribution."

Re-engineering a 100Tbps system is like changing the tires on a race car while it's going 200mph. It requires a deep respect for the fundamentals of networking, a skeptical eye toward hype, and a willingness to question "industry standards" like LRU.

The edge is no longer just a place to store files; it's a place to make decisions. And at 100Tbps, those decisions need to be very, very smart.
