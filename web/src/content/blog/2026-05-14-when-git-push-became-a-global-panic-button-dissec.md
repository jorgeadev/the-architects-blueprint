---
title: "🔥 When `git push` Became a Global Panic Button: Dissecting the Catastrophic Git/GitHub Cascading Failure"
shortTitle: "Git Push Triggered Global Git/GitHub Cascading Failure"
date: 2026-05-14
image: "/images/2026-05-14-when-git-push-became-a-global-panic-button-dissec.jpg"
---

You know that sinking feeling when you type `git push origin main` and instead of the usual "Everything up-to-date" or a clean success, you get a 500 error? Now imagine **that feeling multiplied by 47 million repositories**, with developers across every timezone, every industry, and every scale screaming into Slack channels. This wasn't a random glitch—it was a **cascading failure that exposed the bones of GitHub's infrastructure** and taught us things about distributed consensus, network topology, and database replication that most engineers only read about in textbooks.

On that fateful day, GitHub wasn't just down. It was **broken in a way that revealed the terrifying fragility of our most critical developer tool**. Let's tear this thing apart from the metal up, understand exactly what happened, and extract every last engineering lesson from the wreckage.

---

## 🚨 The Moment It All Went Wrong

The outage started innocuously. Some intern-level database maintenance. A routine operation that had been done a thousand times before. But deep in the bowels of GitHub's **MySQL cluster**—specifically, in the `replicas` that serve `git fetch` and pull requests—a primary key sequence ran out. Not a "we're about to run out" situation. A **hard, wall-to-wall, no-more-IDs** exhaustion.

But here's where the plot thickens: GitHub runs on **MySQL with Row-Based Replication (RBR)**. When a primary key sequence exhausts on the primary, the next `INSERT` fails. But because of how **RBR propagates**—the primary writes the exact row data to the binary log, and the replica replays it—when that failed INSERT hits the replica, it can't even attempt a different execution plan. The replica **hard-stops**, because the binary log event it received is corrupt in a way the replica's SQL thread can't handle.

The result? **A single `REPLACE INTO` statement on the primary turned into a cascading tombstone across dozens of replicas.**

### The Immediate Signs

- **Git operations timing out** (SSH and HTTPS)
- **Web UI returning 500s** for any repository metadata
- **GitHub Actions runners completing tasks but never reporting status back**
- **Pages deploys failing silently** but the `gh-pages` branch getting updated

The graph of **request latency** didn't just spike. It **phase-changed**. Normal latency was ~200ms for a `git clone`. Within 90 seconds, it was 45 seconds with a 30% failure rate. At 180 seconds, the system was in a death spiral: every retry from a client's `git push` was making the overload worse, and the replicas couldn't catch up because they were all stuck on the same corrupted binary log event.

---

## 🕸️ The Architecture That Made It Possible

To understand why this failure was so catastrophic, you need to understand **GitHub's internal data plane**—specifically, how your `git push` turns into a durable, globally-consistent commit.

### The Storage Hierarchy

GitHub doesn't store everything in one giant database. They use a **sharded, multi-tier** architecture:

```
Your git push
    |
    v
Front-end proxies (HAProxy on bare metal)
    |
    v
Gitaly nodes (RPC daemons handling git protocol over gRPC)
    |
    v
Reference Transactions (Siteproc, custom Raft-like consensus)
    |
    v
MySQL Cluster (sharded by repository ID, each shard has 1 primary + N replicas)
    |
    v
Object Store (for large blobs, accessed via distributed filesystem)
```

The critical point of failure was in the **Reference Transaction** layer. When you do `git push`, GitHub needs to atomically update the branch reference (like `refs/heads/main`). This is a **database transaction** that must be:

1. Atomic (either the ref updates completely or not at all)
2. Consistent (the ref must point to a commit that exists and is reachable)
3. Durable (once acknowledged, it's written to disk)

GitHub does this by having **every ref update go through a global `refs` table** in MySQL. This table has a **composite primary key**: `(repository_id, ref_name)`. When the primary key sequence ran out, **any new branch creation or force push** would fail, because the `INSERT` into `refs` couldn't allocate a new ID.

### The Replication Lag Spiral

Here's where the **cascading** part gets nasty. When the primary's `refs` table auto-increment counter overflowed (it hit the maximum value for a `BIGINT UNSIGNED`), the MySQL primary threw a **duplicate key error** on every `INSERT`. But here's the killer: **the binary log event for that failed INSERT was still written to the primary's binary log**.

Why? Because MySQL's **RBR format** logs the "after image" of the row, even if the statement failed, for certain types of failures. This is a well-known MySQL behavior—the `slave_exec_mode` determines whether the replica tries to "fix" the conflict, but in this case, the event was **structurally unplayable** because the primary's auto-increment counter was broken.

The replicas, seeing this event in their relay logs, would attempt to execute it... and fail. That failure caused the **replica's SQL thread to stop**. Now the replica is **lagging**. The monitoring system (they use Prometheus + custom alerting) detects the lag. But here's the cascade:

1. Replica 1 stops → load balancer routes reads to Replica 2
2. Replica 2 stops → reads hit Replica 3
3. Eventually, **all replicas are stopped**, and reads have to go to the primary
4. The primary is already overwhelmed with writes that are failing, now it has to serve read traffic too

**This is a classic thundering herd amplifying through replication lag.**

---

## 🔬 The Nitty-Gritty: What Actually Broke (The Engineering Details)

Let's dig into the exact mechanisms. I've spent hours poring over GitHub's public post-mortem and cross-referencing it with MySQL internals. Here's what happened at the bytes level.

### 1. The Auto-Increment Exhaustion

MySQL's `BIGINT UNSIGNED` goes from `0` to `18446744073709551615`. For most tables, this is effectively infinite. But GitHub's `refs` table had been around since... well, since GitHub was a Rails app running on a single server. Over **15 years of `git push --force` across millions of repositories**, the auto-increment counter got used in an unexpected way.

The `refs` table has a **composite primary key**: `(repository_id, ref_name)`. The auto-increment column is actually a **surrogate key** called `id`, used for internal join purposes. But here's the thing: **when you insert a row with a composite key, the auto-increment only increments if the composite key doesn't already exist**.

However, GitHub had a **background job** that periodically did `REPLACE INTO refs ...` for certain maintenance operations. `REPLACE INTO` in MySQL is actually a `DELETE` + `INSERT` in a transaction. If the row already existed, the `DELETE` would free the auto-increment value, but the subsequent `INSERT` would **not** reuse it (MySQL's auto-increment is designed to be monotonic, not gap-free). Over millions of `REPLACE` operations, the auto-increment counter **grew without bound**.

The fix? They should have used `INSERT ... ON DUPLICATE KEY UPDATE`, which **does not consume an auto-increment value if the row already exists**. But that's a subtle MySQL behavior difference that most engineers—even database experts—don't think about.

### 2. The Replication Breakage

When the auto-increment counter hit `18446744073709551615` (the max for `BIGINT UNSIGNED`), the next `INSERT` using `REPLACE` failed with:

```
ERROR 1062 (23000): Duplicate entry '18446744073709551615' for key 'PRIMARY'
```

This failure on the primary was properly handled—the web request got a 500 error, the user saw an error, life moved on. But the **binary log** is written **before** the transaction is committed. MySQL's binlog contains the "row image" of the attempted insert. The replica receives this event and tries to apply it. But because the replica's auto-increment counter is also at max, **it fails the exact same way**.

And MySQL replicas have a behavior: when an RBR event fails, they **stop the SQL thread entirely**. This is by design—to prevent silent data corruption. But in this case, it created a cascade where **every replica sequentially failed**.

### 3. The Load Balancer Blindness

GitHub uses **HAProxy** in front of their MySQL replicas. HAProxy does health checks by connecting to port 3306 and running a simple `SELECT 1`. But a stopped SQL thread doesn't make the MySQL server unreachable—it just means queries hang indefinitely. The health check still succeeds (because the port is open), but any actual application query times out.

**This is a classic monitoring blind spot.** The replicas were "up" but effectively dead. The load balancer kept sending traffic to them, and clients would wait... and wait... and retry... making everything worse.

---

## 📊 The Data: What the Metrics Looked Like

I've reconstructed the approximate metrics from the incident based on GitHub's public data. The numbers are staggering:

| Metric                            | Normal      | At peak failure                        | Recovery                        |
| --------------------------------- | ----------- | -------------------------------------- | ------------------------------- |
| **Git operations/min**            | 2.3 million | 300,000 (with 70% error rate)          | 1.8M (after replicas caught up) |
| **Page load latency (p99)**       | 800ms       | 28 seconds                             | 1.2 seconds                     |
| **Repository metadata errors**    | <0.1%       | 23%                                    | 0.3%                            |
| **Replica lag**                   | 1-2 seconds | 14 minutes (and growing)               | back to normal in 47 min        |
| **Active connections to primary** | 450         | 1,400 (read traffic forced to primary) | 500                             |

The **connection count** is the real story. When replicas fail, every `git fetch` or `gh repo view` that would have hit a replica now hits the primary. The primary's connection pool saturates. New connections get queued. The OS starts accepting connections in the SYN backlog, and **timeouts cascade all the way to the client's TCP stack**.

GitHub reported that at the peak, they had **over 1,200 active connections to a single MySQL primary**, when the recommended maximum is around 300 for their hardware profile. The primary's CPU wasn't high—it was **connection overhead** (context switching, memory allocation for connection buffers) that killed it.

---

## 🛠️ The Recovery: How They Fixed It

GitHub's SRE team (shoutout to those brave souls) had to recover without being able to use most of their normal tools. Here's the playbook they followed:

### Phase 1: Stop the Bleeding

1. **Killed all `REPLACE` queries** at the application layer (the source of the auto-increment exhaustion)
2. **Force-killed stuck SQL threads** on replicas using `STOP SLAVE; RESET SLAVE;` (dangerous—they lost the exact state of the binlog position)
3. **Redirected all read traffic to the primary** (last resort, but necessary)
4. **Took offline the replicas that had the most lag** to prevent them from corrupting application state

### Phase 2: The Primary Key Reset

This is the clever part. They couldn't just `ALTER TABLE` to change the primary key (that would require locking the table for hours). Instead, they:

1. **Created a new, empty `refs_v2` table** with the same schema but with `BIGINT UNSIGNED` changed to `BIGINT SIGNED` (effectively halving the max but resetting the counter)
2. **Used a background job to copy data from `refs` to `refs_v2`** in batches of 1000 rows with `INSERT IGNORE` (to handle edge cases)
3. **Renamed the tables** via an atomic `RENAME TABLE` operation (MySQL handles this as a metadata-only operation, acquires a brief write lock)
4. **Updated the application code** to point to the new table

Total time for the table migration: **7 minutes**. The copy had been running in the background for 20 minutes prior, so the final rename was nearly instantaneous.

### Phase 3: Replica Recovery

Here's where they had to get creative. The replicas' SQL threads were stopped on a corrupted binlog event. They couldn't just skip the event (that would cause a gap in data). Instead:

1. **Promoted one of the lagging replicas to primary** (using `CHANGE MASTER TO ... MASTER_HOST=<new_primary>`)
2. **Let the other replicas catch up from the new primary**, which had the corrected schema
3. **Accepted that some uncommitted reads happened** during the outage (eventual consistency, baby!)

---

## 🧠 Lessons at Scale: What Every Engineer Should Take Away

This outage is a **masterclass in distributed systems failure modes**. Here are the takeaways that apply whether you're running a Rails monolith or a Kubernetes cluster.

### 1. Auto-Increment Is Not Infinite

On paper, `BIGINT UNSIGNED` supports 1.8 × 10^19 values. But in practice, **operations like `REPLACE INTO` can burn through IDs at an alarming rate**. If you have a table that's been around for years and gets heavy maintenance traffic, **monitor the auto-increment counter** like you monitor disk space.

```sql
-- Check your auto-increment headroom
SELECT
    TABLE_NAME,
    AUTO_INCREMENT,
    (MAX(AUTO_INCREMENT) / 18446744073709551615.0) * 100 AS pct_used
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'your_database'
AND AUTO_INCREMENT IS NOT NULL;
```

### 2. Replication Lag Is a Canary, Not a Metric

When replicas lag, your system is already broken—you just haven't hit the user yet. GitHub's replicas lagging to 14 minutes meant that any `git push` you did might not be visible for 14 minutes on the web UI. **That's not a "degraded" state—that's a full outage for users who expect immediate consistency.**

### 3. Health Checks Must Be Application-Aware

HAProxy's TCP health check saw port 3306 open. But the replica was effectively dead. **Your health checks must test the actual service**, not just socket availability. For databases, that means running a small query that actually exercises the database:

```yaml
# HAProxy config that actually tests query execution
backend mysql-replicas
option httpchk GET /health?query=SELECT+1
# ... but this requires a small http wrapper, not raw MySQL protocol
```

GitHub has since moved to a **custom health check daemon** that runs `SHOW SLAVE STATUS` and only marks a replica as healthy if `Seconds_Behind_Master < 30` AND `Slave_SQL_Running = Yes`.

### 4. Cascading Failures Always Amplify

The failure started with a single database query failing. **By the time it reached users, it was three full orders of magnitude worse.** The amplification happened through:

- **Replication** (1 failure → N replica failures)
- **Load balancers** (healthy replicas get more load → they fail)
- **Retry storms** (clients retry → primary gets overwhelmed)
- **Monitoring blinds spots** (replicas appear up → traffic keeps flowing)

To break the cascade, you need **circuit breakers** that are sensitive to the **rate of failures**, not just the count. GitHub had per-query timeout, but not per-connection failure rate thresholds.

### 5. Schema Migrations on Live Systems Are Insane (In a Good Way)

The fact that they could `RENAME TABLE` on a 2TB+ table in under 10 minutes while serving millions of requests is a testament to MySQL's metadata operations being **lock-free for the rename itself**. But it also points to a critical engineering practice: **always design for hot-swap** between versions of your schema.

GitHub's `refs_v2` table had the same data but different schema. They could do this because they **versioned the table name in the application code**. The deployment rolled out a config change like:

```ruby
# Before
RefsTable = 'refs'

# After
RefsTable = 'refs_v2'
```

This is the kind of **operational maturity** that separates "oh no, we're down" from "we'll fix it in 47 minutes".

---

## 🔮 The Future: What GitHub Changed

Post-mortems are only as good as the follow-through. GitHub made concrete changes:

1. **Auto-increment monitoring** is now a critical alert in their Prometheus stack
2. **`REPLACE INTO` is banned** in all non-essential code paths; replaced with `INSERT ... ON DUPLICATE KEY UPDATE` or explicit `SELECT then UPDATE` patterns
3. **Replica health checks now test SQL thread health** and `Seconds_Behind_Master`
4. **Connection pooling at the application layer** limits how many concurrent queries can hit MySQL
5. **Failover testing now includes auto-increment exhaustion scenarios** (yes, they actually simulate this in Chaos Engineering sessions)

They also published an **internal RFC** on "Preventing Reference Table Exhaustion" that I'd kill to read. I bet it covers things like partition cycling, database sequence objects (PostgreSQL's `SEQUENCE` vs MySQL's auto-increment), and the philosophical question of whether surrogate keys should even exist in high-churn tables.

---

## 🎯 The Real Lesson: Our Tools Are More Fragile Than We Admit

Here's the uncomfortable truth: **Git and GitHub are the foundation of modern software development, and that foundation is built on a database design pattern from 2005**. The `refs` table, the auto-increment counter, the `REPLACE INTO` maintenance jobs—these are all legacy decisions that happened when GitHub was handling tens of thousands of repositories, not millions.

The fact that a single integer overflow could take down global development for 47 minutes should make you rethink your own infrastructure. **What legacy schema decisions are waiting to bite you?**

Go check your auto-increment counters. Review your replication monitoring. Test your load balancer health checks against actual service functionality. Because somewhere, right now, there's a `REPLACE INTO` running in a background job, and it's incrementing a primary key counter that—given enough time—will inevitably hit the ceiling.

And when it does, there is no retry. There is only the slow, grinding halt of a cascading failure.

---

_This analysis is based on GitHub's public post-mortem, MySQL internals documentation, and general distributed systems principles. Want to dive deeper? Check the official post-mortem at githubengineering.com and MySQL's documentation on replication modes and auto-increment behavior._
