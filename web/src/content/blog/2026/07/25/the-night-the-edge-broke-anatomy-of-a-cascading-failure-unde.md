---
title: "The Night the Edge Broke: Anatomy of a Cascading Failure Under Fire"
shortTitle: "Anatomy of a Cascading Edge Failure"
date: 2026-07-25
image: "/images/2026/07/25/the-night-the-edge-broke-anatomy-of-a-cascading-failure-unde.svg"
---

03:14 UTC. For most of the world, it was a quiet Tuesday. For our Site Reliability Engineering (SRE) team, it was the moment the "Quiet Hours" dream died. It started with a single, lonely latency spike in our US-East-1 edge POP (Point of Presence). Within twelve minutes, we weren't just looking at a regional hiccup; we were witnessing a global synchronized collapse of our serverless execution tier.

What follows is the raw, unvarnished technical postmortem of how a coordinated, multi-vector cyber attack exploited the very architectural patterns we built for resilience, turning our global scale against us. This isn't just a story about a DDoS; it’s a deep dive into the physics of cascading failures in distributed systems, the "thundering herd" of a billion retries, and the terrifying reality of **metastable failure states.**

## The Architecture: Building for the Infinite

To understand how we fell, you have to understand how we were built. Our platform, **AetherCompute**, is designed to provide sub-50ms execution for serverless functions globally. We operate on a three-tier architecture:

1.  **The Global Anycast Layer:** We use BGP (Border Gateway Protocol) to announce our IP prefixes from 280+ cities. This ensures that a request from Tokyo hits a Tokyo router.
2.  **The Regional Control Plane:** Each region runs a heavy-duty Kubernetes cluster that manages the lifecycle of "Firecracker" microVMs. This layer handles function cold starts, image pulling, and resource allocation.
3.  **The Distributed State Store:** A globally replicated, eventual-consistency Key-Value store based on a modified Raft consensus algorithm that keeps track of function configurations and secrets.

On paper, this is bulletproof. If US-East-1 goes down, BGP withdraws the route, and traffic seamlessly shifts to US-East-2 or US-South. **Or so we thought.**

## The Trigger: A "Query of Death" with a Twist

The attack wasn't a standard volumetric UDP flood. Those are easy; our edge scrubbers eat terabits of junk for breakfast. This was a **highly sophisticated Layer 7 (Application Layer) coordinated assault.**

The attackers identified a specific, computationally expensive metadata endpoint in our public API. They didn't just flood it; they timed their requests to coincide with our internal "garbage collection" cycles for microVM snapshots.

### The Attack Signature:

- **Vector A:** 15 million RPS (Requests Per Second) of legitimate-looking `GET` requests targeting un-cached function metadata.
- **Vector B:** A "Low and Slow" POST attack that held open TCP connections, slowly filling the connection tables of our NGINX ingress controllers.
- **Vector C:** A BGP hijacking attempt on our upstream transit provider, causing intermittent packet loss that triggered aggressive retry logic in our client SDKs.

This created a **Triple-Threat Scenario**: We were being hit from the outside, while our internal systems began to fight each other for resources.

## The First Domino: The Thundering Herd of Cold Starts

When the attack hit, our regional rate limiters did exactly what they were programmed to do: they started dropping excess traffic. However, because the attack was masquerading as legitimate function calls, our **Auto-Scaler** interpreted the surge as a massive spike in user demand.

In a matter of seconds, the system attempted to spin up **4.2 million new microVMs** across six regions.

```yaml
# Our (Flawed) Auto-scaling Logic
target:
    resource: cpu
    averageUtilization: 60
scaleUp:
    stabilizationWindowSeconds: 0 # THE FATAL MISTAKE
    policies:
        - type: Percent
          value: 100
          periodSeconds: 15
```

Because our `stabilizationWindowSeconds` was set to zero for "maximum responsiveness," the orchestrator didn't wait to see if the spike was a transient burst. It went full throttle.

This triggered a **Global Image Pull Storm**. Every worker node in our network simultaneously reached out to our central Container Registry to pull function layers. The registry, despite being backed by a high-performance CDN, hit a "hot partition" on the underlying S3 buckets.

**The result?** Cold starts jumped from 200ms to 45 seconds.

## The Cascading Failure: When "Resilience" Becomes a Weapon

Here is where the engineering gets truly interesting—and horrifying. As US-East-1's worker nodes became saturated with pending image pulls, the latency for the "Health Check" probes from our Load Balancers began to exceed the 5-second timeout.

The Load Balancers marked US-East-1 as `UNHEALTHY` and stopped sending it traffic.

In a traditional setup, this is good. In a global Anycast network, this was the poison pill. The 15 million RPS didn't disappear; they were immediately rerouted by BGP to the next closest regions: US-East-2 and Europe-West-1.

**The "Spillover Effect" began.**

US-East-2 was already at 70% capacity. The sudden 150% increase in traffic caused its control plane to lock up instantly. US-East-2 went `UNHEALTHY`. Then Europe-West-1 followed. We were witnessing a **Global Cascading Failure Wave** moving across the planet at the speed of BGP convergence.

### The Metastable State

We had entered a **Metastable Failure State**. This is a condition where a system remains in a failed state even after the original trigger (the attack) is removed. Our internal retries were now more damaging than the actual DDoS.

Every failed function call triggered an exponential backoff in our client SDKs, but with a million clients, the "backoff" still resulted in a wall of traffic that prevented the control plane from ever recovering.

## Deep Dive: The Death of the Consensus Layer

While the compute tier was struggling, a more insidious failure was happening at the "Brain" level—our Distributed State Store (the Raft-based KV store).

To ensure global consistency, every time a new microVM is spun up, a record is written to the KV store. Under the pressure of 4 million concurrent spin-ups, the **Log Replication** latency between our Raft nodes skyrocketed.

The Heartbeat packets—the "Are you alive?" signals between the leader and follower nodes—got stuck behind a massive queue of "Write" operations.

```go
// Simplified Raft Heartbeat Logic (The Failure Point)
func (r *RaftNode) sendHeartbeat() {
    for _, peer := range r.peers {
        // Under high load, the MsgApp (AppendEntries) queue
        // choked out the MsgHeartbeat.
        if err := r.transport.Send(peer, heartbeatMsg); err != nil {
            r.logger.Errorf("Failed to send heartbeat: %v", err)
        }
    }
}
```

The leader node, failing to receive acknowledgments, stepped down. A new election was triggered. But because the network was saturated, the nodes couldn't agree on a new leader. The KV store entered a **Split-Brain recovery loop**, effectively freezing all configuration changes globally. We couldn't even push a "Kill Switch" to stop the auto-scaling because the kill switch required a write to the KV store.

## The Triage: Manual Intervention in a Dark Room

At 03:45 UTC, we realized we couldn't fix this using our standard tooling. Our dashboards were blank because the telemetry service—which also runs on our serverless platform—had collapsed under the same failure pattern. **We were flying blind.**

The SRE team moved to a "scorched earth" recovery strategy:

1.  **BGP Blackholing:** We coordinated with our Tier-1 providers to drop all traffic to our Anycast range. We effectively took ourselves off the internet to stop the bleeding.
2.  **Control Plane Isolation:** We manually SSH’ed into the regional master nodes (outside of the standard K8s API, which was dead) and killed the `kube-scheduler` process. This stopped the cycle of new microVM attempts.
3.  **The "Flush and Pray":** We cleared the pending Raft logs and forced a leader election by manually isolating a single node and declaring it the source of truth.

## Lessons from the Rubble

This incident forced us to rethink several "Best Practices" that turned out to be "Best Vulnerabilities" at scale.

### 1. The Fallacy of the Global Control Plane

We realized that a single, globally synchronized state store is a massive liability during a coordinated attack. We are moving toward a **Cell-Based Architecture**. Each region will now be entirely autonomous, with zero dependencies on a global leader during the data-plane execution. If the global KV store dies, the regions continue to run with their last-known-good state.

### 2. Adaptive Rate Limiting vs. Static Thresholds

Our rate limiters were too "dumb." They saw traffic volume but not traffic _intent_. We are implementing **Client Reputation Scoring**. Using a combination of mTLS (mutual TLS) and historical request patterns, we can now "Shed Load" for suspicious unauthenticated traffic while preserving the capacity for our enterprise customers.

### 3. Circuit Breakers Must Be "Hard"

Our circuit breakers were "soft"—they would retry after a short timeout. In a cascading failure, a retry is just another attack. We’ve implemented a **"Dead Man's Switch"** in our SDKs. If a client receives three consecutive 503 errors, it enters a "Cool Down" mode for 300 seconds, no questions asked.

### 4. Backpressure is a First-Class Citizen

We failed to implement proper backpressure from the worker nodes up to the Load Balancers. The worker nodes should have signaled "I am busy pulling an image" much earlier. We are now using **Gossip-based Load Balancing** where nodes broadcast their real-time pressure (CPU, Memory, and Disk I/O) to the ingress layer every 100ms.

## The Engineering Hype vs. Reality

There’s a lot of hype around "Serverless" being the end of infrastructure management. The industry narrative suggests that the cloud provider handles the scaling, so you don't have to.

**The reality is that Serverless just moves the bottleneck.**

When you use a platform like ours, you are delegating the "Thundering Herd" problem to us. This incident was a humbling reminder that beneath the clean abstractions of `cloud_function.deploy()`, there is a brutal world of Linux namespaces, BGP convergence times, and the immutable laws of distributed consensus.

## Moving Forward: The "Aether-2" Initiative

In the wake of this, we are open-sourcing our new **Resilience Middleware**, a library designed to detect "Attack-Induced Congestion" before it hits the orchestrator. We’re also redesigning our cold-start logic to use a "P2P Image Distribution" model (think BitTorrent for container layers) so that our central registry never becomes a single point of failure again.

The attack was a nightmare, but the data we gathered is a goldmine. We saw exactly where the joints of the internet creak under the weight of 15 million concurrent malicious actors. We are rebuilding not just to be faster, but to be **stubbornly available.**

Modern infrastructure isn't about preventing failure—that’s impossible at our scale. It’s about **graceful degradation**. It's about making sure that when the edge breaks, it breaks into manageable pieces, rather than a global shatter.

---

**Technical Specs for the Curious:**

- **Peak Attack Volume:** 1.2 Tbps / 15M RPS
- **Total MicroVMs attempted:** 4,204,112
- **Raft Log Size at Peak:** 18GB (Uncompressed)
- **Time to Full Recovery:** 4 hours, 22 minutes
- **Architecture Change:** Moving to a decentralized, cell-based KV store using `dqlite`.

**Are you building distributed systems that need to survive the impossible? Let's talk in the comments about how you handle regional spillover and backpressure.**
