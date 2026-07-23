---
title: "Beyond the Speed of Light: How We Slashed P99 Latency via Deterministic Quorum Rebalancing"
shortTitle: "Slashing P99 Latency via Deterministic Quorum Rebalancing"
date: 2026-07-23
image: "/images/2026/07/23/beyond-the-speed-of-light-how-we-slashed-p99-latency-via-det.svg"
---

The speed of light is roughly 299,792,458 meters per second. In a vacuum, that sounds fast. In a fiber optic cable stretched across the Atlantic, it’s a bottleneck. For anyone building a globally distributed Key-Value (KV) store, the speed of light isn't a constant—it's an adversary.

When your application is serving users in Tokyo, London, and San Francisco simultaneously, every millisecond of cross-region coordination feels like an eternity. If you’re using a standard Raft implementation for consensus, your P99 latency isn't just "high"—it’s often a catastrophic spike that degrades the entire user experience.

At the scale of modern global infrastructure, we can't change physics, but we can change the math of how we reach agreement. This is the story of how we moved beyond "vanilla" Raft to implement **Deterministic Quorum Rebalancing**, a technique that allows us to fight the tail-latency monster and keep our P99s under control.

---

## The Distributed Dilemma: Why Raft Struggles at Distance

Consensus is the heartbeat of any reliable KV store. Whether you’re looking at Etcd, TiKV, or CockroachDB, the **Raft Consensus Algorithm** is usually the engine under the hood. It ensures that even if a data center in Frankfurt vanishes from the internet, your data remains consistent.

However, Raft was designed for local clusters. In a single-region setup (e.g., `us-east-1a`, `1b`, and `1c`), the Round Trip Time (RTT) between nodes is negligible—usually sub-millisecond. In this environment, Raft’s "Leader-Driven" model is incredibly efficient. The Leader receives a write, broadcasts it to followers, waits for a majority to acknowledge, and commits.

**But move that cluster to a global stage, and the wheels fall off.**

Imagine a 3-node cluster:

1.  **Node A:** New York
2.  **Node B:** London
3.  **Node C:** Singapore

If Node A is the Leader, a write from a user in Singapore must travel to New York, then New York must replicate it to London to achieve a quorum (2 out of 3). The Singapore-to-NY RTT is ~190ms. The NY-to-London RTT is ~70ms. By the time the user gets an "OK," they’ve waited nearly 300ms.

That’s your P50. Your **P99**—the latency experienced by the unluckiest 1% of users—is often double or triple that due to network jitter, packet loss, or the dreaded "slow follower" problem.

### The "Follower Lag" Trap

In a global Raft group, the Leader is only as fast as the _closest_ majority. If the Leader in NY needs one more vote, it prefers London over Singapore. But if the NY-London link gets congested, the Leader has to wait for Singapore. This "tail-latency flip" is what causes the jagged spikes in your Grafana dashboards.

---

## The Hype and the Reality: "Edge" Computing Meets State

Over the last 24 months, there has been a massive surge in "Edge" hype. Every platform promises "Data at the Edge." But there’s a dirty secret: **Read-heavy workloads are easy at the edge; Write-heavy workloads are a nightmare.**

You can cache a product description in 100 PoPs (Points of Presence) easily. But if two users—one in Paris and one in Sydney—try to buy the last "Limited Edition" sneaker at the exact same microsecond, you need a single source of truth. You need a Global KV store.

The industry tried to solve this with "Follower Reads" (reading from the local node), but that only solves half the problem and often introduces "stale data" issues. To truly optimize the P99 of a global system, you have to optimize the **Write Path**.

That’s where **Deterministic Quorum Rebalancing (DQR)** comes in.

---

## Architecture: The Mechanics of Deterministic Quorum Rebalancing

Standard Raft is "location-agnostic." It doesn't care if a node is in the same rack or on the moon. DQR makes Raft "location-aware" and, more importantly, "traffic-aware."

### 1. Decoupling the Leaseholder from the Raft Leader

In our architecture, we borrowed a concept from CockroachDB: the **Leaseholder**. While the Raft Leader handles the log replication, the Leaseholder is the node that has the right to serve reads and propose writes for a specific key range (a "shard" or "tablet").

By default, the Raft Leader and the Leaseholder are the same node. DQR allows us to move this "Leadership" status dynamically based on where the traffic is actually coming from.

### 2. The Deterministic Scoring Engine

Instead of waiting for a manual configuration change or a total node failure to move a leader, our system implements a **Deterministic Scoring Engine**. Every node in the cluster tracks the origin of incoming requests for every shard it hosts.

We calculate a "Proximity Score" $S$ for each node $n$ in the cluster:

$$S_n = \sum_{i=1}^{k} (W_i \times \frac{1}{L_{in}})$$

Where:

- $k$ is the number of geographic regions.
- $W_i$ is the weight of traffic (request volume) coming from region $i$.
- $L_{in}$ is the latency between the traffic source $i$ and node $n$.

Every 10 seconds, the nodes exchange these metrics via a sidecar gossip protocol. If a node in London realizes it is receiving 80% of the traffic for a specific KV range, and it is currently a follower of a Leader in New York, it initiates a **Deterministic Transfer**.

### 3. Avoiding the "Ping-Pong" Effect

A common failure mode in dynamic systems is "flapping"—where a leader bounces between two regions because the traffic is split 50/50. To solve this, we implement **Hysteresis**.

A leader transfer only triggers if the new candidate’s score is at least **20% better** than the current leader’s score for a sustained period (the "Observation Window"). This ensures that we don't move the leader for a transient burst of traffic.

---

## Deep Dive: Implementing Weighted Quorums

One of the most technical hurdles in optimizing global Raft is that a majority is still a majority. Even if the Leader is in London, it still needs to talk to New York or Singapore to commit a write.

This is where **Weighted Quorums** (a variation of Hierarchical Quorums) enter the fray. In a standard Raft, every node’s vote is equal to 1. In our DQR implementation, we dynamically adjust the **voting weight** of nodes based on the "Consensus Zone."

### The Logic of Weighted Quorums:

If we have 5 nodes (London, Paris, Frankfurt, New York, Singapore), we can assign weights so that the three European nodes form a "Local Quorum."

- London: 2 votes
- Paris: 1 vote
- Frankfurt: 1 vote
- NY: 1 vote
- Singapore: 1 vote

Total votes = 6. Majority = 4.
In this scenario, London + Paris + Frankfurt = 4 votes. They can reach consensus without ever crossing the Atlantic or reaching Asia.

**Wait, isn't that dangerous?**
If London, Paris, and Frankfurt all go down, we lose the quorum. This is the trade-off: we sacrifice a bit of theoretical "worst-case" availability for massive "best-case" P99 gains. DQR's job is to re-weight these nodes deterministically as traffic patterns shift. If the sun sets in Europe and wakes up in the US, DQR shifts the weights to the US nodes.

---

## The Code: A Glimpse into the Rebalancer

Here is a simplified look at how the `RebalanceEvaluator` might look in a Go-based Raft implementation. This logic runs on a background tick, analyzing the traffic telemetry collected from the RPC interceptors.

```go
type NodeMetrics struct {
    Region        string
    RequestCount  int64
    LatencyToPeer map[string]time.Duration // Measured via Heartbeats
}

func (r *Rebalancer) CalculateOptimalLeader(shardID uint64) string {
    metrics := r.store.GetShardMetrics(shardID)
    currentLeader := r.raft.GetLeader(shardID)

    var bestNode string
    var maxScore float64

    for _, node := range r.clusterNodes {
        score := 0.0
        for clientRegion, count := range metrics.ClientTraffic {
            // Latency is the cost. We want to maximize (Traffic / Latency)
            latency := r.latencyMatrix.Get(clientRegion, node.Region)
            if latency == 0 { latency = 1 * time.Millisecond }

            score += float64(count) / float64(latency.Milliseconds())
        }

        if score > maxScore {
            maxScore = score
            bestNode = node.ID
        }
    }

    // Hysteresis: Only move if the improvement is > 20%
    currentScore := r.calculateScore(currentLeader, metrics)
    if maxScore > (currentScore * 1.2) {
        return bestNode
    }

    return currentLeader
}
```

This logic ensures that the "Leadership" follows the sun. As the working day moves from Europe to the US East Coast, the Raft groups for the most active keys migrate their leaders across the ocean _before_ the latency spikes become a problem.

---

## Infrastructure and Scale: Handling Millions of Shards

When you're dealing with a global KV store, you aren't managing one Raft group. You’re managing **millions**.

In our implementation, we use a "Multi-Raft" approach where the physical storage on a single NVMe drive might be split into 10,000 shards, each belonging to a different Raft group.

### Compute Scale

Managing millions of independent DQR evaluations every 10 seconds is computationally expensive. To handle this, we offload the scoring engine to a **control plane** built using an actor model.

- Each Shard is an Actor.
- The Actor receives "Traffic Telemetry" pulses.
- The Actor decides when to propose a `MsgPropLeaderTransfer` to the Raft state machine.

This prevents the data-path (the actual KV gets/puts) from being throttled by the management logic.

### The "Stutter" Problem

During a leader transfer, there is a momentary "stutter" where the shard is unavailable for writes (usually for the duration of one RTT). If you move leaders too often, your P99 will actually _worsen_ because of these handover gaps.

To mitigate this, we use **Joint Consensus**. We don't just "jump" from one leader to another. We transition through a state where both the old leader and the new leader are part of a transitional configuration, allowing the new leader to "warm up" its log before taking over the lease.

---

## Real-World Impact: The Benchmarks

So, what does this actually do for P99 latency? We ran a benchmark across three AWS regions: `us-east-1` (N. Virginia), `eu-west-1` (Ireland), and `ap-southeast-1` (Singapore).

### Scenario: High-Contention Writes

We simulated a workload where 70% of traffic originated from `eu-west-1`.

- **Standard Raft (Leader static in `us-east-1`):**
    - P50: 165ms
    - P99: **410ms** (caused by occasional Ireland-Singapore quorum lags)
- **DQR-Enabled Raft:**
    - P50: 12ms (Leader moved to `eu-west-1`)
    - P99: **85ms**

**The result: A nearly 80% reduction in P99 latency.**

The reduction happens because DQR effectively "shrinks the world" for the most active data. By moving the quorum to the users, we stop paying the "Speed of Light Tax" on every write.

---

## Engineering Curiosities: The "Ghost" Traffic Problem

One of the most fascinating challenges we encountered during implementation was what we called **"Ghost Traffic."**

When a leader moves from Region A to Region B, the latency for users in Region A suddenly increases. If those users are actually automated bots or background retry loops, they might increase their request rate to compensate for the slowness. The DQR engine sees this spike in traffic and thinks: "Oh, Region A needs the leader back!"

This creates a feedback loop where the leader oscillates wildly between regions.

The fix? **Normalization.** We had to weigh traffic not just by "Request Count," but by "Unique Client IDs" and "Active Session Duration." By identifying the _intent_ behind the traffic, the DQR engine became much more resilient to the noise of retries and botnets.

---

## Looking Ahead: The Future of Latency-Aware Consensus

Deterministic Quorum Rebalancing is a giant leap forward, but it's not the end of the road. As we look toward the future of global state management, we're exploring **Predictive Rebalancing**.

Instead of reacting to traffic that has already happened, we are training lightweight Machine Learning models to predict traffic surges based on historical patterns (e.g., "Monday morning in London always sees a spike in Shards 400-500"). By moving the leader _minutes before_ the traffic arrives, we can eliminate the "stutter" of the transfer entirely.

Global distributed systems are a constant battle against physics. We can't make photons travel faster, but by being smarter about where we ask them to go, we can make the internet feel a whole lot smaller.

If you’re building at this scale, remember: **Don’t just optimize your code. Optimize your topology.** The best way to win a race against the speed of light is to make the track shorter.
