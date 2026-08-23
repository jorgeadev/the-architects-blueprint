---
title: "The 100 Terabit Threshold: Rebuilding the Nerve System of the Global Internet"
shortTitle: "100 Terabit Threshold: Rebuilding the Internet's Nerve System"
date: 2026-08-23
image: "/images/2026/08/23/the-100-terabit-threshold-rebuilding-the-nerve-system-of-the.svg"
---

Imagine a tidal wave. Not a physical one, but a digital one—a surge of packets so massive it could drown the entire internet traffic of a medium-sized country in a single second. At Cloudflare, this isn't a hypothetical disaster scenario; it’s Tuesday.

In the last year, we’ve seen the ceiling of Distributed Denial of Service (DDoS) attacks shatter. We are no longer living in the era of Megabits or even Gigabits. We have entered the era of **Terabit-scale warfare**. When an attack peaks at 100 Tbps across a global network, the traditional ways of managing traffic—static configurations, manual BGP overrides, and slow-converging routing protocols—don't just fail; they evaporate.

To survive and thrive at this scale, we had to rethink the very foundation of how Cloudflare talks to the rest of the internet. We had to rebuild our **Anycast Control Plane**.

This is the story of how we moved from a legacy, human-in-the-loop routing architecture to a high-frequency, automated, and software-defined system capable of steering 100 Tbps of malicious traffic into the void without breaking a sweat.

---

## The Anycast Dilemma: Why Traditional Routing Fails at Scale

Before we dive into the "how," we need to understand the "why." Cloudflare is built on **Anycast**.

In a standard Unicast world, one IP address lives in one place. In the Anycast world, the same IP address is advertised from hundreds of data centers simultaneously. When you type `cloudflare.com` into your browser, BGP (Border Gateway Protocol) ensures your packets take the shortest path to the nearest Cloudflare PoP (Point of Presence).

Anycast is our superpower. It naturally distributes the load of an attack across our entire global surface area. If a 10 Tbps attack is spread across 300 cities, each city only has to deal with a fraction of the noise.

**But there’s a catch.**

BGP was designed in the 1980s. It was built for stability, not for the rapid-fire agility required to mitigate a volumetric DDoS attack. Traditional BGP propagation—the time it takes for a routing change to "settle" across the global internet—can take anywhere from seconds to several minutes.

When you’re under a 100 Tbps assault, a 60-second delay is an eternity. If one of our data centers becomes overwhelmed because an ISP is funneling too much traffic into it, we need to "withdraw" our routes from that specific location **instantly**. If the control plane is slow, the PoP goes dark, and the "blast radius" of the attack expands.

### The Bottlenecks of the Legacy Control Plane

Our old architecture relied on a combination of:

1.  **ExaBGP/Bird:** Standard open-source daemons to handle BGP sessions.
2.  **Centralized Configuration:** A heavy, global configuration file that was pushed out to every edge node.
3.  **Human Intervention:** SREs (Site Reliability Engineers) monitoring dashboards and manually tweaking "weights" to shift traffic during massive spikes.

At 100 Tbps, this "manual-heavy" approach hits a wall. The sheer volume of telemetry coming off the edge nodes overwhelms centralized databases, and the human brain cannot process the optimal routing path for 300+ locations simultaneously in real-time. We needed to move the brain to the edge.

---

## The New Architecture: Intent-Based Routing and the "Precision Strike"

The rebuild focused on three core engineering pillars: **Propagation Velocity, Edge Autonomy, and Programmable Data Planes.**

### 1. Moving from Configs to "State Streams"

The biggest architectural shift was moving away from "configuration pushes." In the old world, if we wanted to change how we announced a prefix in London, we had to update a central database, which then generated a new configuration, which was then pushed via a deployment pipeline.

In the new system, we treat routing as a **replicated state machine**.

We built a custom control plane (internal code-name: _Quicksilver_) that utilizes a high-frequency pub/sub model. Instead of a 50MB config file, each edge node subscribes to a stream of "Routing Intents."

An intent looks something like this (conceptualized):

```json
{
    "prefix": "1.1.1.0/24",
    "action": "WITHDRAW",
    "location": "LHR",
    "reason": "Congestion_Level_High",
    "priority": 1,
    "timestamp": "2023-10-27T14:00:01.004Z"
}
```

Because these are tiny, discrete messages transmitted over a dedicated gRPC backbone, we can propagate a routing change to every single one of our thousands of routers worldwide in **under 200 milliseconds**.

### 2. The Rise of the "Local Governor"

To handle 100 Tbps, we couldn't wait for a central controller to tell us a PoP was failing. We introduced a component we call the **Local Governor**.

Each Cloudflare data center now runs a localized health-checking engine that monitors the health of its upstream transit providers and its own internal capacity. If the Governor detects that the incoming traffic (say, a massive SYN flood) is approaching 80% of the available NIC (Network Interface Card) capacity, it doesn't ask for permission. It acts.

The Governor can trigger a "Partial Withdrawal." It communicates with the local BGP speaker to stop advertising specific, non-critical prefixes to the most congested upstream provider, effectively "bleeding off" traffic to neighboring PoPs that have more headroom.

### 3. Programmable Data Plane: eBPF and XDP at the Core

Routing is useless if the CPU is too busy processing garbage packets to actually send the BGP updates. This is where the data plane rebuild comes in.

To support 100 Tbps mitigation, we moved our primary defense layer into the kernel using **eBPF (Extended Berkeley Packet Filter) and XDP (eXpress Data Path)**.

When a massive attack hits, our control plane doesn't just change BGP routes; it pushes L4 (Layer 4) drop rules directly into the XDP hook of the network card. This allows us to drop malicious packets immediately after they leave the wire, before they even touch the Linux networking stack.

Here is a simplified look at how an eBPF snippet handles high-speed dropping of DDoS traffic:

```c
SEC("xdp_drop_mitigation")
int xdp_drop_func(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;
    struct ethhdr *eth = data;

    // Boundary check for the packet
    if (data + sizeof(struct ethhdr) > data_end)
        return XDP_ABORTED;

    struct iphdr *iph = data + sizeof(struct ethhdr);
    if ((void *)iph + sizeof(struct iphdr) > data_end)
        return XDP_ABORTED;

    // Check against our dynamic "Attack Fingerprint" map
    __u32 *drop_flag = bpf_map_lookup_elem(&attack_fingerprints, &iph->saddr);

    if (drop_flag && *drop_flag == 1) {
        // Drop the packet at the NIC level - zero CPU overhead for the stack
        return XDP_DROP;
    }

    return XDP_PASS;
}
```

By integrating our Anycast Control Plane directly with these eBPF maps, we can shift traffic (BGP) and block traffic (XDP) in one unified motion.

---

## The Engineering Challenge: Solving the "Flapping" Problem

One of the biggest risks of an automated, high-speed control plane is **Route Flapping**.

Imagine a scenario where a PoP gets hit by a burst of traffic. The Local Governor sees the spike and withdraws the route. The traffic moves to a different PoP. The first PoP is now healthy again, so the Governor re-announces the route. The traffic immediately slams back into the first PoP.

Repeat this every 5 seconds, and you’ve created a "Routing Oscilloscope" that can destabilize the global BGP table.

### The Solution: Dampening Algorithms and Hysteresis

We implemented a sophisticated dampening logic inspired by the TCP congestion control algorithms (like BBR). Instead of a binary "On/Off" switch, our control plane uses **probabilistic route advertisement**.

When a PoP recovers from an attack, we don't immediately announce all prefixes back to the world. We use a **Linear Ramp-up Strategy**. We might announce only 10% of our IP space, monitor the "pressure" (the traffic load), and gradually increase the advertisement over a period of several minutes.

If the "pressure" increases too quickly, the ramp-up stalls. This ensures that the global Anycast state remains stable even when the underlying traffic is chaotic.

---

## Compute Scale: What it Takes to Process 100 Tbps

You might be wondering about the sheer hardware requirements. Handling 100 Tbps isn't just about smart software; it’s about having the "pipes" and the "brains" to handle the load.

Each of our newer "Gen 11" and "Gen 12" servers is equipped with dual 100G or 200G network interfaces. But the real secret is how we distribute the processing.

- **The Unicast Path:** Every packet enters the PoP and is instantly hashed to a specific CPU core using **RSS (Receive Side Scaling)**.
- **Zero-Copy Networking:** We use a custom version of the Linux kernel that minimizes memory copying. Packets move from the NIC to the eBPF program without ever being copied into user-space memory, saving precious clock cycles.
- **The Global Backbone:** Cloudflare operates its own private fiber backbone. When our Anycast Control Plane decides that Tokyo is too full, it doesn't just rely on the public internet to move that traffic. It uses our private backbone to "tunnel" excess requests to a PoP with idle capacity, bypassing the congested public BGP paths entirely.

---

## Narrating the Hype: Is 100 Tbps Even Real?

In recent months, there has been significant buzz in the cybersecurity world about "Record-breaking DDoS attacks." Some skeptics wonder if these numbers are inflated or if they actually matter.

The hype is real, but the _nature_ of the attacks has changed. We aren't just seeing "dumb" UDP floods anymore. We are seeing **HTTP/2 Rapid Reset** attacks and highly distributed IoT botnets (like Mirai descendants) that generate millions of requests per second (RPS) alongside terabits of raw volume.

The reason 100 Tbps is the new benchmark is because of the **democratization of botnets**. Cloud providers with weak egress filtering and compromised "smart" home devices have made it trivial for bad actors to rent a 10+ Tbps "stressor" service for a few hundred dollars.

Our rebuild wasn't just a response to a single event; it was a preemptive strike against the realization that **the "worst-case scenario" of 2022 is the "average-case scenario" of 2025.**

---

## Real-World Impact: The "Invisible" Mitigation

The ultimate metric of success for this new Anycast Control Plane is **invisibility**.

When we successfully mitigated a massive, multi-terabit attack last month, the most interesting thing was the lack of alerts in our internal Slack channels. In the past, a 10+ Tbps attack would trigger "All Hands" calls and frantic manual routing adjustments.

With the new system:

1.  **T+0s:** A massive botnet begins hitting our IPs in Southeast Asia.
2.  **T+100ms:** The Local Governors in Singapore and Hong Kong detect the surge. They automatically update their local XDP maps to drop known attack signatures.
3.  **T+500ms:** The "Quicksilver" control plane detects that the remaining "clean" traffic is still too heavy for the local transit pipes. It issues an automated "Intent" to withdraw specific prefixes from those cities.
4.  **T+1s:** The BGP updates propagate globally. Traffic is seamlessly redistributed to PoPs in Tokyo, Taipei, and Los Angeles.
5.  **T+2s:** The end-user in Singapore, who is just trying to check their email, experiences zero latency increase because the system balanced the load before the routers could saturate.

The engineer on call only finds out about it when they check the daily summary report. **That is the power of a software-defined control plane.**

---

## The Road Ahead: Machine Learning at the Edge?

We aren't finished. The next evolution of our Anycast Control Plane involves moving from "Reactive" to "Predictive."

We are currently experimenting with lightweight machine learning models that run directly on the edge nodes. These models analyze traffic patterns to predict an attack _before_ it hits its peak. By identifying the "pre-shock" of a botnet spinning up, we can begin shifting Anycast weights seconds before the tidal wave arrives.

Building for 100 Tbps taught us a fundamental lesson: **In the world of hyper-scale networking, speed is safety.** By replacing human-scale processes with machine-speed intent, we’ve ensured that Cloudflare stays standing, no matter how much digital water the internet throws at us.

### Key Takeaways for Infrastructure Engineers

- **Decentralize Decision Making:** Don't wait for a central API to tell your edge what to do. Give your edge nodes the autonomy to protect themselves.
- **Invest in eBPF/XDP:** If you are handling more than 10Gbps per server, the standard Linux networking stack is your bottleneck. Move your logic into the kernel.
- **Intent-Based State, Not Configs:** Treat your network as a live, streaming state machine. Static configurations are the enemy of agility.
- **Dampen Everything:** Automation is fast, which means it can fail fast. Always build in hysteresis and "sanity checks" to prevent global routing oscillations.

The internet is getting louder, faster, and more dangerous. Our job is to make sure that for the rest of the world, it remains as quiet and reliable as a dial tone. Rebuilding our Anycast Control Plane is just one more step in that mission.

**Onward to 200 Tbps.**
