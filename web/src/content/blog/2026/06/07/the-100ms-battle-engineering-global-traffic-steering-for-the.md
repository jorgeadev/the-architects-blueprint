---
title: "The 100ms Battle: Engineering Global Traffic Steering for the Billion-User Scale"
shortTitle: "Engineering Global Traffic Steering at Billion-User Scale"
date: 2026-06-07
image: "/images/2026/06/07/the-100ms-battle-engineering-global-traffic-steering-for-the.jpg"
---

Imagine it’s 3:00 PM UTC. Your marketing team just dropped a viral campaign, or perhaps a global event—like the World Cup or a massive product launch—just triggered a stampede of traffic. In the span of sixty seconds, your ingress traffic spikes from 100,000 requests per second (RPS) to 15 million.

If your infrastructure is centered in a single AWS region or tied to a traditional, static load balancer, your services are already dead. You just don't know it yet.

At the scale of billions of requests, "availability" isn't a checkbox; it's a multi-dimensional chess game played against physics, the Border Gateway Protocol (BGP), and the inherent chaos of the public internet. To survive, we have to move away from the "centralized fortress" model and toward a "distributed mesh" that lives everywhere and nowhere at once.

This is the story of how we evolve from basic DNS-based steering to the wizardry of Anycast architectures and XDP-powered packet processing.

---

## The Physics of the "Wait": Why Distance is the Enemy

Before we talk about routers and code, we have to talk about light. In a vacuum, light travels at roughly 300,000 km/s. In fiber optic cable, due to the refractive index of glass, it's closer to 200,000 km/s.

A round-trip from London to Sydney is roughly 34,000 km. Even in a perfect world with no router hops, that’s a **170ms theoretical minimum latency**. In the real world, with BGP handoffs and congestion, you’re looking at 300ms+. For a modern web application requiring multiple TLS handshakes and API calls, that 300ms becomes 2 seconds of "white screen" for the user.

**Global Load Balancing (GLB)** isn't just about preventing server meltdowns; it’s about tricking physics by bringing the "edge" as close to the user as possible.

---

## The Legacy Era: DNS-Based GSLB (Global Server Load Balancing)

In the early days, we used DNS as our primary steering wheel. When a user in Tokyo looked up `api.example.com`, the DNS authoritative server would see the user’s (or their ISP’s) IP address and return the A record for a data center in Osaka.

### The Mechanism

DNS-based GSLB relies on **GeoIP databases**. The logic is simple:

```python
def get_nearest_ip(client_ip):
    location = geo_ip_lookup(client_ip)
    if location.country == 'JP':
        return "1.2.3.4" # Tokyo Edge
    return "5.6.7.8" # US-East Edge
```

### The Breaking Point

While simple, DNS-based steering is a blunt instrument for billions of requests:

1.  **The TTL Nightmare:** DNS records have a Time-To-Live (TTL). If a data center goes down, you update the DNS record. However, ISPs and browsers often ignore low TTLs to save bandwidth. You might pull the plug on a failing region, but millions of users will keep hitting the "dead" IP for minutes or even hours.
2.  **EDNS-Client-Subnet (ECS) Gaps:** Many DNS resolvers don't pass the actual user's IP prefix to the authoritative server. The Load Balancer sees the IP of the _Google Public DNS_ server instead of the user, potentially sending a user in Berlin to a data center in Virginia.
3.  **No Health Awareness:** Standard DNS is "dumb." It doesn't know if the underlying application is actually healthy; it only knows that the IP address exists.

---

## The Anycast Revolution: One IP to Rule the World

If DNS is like giving someone a map and hoping they follow the right path, **Anycast** is like having a portal to your store on every street corner.

In a standard **Unicast** setup, one IP address belongs to exactly one physical machine or load balancer. In **Anycast**, multiple geographically dispersed nodes advertise the _exact same IP address_ to the internet via BGP.

### How BGP Makes Anycast Work

BGP is the "glue" of the internet. Routers across the globe share information about which IP prefixes they can reach. When your edge nodes in London, New York, and Singapore all advertise `1.2.3.4`, the internet’s routers will automatically route a user’s packets to the "closest" node based on the fewest BGP "AS-Path" hops.

**The Magic:**

- No DNS TTL issues. If the New York node dies, you stop the BGP advertisement. Within seconds, the global routing table converges, and New York traffic is rerouted to Virginia or London.
- **Latency reduction:** The TCP handshake happens at the nearest PoP (Point of Presence), meaning the "Time to First Byte" (TTFB) drops significantly.

### The Engineering Catch: Connection Stability

Anycast has a notorious weakness: **BGP Flapping**. If a route changes mid-session, a packet that was going to London might suddenly be routed to Paris. Because the Paris server has no record of that TCP connection in its kernel state, it sends a `RST` (Reset) packet, and the user’s connection drops.

To solve this at the scale of billions, we don't use standard kernel-based load balancing. We use **Stateless Load Balancing** via Consistent Hashing.

---

## Inside the Edge: Maglev, Katran, and the Move to XDP

When a packet hits an Anycast PoP, it doesn't go straight to an application server. It hits a **Layer 4 (L4) Load Balancer**. At the scale of Meta or Google, hardware appliances are too expensive and inflexible. Instead, we use software-defined load balancers running on commodity Linux hardware.

### The Google "Maglev" Approach

Google pioneered the concept of a distributed software load balancer that uses **Consistent Hashing**. The goal is simple: even if the internal pool of servers changes, a packet for a specific flow (Source IP, Source Port, Dest IP, Dest Port) should always land on the same backend.

### Enter XDP (eXpress Data Path)

The traditional Linux networking stack is slow. For every packet, the kernel has to create an `sk_buff` data structure, move it through the firewall (iptables), and eventually hand it to an application. At 10 million packets per second, the CPU spends 90% of its time just moving data between memory buffers.

Modern architectures (like Facebook’s **Katran**) use **XDP and eBPF**. XDP allows us to run a custom C-like program directly on the Network Interface Card (NIC) driver, _before_ the packet even reaches the kernel.

**The XDP Flow:**

1.  Packet arrives at the NIC.
2.  An eBPF program calculates a hash of the 5-tuple.
3.  The program looks up the target backend in a shared BGP/Maglev table.
4.  The packet is encapsulated (usually via IP-in-IP) and sent immediately back out to the target server.
5.  **Total time:** Microseconds. **Kernel overhead:** Zero.

```c
// Simplified conceptual XDP snippet for steering
SEC("xdp_lb")
int xdp_load_balancer(struct xdp_md *ctx) {
    void *data = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    struct iphdr *iph = data + sizeof(*eth);

    // Perform Maglev-style consistent hashing to find backend
    __u32 backend_ip = lookup_backend_consistent_hash(iph->saddr);

    // Encapsulate and redirect
    return route_to_backend(ctx, backend_ip);
}
```

---

## The L4/L7 Split: Why "Terminating" Matters

Global Load Balancing is usually a two-stage rocket:

1.  **The L4 Tier (Anycast/XDP):** This tier lives at the edge. It doesn't look at the HTTP headers. Its only job is to handle massive packet volume and steer the traffic to the...
2.  **The L7 Tier (Envoy/Nginx/HAProxy):** This tier "terminates" the TLS connection. This is where the heavy lifting happens: header inspection, cookie-based routing, rate limiting, and WAF (Web Application Firewall) rules.

### Why terminate TLS at the edge?

If a user in Sydney is connecting to a server in New York, the TLS handshake (which involves multiple round trips) takes forever. By terminating TLS at an Anycast PoP in Sydney, the handshake happens locally (low latency). The PoP then maintains a "warm" pool of persistent TCP/HTTP2 connections to the New York origin, significantly speeding up the subsequent request.

---

## Handling the "Thundering Herd": Health Checks at Scale

In a global system, "Health" is a lie. There is no binary "Up" or "Down." There is only "Performing," "Degraded," or "Unreachable from some places."

### Distributed Health Checking

If you have 100 PoPs and 1,000 backend servers, you cannot have every PoP check every backend. That’s 100,000 health checks every second—essentially a self-inflicted DDoS.

Modern architectures use a **Gossip Protocol** or a **Hierarchical Health Check**:

- **Edge nodes** report local health to a **Regional Aggregator**.
- **Regional Aggregators** build a "Global Health Map."
- This map is pushed back down to the edge via a low-latency control plane (like an optimized Etcd or Consul cluster).

### The "Shedding" Strategy

When a region becomes overloaded (the "Thundering Herd" problem), we use **Exponential Backoff** and **Circuit Breaking**. But at the GLB level, we use **Load-Based Steering**.

Instead of just sending traffic to the "closest" node, the control plane calculates a "cost" for each path. If the Tokyo PoP is at 90% CPU, its cost increases, and BGP/DNS will start shifting the "overflow" traffic to Osaka or Seoul, even if they are physically further away.

---

## The Hype vs. Reality: The Move to "Edge Compute"

There is currently massive hype around "The Edge" (Cloudflare Workers, Fastly Compute@Edge, AWS Lambda@Edge). Marketing often paints this as a revolutionary new way to build apps.

**The Technical Substance:** This is simply the logical conclusion of Anycast Load Balancing. Once you’ve built a global Anycast network to steer packets and terminate TLS, you realize you have spare CPU cycles at the edge. Why send the request back to New York at all? If the request is for a static asset or a simple API call, you can run a V8 JavaScript isolate (or a WASM binary) directly on the L7 Load Balancer.

This reduces the "Billions of Requests" problem by resolving 80% of them within 10ms of the user, never hitting your core infrastructure.

---

## The Operational Complexity: When Anycast Goes Wrong

Anycast is powerful, but it's a double-edged sword. Since you are essentially "lying" to the internet (saying that your IP is in 50 places at once), debugging becomes a nightmare.

### The "Invisible Catchment" Problem

Sometimes, due to weird BGP peering agreements, a user in Kentucky might be routed to a PoP in London instead of Virginia. This is called **BGP Hijacking** or **Suboptimal Routing**.

To monitor this, we use **Real User Monitoring (RUM)**. We embed a small script in the web app that reports: "I am in Kentucky, but I reached the London Load Balancer." We then use this data to tune our **BGP Communities** and "prepends" to nudge the internet's routers into making better decisions.

---

## Summary of the Modern Stack

Building for billions requires a layered approach:

1.  **BGP Anycast:** For global reach and instant failover at the network level.
2.  **XDP/eBPF (L4):** For high-performance, stateless packet steering that bypasses the Linux kernel.
3.  **Consistent Hashing:** To ensure connection stability across a distributed fleet of servers.
4.  **TLS Termination at the Edge (L7):** To minimize the handshake latency and protect the origin.
5.  **Intelligent Control Plane:** To monitor health and dynamically adjust traffic based on real-world performance, not just proximity.

This architecture isn't just about handling volume—it’s about providing a consistent, sub-100ms experience for every human on earth, regardless of where they are. In the world of high-scale engineering, we don't just build systems; we build a global fabric that bends the internet to our will.

The next time you click a link and the page loads instantly, remember the silent dance of BGP, the microsecond-level XDP programs, and the thousands of kilometers of fiber that worked in perfect harmony to bring that data to you. That is the beauty of Global Load Balancing.
