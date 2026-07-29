---
title: "The 30 Million Connection Tsunami: How Discord Tamed the Thundering Herd"
shortTitle: "Discord Tamed the 30 Million Member Herd"
date: 2026-07-29
image: "/images/2026/07/29/the-30-million-connection-tsunami-how-discord-tamed-the-thun.svg"
---

Imagine it’s a quiet Saturday evening. Millions of people are hanging out in voice channels, streaming games, and chatting in massive servers with hundreds of thousands of members. Suddenly, a major internet backbone provider in North America hiccups. For exactly sixty seconds, a massive chunk of the internet loses connectivity.

At Discord, our dashboards don’t just dip—they plummet. 30 million WebSocket connections evaporate in an instant. But the drop isn't the problem. The problem is what happens sixty-one seconds later.

As the network stabilizes, 30 million clients—desperate to see their unread messages and friend statuses—simultaneously scream **"I'M BACK!"** at our infrastructure. This is the **Thundering Herd**, a recursive wave of reconnection attempts that can melt load balancers, saturate CPU cycles, and crush databases under the weight of authentication requests.

In the early days, this would have been a "Get the engineers out of bed" event. Today, it’s just another Tuesday. This is the story of how we re-engineered the Discord Gateway to handle the scale of a small country’s population reconnecting at once.

---

## The Gateway: The Heartbeat of Discord

To understand the solution, we first have to understand the beast. The **Gateway** is our persistent, real-time connection layer. When you open Discord, your client establishes a WebSocket connection to one of our thousands of Gateway nodes.

This isn't a simple "request-response" setup. It’s a stateful, long-lived pipe that handles:

- **Presence Updates:** "User X just started playing _Valorant_."
- **Typing Indicators:** "User Y is typing..."
- **Message Events:** Delivering that spicy meme to everyone in a channel.
- **Guild Syncing:** Keeping your list of 100 servers up to date.

The Gateway is primarily written in **Elixir**, leveraging the **Erlang VM (BEAM)**. We chose Elixir because it was built for this exact use case: millions of lightweight processes running concurrently, isolated from one another. But as we scaled from 5 million to 30 million concurrent users, the "magic" of the BEAM started hitting the hard walls of physics and operating system limits.

---

## The Anatomy of a Thundering Herd

When a client reconnects, it sends an `IDENTIFY` payload. This is the most expensive operation in our ecosystem. To process an `IDENTIFY`, the Gateway must:

1.  **Perform TLS Handshaking:** Heavy CPU usage.
2.  **Authenticate the User:** Validate tokens against our session store.
3.  **Fetch the "Ready" State:** This is the killer. We have to gather all the servers (Guilds) you are in, the members in those servers, their presence states, and your private channels.

If 30 million people do this at once, the backend services providing that "Ready" state get DDoS’d by our own users.

### The Death Spiral

The Thundering Herd creates a **Death Spiral**:

- The Gateway nodes hit 100% CPU trying to process `IDENTIFY` packets.
- Heartbeats (the "I'm still here" pings) start failing because the CPU is too busy.
- The server drops the connection because the heartbeat failed.
- The client tries to reconnect _again_, adding to the queue.

To solve this, we had to move away from "brute force scaling" and toward an architecture that prioritizes **resumability** and **backpressure**.

---

## Optimization 1: The "Session Resume" Revolution

The single most effective way to stop a Thundering Herd is to make sure it never happens. If a client disconnects for a few seconds, it shouldn't have to re-authenticate and fetch its entire world state. It just needs to "catch up" on what it missed.

We implemented a **Sequence-based Resume** mechanism:

- Every event sent to a client has a sequence number.
- When a client is disconnected, the Gateway node keeps that user’s session "alive" in memory for a short grace period (e.g., 3 minutes).
- When the client reconnects, it sends a `RESUME` packet instead of an `IDENTIFY`, providing the last sequence number it saw.
- The Gateway simply replays the missed events from a buffer.

**The Result:** A `RESUME` is **~100x cheaper** than an `IDENTIFY`. It requires zero database lookups and minimal CPU. By pushing our "Resume Rate" above 90%, we effectively neutralized 90% of the Thundering Herd's power.

---

## Optimization 2: Moving the Heavy Lifting to Rust

While Elixir is great for orchestration, it’s not always the fastest at raw data processing. One of our biggest bottlenecks was **JSON serialization**. Sending a massive "Ready" packet involves turning a giant Elixir map into a JSON string.

At 30 million connections, we were spending a staggering amount of CPU time just doing string manipulation. We looked at the BEAM's garbage collector and realized that creating millions of short-lived strings during a mass reconnection was causing massive GC pauses.

**Enter the Rust NIF (Native Implemented Function).**

We offloaded the most performance-critical parts of the Gateway—specifically the **fan-out logic** and **compression**—to Rust.

- We use **zstd** (Zstandard) for compression, which offers a better compression ratio and speed than traditional zlib.
- By using Rust to manage our shared state buffers, we reduced the memory overhead per connection significantly.

Instead of the Erlang VM copying data into every single process (which is the default behavior for isolation), we used **Shared Binary References**. When a message is sent to 100,000 people in a server, we encode it once in Rust and send a pointer to that memory to all the Elixir processes. This reduced our memory pressure by orders of magnitude.

---

## Optimization 3: Passive Heartbeating and "Lazy Guilds"

At 30 million concurrents, even "idle" connections aren't free. If every client sends a heartbeat every 30 seconds, that’s **1 million heartbeats per second**.

The Gateway has to acknowledge every single one. To handle this, we moved to a **Passive Heartbeat** system. If the server has sent data to the client recently, we count that as a "heartbeat" from the client’s perspective. This reduced the "noise" on the wire, allowing the Gateway nodes to focus on actual message delivery.

### The "Lazy Guild" Pattern

One of Discord's unique challenges is the "Mega-Server" (e.g., the Official _Minecraft_ or _Genshin Impact_ servers). These servers have 500,000+ members.
In the old architecture, when you joined one of these, we would send you the presence state (Online/Idle/DND) for _every single member_.

That was insane. Your phone cannot handle a 50MB JSON blob of people you don't even know.

We re-engineered the protocol to use **Lazy Guilds**. Now, the Gateway only sends you presence data for:

1.  People on your screen (using a "range" of the member list).
2.  People you are actively interacting with.

This change alone reduced the size of the `READY` payload by **95%** for our most active users, making the "Thundering Herd" much more of a "Pattering Rain."

---

## Infrastructure: Scaling the Linux Kernel

You can have the best code in the world, but if your OS isn't tuned, you'll hit a wall at 65,535 connections (the mythical port limit). Except, that limit is a lie.

We run our Gateway on **Google Cloud Platform (GCP)** using **GKE (Google Kubernetes Engine)**. Each of our nodes is a beefy machine, but we had to perform significant "Kernel Surgery" to allow a single instance to handle hundreds of thousands of concurrent WebSockets.

### The Tuning Checklist:

- **`net.core.somaxconn`:** We bumped this to 100,000. This controls the size of the listen queue for accepting new TCP connections. During a Thundering Herd, if this is too small, the kernel will drop new connections before our Elixir code even sees them.
- **`net.ipv4.tcp_max_syn_backlog`:** Increased to handle the flood of SYN packets during a mass login.
- **Ephemeral Port Ranges:** We widened the range to ensure we never ran out of local ports for outbound proxying.
- **File Descriptors (`unlimit -n`):** Every WebSocket is a file. We set the limit to several million per node.

### The Load Balancer Problem

Standard Cloud Load Balancers often struggle with "sticky" long-lived WebSockets. If one Gateway node restarts, the LB might try to shove all 100,000 disconnecting users onto a single "healthy" node, killing it instantly.

We built an internal service called **"The Decider."** When a client wants to connect, it first hits an HTTP endpoint that looks at the current load across our entire fleet and gives the client a specific Gateway URL. This allows us to perform **Intelligent Load Shedding**. If a region is struggling, "The Decider" can tell clients to back off or redirect them to a different data center.

---

## Handling the Data Deluge: Manifold

When a message is sent in a server with 100,000 people, the Gateway has to "fan out" that message. In Elixir, that usually means sending a message to 100,000 different processes.

Even though BEAM processes are light, doing this 100,000 times in a single loop is slow. It blocks the process trying to do the sending.

We created a library called **Manifold**. Manifold distributes the fan-out work. Instead of the "Source" process sending to 100,000 "Destination" processes, it sends the message to one "Distributor" process on every remote CPU core. Those distributors then handle the local fan-out. This turned an $O(N)$ problem into an $O(N/Cores)$ problem, effectively parallelizing the workload across the entire machine's hardware.

---

## The "Medusa" Session Store

As we scaled to 30 million, keeping all session data in the memory of the Gateway nodes became a liability. If a node crashed, 200,000 people were forced into a "Cold Start" `IDENTIFY` because their session state died with the node.

We introduced a decoupled session layer, internally nicknamed **Medusa**.
Medusa is a high-performance, distributed key-value store (built on top of a modified Redis/Scylladb architecture) that persists Gateway sessions.

Now, when a Gateway node dies, the client reconnects to a _different_ node. That new node asks Medusa, "Hey, do you know about Session XYZ?" Medusa says "Yes," hands over the sequence buffer, and the user **Resumes** without ever hitting the database.

This decoupling was the final piece of the puzzle. It transformed our Gateway from a collection of fragile, stateful silos into a resilient, fluid fabric.

---

## Engineering for the Extreme

Solving the Thundering Herd wasn't about one "silver bullet" fix. It was a multi-year journey of:

1.  **Protocol Evolution:** Moving from `IDENTIFY` to `RESUME`.
2.  **Language Polyglotism:** Using Elixir for concurrency and Rust for raw speed.
3.  **Data Efficiency:** Implementing `zstd` and Lazy Guilds to shrink the pipe.
4.  **OS Tuning:** Pushing Linux to its absolute limits.

Today, Discord handles over **30 million concurrent users** and trillions of events per day. When the internet hiccups and those 30 million users come rushing back, our systems don't sweat. They simply acknowledge the sequence numbers, replay the missed memes, and keep the conversation going.

The "Herd" is still thundering—we just built a better canyon for them to run through.

---

**Technical Specs for the Curious:**

- **Language Stack:** Elixir, Rust, Go.
- **Transport:** WebSockets over TLS 1.3.
- **Compression:** Zstandard (zstd).
- **Infrastructure:** GKE, Custom Rust-based Load Balancing.
- **Concurrency Model:** Actor model (BEAM) with Shared Binary optimization.
