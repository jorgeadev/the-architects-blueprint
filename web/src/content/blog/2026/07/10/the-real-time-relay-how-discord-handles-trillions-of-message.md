---
title: "💬 The Real-Time Relay: How Discord Handles Trillions of Messages with Cassandra & Rust"
shortTitle: "Scaling Discord to Trillions of Messages with Cassandra and Rust"
date: 2026-07-10
image: "/images/2026/07/10/the-real-time-relay-how-discord-handles-trillions-of-message.svg"
---

**"We process over 120 million messages per day. That’s more than Twitter and Facebook combined—per hour."**  
— _Discord Engineering, circa 2021_

You probably know Discord as the place where your gaming squad hangs out, where your coding server explodes with PR notifications, or where your friends spam memes at 3 AM. But behind that casual chat UI lies an **absolute beast of a real-time messaging architecture**—one that handles **trillions** of messages, serves millions of concurrent WebSocket connections, and does it all with sub-second latency.

But here’s the kicker: they built it with **Rust** (for painless concurrency and zero-cost abstractions) and **Cassandra** (for horizontally scalable, high-volume writes). And they didn’t just "tweak" an off-the-shelf solution—they rewrote their entire core messaging pipeline from Python/Go to Rust, and migrated from MongoDB to Cassandra, solving problems that would make most engineering teams run for the hills.

Let’s tear open the relay. This is **Discord’s real-time messaging architecture**—no fluff, no filler, just raw engineering substance.

---

## 🔥 The Hook: Why Should You Care?

Discord is **not just a chat app**. It’s a **real-time pub/sub system** that must:

- **Persist every message** (trillions of them) for search, history, and compliance.
- **Fan out messages** to tens of thousands of users in a single channel with **sub-100ms latency**.
- **Handle spikes**—like when a server with 500k members goes viral during a live event.
- **Scale horizontally** without sharding nightmares.

And they do it all with a **six-person core infrastructure team** (as of their 2020 talks). That’s insane. So how?

The answer lies in a **three-headed monster**: **Rust’s fearless concurrency**, **Cassandra’s write-optimized NoSQL**, and a **bespoke WebSocket gateway** that’s basically a bulletproof message broker. Let’s dive into each head.

---

## 🦀 Head 1: Rust — Why “Rewrite It in Rust” Actually Worked

Discord started with Python (for their API/chat service) and Go (for their real-time gateway). But by 2020, they hit a wall: **Python’s GIL** couldn’t keep up with the massive concurrent connections, and **Go’s garbage collector** caused unpredictable latency spikes under load. They needed a language that could:

- **Handle 10,000+ concurrent WebSocket connections per node** without memory thrashing.
- **Minimize context switches** between kernel and user space.
- **Provide zero-cost abstractions** for hot code paths (like message serialization and payload routing).

Enter **Rust**.

### 🔧 The Rust Migration: What They Rewrote

Not _everything_ is in Rust (Discord still uses Python for their app API and Go for some services). But the **critical path**—the real-time messaging gateway—went full Rust. Specifically:

| Component                                   | Old Stack              | New Stack                  | Why Rust?                                                    |
| ------------------------------------------- | ---------------------- | -------------------------- | ------------------------------------------------------------ |
| **WebSocket Gateway** (connection handling) | Go (gRPC + goroutines) | Rust (Tokio async runtime) | Tokio’s work-stealing scheduler + no GC = consistent latency |
| **Message Routing** (channel fan-out)       | Python (event loop)    | Rust (custom reactor)      | Rayon for parallel dispatch + zero-copy buffers              |
| **Voice/Video signaling**                   | C++                    | Rust                       | Memory safety without overhead                               |

The result? **50% less latency** under peak load and **4x fewer nodes** needed to handle the same traffic. Rust’s ownership model eliminated entire classes of bugs (use-after-free, data races) that plagued the Python/Go codebase during large-scale rollouts.

### 💻 Code Taste: A Rust WebSocket Handler (Discord-Style)

Don’t worry—this isn’t production Discord code. But it captures the spirit:

```rust
use tokio::net::TcpStream;
use tokio_tungstenite::{accept_async, WebSocketStream};
use futures::StreamExt;

async fn handle_connection(stream: TcpStream) -> Result<(), Error> {
    let ws_stream: WebSocketStream<TcpStream> = accept_async(stream).await?;

    // Discord's gateway protocol: each message is a JSON payload with an opcode
    ws_stream
        .for_each(|msg| async {
            match msg {
                Ok(tungstenite::Message::Text(payload)) => {
                    // Atomic ref-counted channel broadcast
                    let channel = Channel::get(&payload).await;
                    channel.broadcast(payload).await;
                }
                Err(e) => log::error!("WS error: {}", e),
                _ => {} // Pings, pongs, binary ignored
            }
        })
        .await;
    Ok(())
}
```

The **magic** is in `channel.broadcast()`. That’s where Cassandra and Rust meet.

---

## 🗄️ Head 2: Cassandra — The Write Monster

**MongoDB was the original storage layer** for Discord messages. But by 2016, they hit a write bottleneck hard: MongoDB’s B-tree indexes became fragmented under high-volume inserts, causing **write amplification** and **poor tail latency**. They needed something that **treated writes as cheap** and **reads as configurable**.

Enter **Apache Cassandra**. Discord didn’t just use Cassandra—they **tuned it to the bone** for their use case.

### 🧠 The Data Model: “Messages Are Just Rows”

Discord’s message schema in Cassandra is deceptively simple:

```sql
CREATE TABLE messages (
    channel_id bigint,          -- Partition key
    message_id bigint,          -- Clustering key (time-based snowflake)
    author_id bigint,
    content text,
    timestamp timeuuid,
    is_pinned boolean,
    -- ... more fields ...
    PRIMARY KEY (channel_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

Key design decisions:

- **Partition by `channel_id`**: All messages for a channel live on a single node (or replica). This means **reads are local**—no cross-node queries for channel history.
- **Use `message_id` as a snowflake**: Discord uses a custom **68-bit snowflake** (like Twitter’s) with a timestamp component. This gives **time-ordered clustering** for free: `SELECT * FROM messages WHERE channel_id = X ORDER BY message_id DESC` is an O(log N) operation on a single partition.
- **Tombstone avoidance**: Deletes are rare (Discord doesn’t let you delete every message). When they _do_ happen, they use **time-to-live (TTL)** on the message row to avoid zombie tombstones.

### 📊 Scale Numbers: How “Trillions” Works

Let’s do the math.

- **120 million messages/day** (as of 2021). In 2024, that’s likely **500M+** with voice, video, and app integrations.
- Each message is ~1KB after protobuf serialization (Discord moved from JSON to a custom binary format in Rust).
- **Total write throughput**: 500M messages/day = ~5,700 writes/second sustained. Spikes hit **20,000 writes/second** during events.

Cassandra handles this with **multi-datacenter replication** (cross-region) and **tunable consistency**:

- **Write consistency**: `LOCAL_QUORUM` (write to 2 of 3 replicas in the local DC).
- **Read consistency**: `ONE` (read from a single replica, then async repair). Discord prioritizes **write availability** over read consistency—because **you can’t lose a message that was sent**.

### 🔧 The “Tombstone Apocalypse” and How They Avoided It

Cassandra has a dirty secret: **deletes create tombstones**, and too many tombstones kill read performance. Discord’s solution? **Don’t delete.** Instead:

- **Soft deletes**: Mark a message as `is_deleted = true` in a separate column family (a time-series table).
- **TTL for ephemeral messages**: If a message has `auto_delete_after = 1 hour`, it gets a TTL. After the TTL expires, Cassandra automatically removes the row—no tombstone required.
- **Vacuum-like compaction**: Their Rust gateway schedules **off-peak aggressive compactions** to purge tombstones from hot partitions.

This is why your old DMs still load fast—even though you’ve deleted thousands of messages.

---

## 🌐 Head 3: The Real-Time Relay — How Messages Actually Move

This is the **secret sauce**. Discord’s messaging pipeline isn’t just “store in Cassandra and poll.” It’s a **fire-and-forget, write-back cached, three-stage relay**.

### 🚀 Stage 1: Ingest (Rust Gateway)

When you press send:

1. **Your client** sends a WebSocket message to the **nearest gateway node** (load balanced by latency).
2. The **Rust gateway** parses the protocol (binary payload, not JSON) and verifies permissions via a local cache.
3. The gateway **writes the message to Cassandra** (write consistency: `LOCAL_QUORUM`).
4. A **success response** (with the snowflake ID) is sent back to the sender **before** fan-out begins. This is crucial: **the sender sees “Message sent” immediately**, even if the fan-out is still propagating.

### 🚀 Stage 2: Fan-Out (The “Channel Worker”)

Here’s where it gets wild. Each **channel** is assigned to a **channel worker** (a Rust task running on a Tokio runtime). The worker maintains:

- **A list of connected users** (WebSocket handles) for that channel.
- **A cursor** (last `message_id` seen by each user).
- **An in-memory write-back cache** of the last 500 messages (for recent history).

When a new message arrives:

1. The worker **appends it to the write-back cache** (in-memory, zero copy).
2. It **batches Cassandra writes** (every 100ms or 1000 messages, whichever comes first).
3. It **iterates over connected WebSocket handles** and pushes the message to each.

**The fan-out isn’t a single broadcast.** It’s a **naive N-1 loop** in Rust—which sounds dumb until you realize that **Rust can iterate over 10k WebSocket handles in under 1ms** because the handles are stored in a contiguous `Vec` and there’s **zero overhead for GC**. A Python or Go loop over 10k goroutines would have been 100x slower due to scheduler overhead.

### 🚀 Stage 3: Backfill (Cassandra Read-Through)

What if a user was offline when a message was sent? Or what if the in-memory cache missed?

The **channel worker** detects a **gap** in the user’s `last_message_id` cursor. It then:

1. **Reads from Cassandra** using `SELECT * FROM messages WHERE channel_id = X AND message_id > {cursor} ORDER BY message_id ASC`.
2. **Replays** the missed messages to the user (in a single WebSocket batch).
3. **Updates the in-memory cache** with the retrieved messages.

This is why reading 10,000 messages in a channel feels instant: the first 500 come from RAM, and the rest stream from Cassandra like a lazy-loaded iterator.

---

## 🧠 The Big Idea: Why This Architecture Wins

**Discord’s architecture is not a new invention—it’s a masterclass in trade-offs.**

| Trade-off                           | Their Choice                                          | Why                                                            |
| ----------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| **Writes vs. Reads**                | Writes first, reads second                            | Messages must never be lost. Stale reads are acceptable.       |
| **Consistency vs. Availability**    | Eventual consistency (LOCAL_QUORUM writes, ONE reads) | CAP theorem: sacrifice C for A and P.                          |
| **Vertical vs. Horizontal scaling** | Horizontal (Cassandra partitions + Rust worker pools) | Predictable cost curve as traffic grows.                       |
| **Stateful vs. Stateless**          | Hybrid (state in Cassandra, memory cache on workers)  | Reduce Cassandra read pressure while keeping write durability. |

And the **secret ingredient**? **Rust’s ability to handle massive concurrency without garbage collection.** Every goroutine in Go would add a few microseconds of GC pause. Every Python callback would be blocked by the GIL. Rust’s fearless concurrency means you can have **50,000 WebSocket connections on a single box** without the CPU screaming for mercy.

---

## 📈 Recent Hype: The “Real-Time Reliability” Battle

In 2023, Discord faced a **high-profile outage** during a massive gaming event (a new game launch with 1M+ concurrent users). The community lost their minds—but Discord’s **postmortem** revealed something impressive:

- The root cause was **a Cassandra partition failure** (a single node went down under write pressure).
- But **99.9% of messages were still delivered** within 2 seconds, because **the Rust gateway held the messages in memory** until the partition recovered.
- They **hot-patched the Cassandra cluster** within 14 minutes—without a full restart.

This is the kind of resilience you get when your **ingestion layer is decoupled from storage** by a stateful, memory-safe relay.

---

## 🔧 Practical Takeaways for Your Own Architecture

If you’re building a real-time system (chat, notifications, live collaboration):

1. **Don’t use MongoDB for high-volume writes.** It’s great for read-heavy apps, but the write bottleneck is real. Cassandra (or ScyllaDB, a C++ Cassandra-compatible fork) is better.
2. **Write in a language that doesn’t fight you.** Python is fine for prototypes. For production concurrency? Rust or Go. If you choose Go, accept the GC pauses.
3. **Cache aggressively, but write back.** The in-memory cache in the channel worker reduces Cassandra reads by 80%. But if the worker crashes, you lose only the last 500 messages—not the entire history.
4. **Use snowflakes for time-ordering.** They give you free sorting and distributed ID generation without a central sequence.
5. **Prefer soft deletes with TTL.** Tombstones in Cassandra are a nightmare. If you must delete, use TTLs or compaction-friendly strategies.

---

## 💬 Final Word: Discord’s Engineering Isn’t Magic—It’s Trade-offs

The next time you send a message in #general and it shows up on 10,000 screens in under 200ms, remember: **that message was written to a Cassandra partition on a node in Oregon, cached in RAM on a Rust worker in Frankfurt, and pushed across a WebSocket connection that was opened 48 hours ago.**

No magic. Just **Cassandra’s write-scalability**, **Rust’s performance**, and **a team that deeply understands their data access patterns**.

And that’s why Discord’s real-time messaging architecture is one of the most impressive (and under-discussed) systems in modern infrastructure.

---

_Want to dive deeper? Check out Discord’s engineering blog posts on their Cassandra migration (2017) and Rust rewrites (2020). Or, if you’re brave, try building your own WebSocket relay in Rust—just don’t blame me when you hit the tombstone apocalypse._ 😉

---

**What’s your experience with real-time messaging systems? Drop a comment below—or just send me a DM in Discord. I’ll see it in under 200ms.**
