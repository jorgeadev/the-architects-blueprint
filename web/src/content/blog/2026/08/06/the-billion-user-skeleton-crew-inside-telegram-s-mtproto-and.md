---
title: "The Billion-User Skeleton Crew: Inside Telegram’s MTProto and Radical Server Lean-ness"
shortTitle: "Telegram’s MTProto and Radical Infrastructure Efficiency"
date: 2026-08-06
image: "/images/2026/08/06/the-billion-user-skeleton-crew-inside-telegram-s-mtproto-and.svg"
---

Imagine you are tasked with building a messaging platform. Your goal is to support **900 million monthly active users**, deliver billions of messages daily, and ensure sub-second delivery latency across the globe.

Now, here is the catch: You only have about **30 core engineers**. You aren't allowed to use managed Kubernetes clusters on AWS. You can’t rely on off-the-shelf databases like vanilla PostgreSQL to handle the primary load. And you certainly aren't going to use Electron for your desktop app.

To most Silicon Valley architects, this sounds like a suicide mission. To Telegram, it’s just Tuesday.

The tech world often debates Telegram’s security model, but from a pure engineering perspective, Telegram is a masterpiece of **radical optimization**. While other giants throw thousands of developers and millions of dollars in cloud credits at the problem of scale, Telegram has carved out a path of extreme efficiency using their proprietary **MTProto protocol** and a "lean and mean" bare-metal philosophy.

Let’s peel back the curtain on the C++ wizardry and the custom cryptographic primitives that make this possible.

---

## The Philosophy of "No Bloat"

Before we look at the code, we have to understand the mindset. Telegram is built on a rejection of modern "layer-cake" engineering. In a typical modern stack, you have:

1.  **The Application Code**
2.  **A heavy Framework (React/Spring/Django)**
3.  **A Virtual Machine or Interpreter**
4.  **A Container Orchestrator (Kubernetes)**
5.  **A Hypervisor (AWS/GCP)**

Telegram effectively collapses these layers. They run almost exclusively on **bare metal** servers. They write their own serialization formats. They build their own database engines. By removing the abstractions, they reclaim the 30-50% "cloud tax" lost to virtualization and generic overhead.

---

## MTProto: A Protocol Built for the "Edge"

At the heart of Telegram lies **MTProto**. Currently in version 2.0, this protocol is often criticized by academic cryptographers because it doesn't use the standard "Signal Protocol" approach for every chat. However, from a performance standpoint, MTProto is a marvel.

MTProto was designed to solve a specific problem: **High-speed synchronization over unreliable, high-latency mobile networks.**

### The Three Layers of MTProto

MTProto isn't a single algorithm; it’s a suite divided into three distinct layers:

1.  **The High-Level (API Component):** Defines how API queries and responses are transformed into binary messages.
2.  **The Cryptographic (Authorization) Layer:** Handles the encryption of messages before they hit the transport layer.
3.  **The Transport Layer:** Defines how the client and server establish a connection (via TCP, UDP, or HTTP).

### 1. The Serialization Secret: Type Language (TL)

While the rest of the world was moving to JSON and then slowly migrating to Protocol Buffers (protobuf) or FlatBuffers, Telegram built **TL (Type Language)**.

TL is a schema language that describes the data structures used in Telegram. What makes it special is its extreme density. There is zero metadata sent over the wire. If a field is defined as an `int32`, exactly 4 bytes are sent.

Here is a conceptual look at a TL schema entry:

```tl
auth.sentCode#5e0025a2 flags:# type:auth.SentCodeType phone_code_hash:string next_type:flags.1?auth.CodeType timeout:flags.2?int = auth.SentCode;
```

When this is compiled, it generates native C++ or Java classes. Unlike JSON, which requires a heavy parser, or Protobuf, which has some tag overhead, TL is essentially a direct memory map. This allows Telegram’s servers to parse incoming packets with almost zero CPU cycles.

### 2. The Cryptographic Layer (The Controversial Part)

MTProto 2.0 uses a combination of **AES-256 in IGE (Infinite Garble Extension) mode** and **SHA-256**.

Why IGE? Most of the industry uses GCM (Galois/Counter Mode). IGE is a legacy mode that Telegram engineers favor because it provides a unique property: **error propagation**. If a single bit of the ciphertext is changed, the entire subsequent block becomes garbage. While academics argue this is unnecessary, Telegram uses it as an additional integrity check that fits their specific multiplexing model.

**The Handshake (Diffie-Hellman):**
When you log in, the client and server perform a Diffie-Hellman key exchange.

1.  The client requests a `nonce` from the server.
2.  The server responds with a `nonce` and a public key.
3.  The client generates a pre-master secret, encrypts it, and sends it back.
4.  Both parties derive the `auth_key`.

This key is then stored locally on your device and in Telegram's secure hardware modules. For "Cloud Chats," this key encrypts the traffic to the server. For "Secret Chats," the key is end-to-end, meaning the server never sees it.

---

## Scaling to 900M: The Server Architecture

If you look at Telegram's infrastructure, you won't find a sprawling microservices mesh. Instead, you'll find a highly distributed system of **Data Centers (DCs)**.

### Distributed Data Centers

Telegram operates five main Data Centers globally:

- **DC1:** US (Miami)
- **DC2:** Netherlands (Amsterdam)
- **DC3:** US (Miami) - _Primary for Western Hemisphere_
- **DC4:** Singapore
- **DC5:** Finland (Helsinki)

Users are assigned to a "Nearest DC." When you sign up, your data is homed in the DC closest to your phone number's country code. This reduces the **RTT (Round Trip Time)** for every message.

### The "A-Machine" and "B-Machine" Split

Telegram’s backend is split into two primary roles:

1.  **Frontend Nodes (The Gates):** These handle the massive MTProto connection state. They maintain millions of open TCP/MTProto sockets using an asynchronous I/O model similar to `epoll` but highly optimized for low-memory footprints.
2.  **Storage Nodes:** This is where the magic happens. Telegram doesn't use a massive, monolithic database. Instead, they use **custom-sharded distributed storage**.

### Custom Databases (The "KPHP" and "TL-RPC" Connection)

Telegram (and its predecessor VK) famously avoids the "One Database To Rule Them All" trap. They use a system called **TL-RPC**.

When a message arrives at a Frontend Node, it doesn't do a SQL `INSERT`. It creates a TL-encoded RPC call. This call is routed to a specific storage shard based on the `user_id`.

Telegram's storage engines are written in **C++** and are often **log-structured**. Instead of updating a record in place (which causes disk I/O thrashing), they append to a log. Since 99% of messaging is "read recent" and "write new," this fits the hardware's physical characteristics perfectly. They can saturate NVMe drive speeds because they aren't fighting a database engine's internal locking mechanisms.

---

## Why Is It So Fast? The Power of "Stateful" Connections

Most web apps are **stateless**. Every time your app makes a request, it has to re-authenticate, re-establish headers, and perhaps even perform a TLS handshake.

Telegram is **stateful**.

Once your app connects to a DC, it maintains a long-lived MTProto session. The server keeps a "mailbox" in RAM for your active session. When a message comes in for you, the server doesn't have to query a database to find out where you are; it already has your socket mapped in an in-memory hash table.

This is why Telegram feels "instant" compared to apps like Microsoft Teams or Slack, which often rely on traditional HTTP-based polling or standard webhooks.

### The MTProxy Hack

Telegram’s architecture is so lean that they can even outsource their "edge" network to the community. **MTProxy** is a lightweight server that users can run to bypass censorship. Because MTProto is so efficient, a $5/month VPS can handle tens of thousands of concurrent Telegram users. It simply wraps the MTProto traffic in a layer of "fake TLS" to look like normal web traffic to deep-packet inspection (DPI) firewalls.

---

## Memory Management: The C++ Edge

You cannot achieve Telegram’s scale with 30 people using Java or Python. The memory overhead of a Garbage Collector (GC) would require 3x the number of servers.

Telegram's backend code uses **custom memory allocators**. In a standard C++ environment, `malloc` and `free` can become bottlenecks under extreme concurrency. Telegram’s engineers use **Arena Allocation**.

When a request comes in:

1.  A chunk of memory (an Arena) is carved out.
2.  All objects for that request are built in that chunk.
3.  Once the request is sent, the _entire chunk_ is wiped at once.

This eliminates memory fragmentation and ensures that the CPU cache remains "hot" with relevant data.

---

## The Hype vs. The Reality: Is it Secure?

There is a lot of "security theater" in the tech world. Critics point out that Telegram doesn't use End-to-End Encryption (E2EE) by default (Cloud Chats use Server-Client encryption).

From an **engineering perspective**, this is a conscious trade-off for a better feature set:

- **Instant Sync:** Because Cloud Chats are stored (encrypted) on the server, you can log in on a new phone and instantly have your 10-year history without needing your old phone to be online (unlike WhatsApp).
- **Global Search:** Searching through gigabytes of messages is possible because the server can index the encrypted data (using keys stored in separate physical jurisdictions).
- **Huge Groups:** Handling 200,000 people in a single group with E2EE is a mathematical nightmare for mobile CPU/battery. Telegram’s model makes this trivial.

Telegram's security isn't based on "we can't see the data," but rather on **"we've distributed the keys so broadly that no single government can seize them."** They use a "Multi-Jurisdictional" approach where the keys to the data are split into parts and stored in different legal entities across the globe. To get a single message, you’d need a coordinated legal attack across multiple countries—an engineering solution to a political problem.

---

## Lessons for Modern Engineers

What can we learn from Telegram’s "Lean and Mean" stack?

1.  **Avoid "Resume-Driven Development":** You don't always need Kubernetes. Telegram proves that bare metal and C++ can outperform a 1,000-node cloud cluster if written correctly.
2.  **Control Your Serialization:** JSON is for humans. Binary formats (like TL or Protobuf) are for machines. If you want speed, stop parsing strings.
3.  **Statefulness is a Feature:** The move to stateless "Serverless" functions has made us forget how powerful a persistent socket can be for latency.
4.  **Hardware Matters:** By understanding how NVMe drives and CPU caches work, Telegram’s 30 engineers do the work of 3,000.

## Final Thought: The Skeleton Crew Wins

In an era of bloated "Electron" apps that eat 2GB of RAM to display a text box, Telegram is a reminder of what software can be. It is a system where every byte has a purpose and every CPU cycle is accounted for.

Whether you agree with their cryptographic choices or not, one thing is undeniable: Telegram’s architecture is one of the most efficient engines ever built for the internet. It is a "LMP1 Le Mans" car in a world of heavy SUVs. It’s built for speed, it’s built for scale, and it’s built to stay lean.

**Next time your 5-person startup’s AWS bill hits $10,000, ask yourself: "How would Telegram do this?" The answer probably involves a lot less YAML and a lot more C++.**
