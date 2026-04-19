---
title: "The Unthinkable Feat: Moving Terabytes of GitHub's Data, Live, With Absolutely Zero Downtime. Seriously."
shortTitle: "Live Migration of Terabytes Without Downtime"
date: 2026-04-19
image: "/images/2026-04-19-the-unthinkable-feat-moving-terabytes-of-github-s.jpg"
---

Picture this: Millions of developers globally, collaborating, committing, pushing, pulling. Every single action – from a simple `git push` to an intricate CI/CD workflow kicking off – relies on GitHub’s backend databases. Now imagine trying to move _terabytes_ of this intensely operational data, powering a real-time, high-volume service, from one set of machines to another. Not just move it, but swap out the very foundation _underneath_ a live, thrashing system, without so much as a hiccup, a dropped connection, or a perceptible pause for any of those millions of users.

Sounds like a mythical quest, right? A feat of engineering that defies gravity, time, and the very laws of distributed systems? For most, it is. But at GitHub, this isn't just a fantasy; it's a meticulously engineered reality, a testament to what's possible when you push the boundaries of database engineering.

Today, we're pulling back the curtain on the incredible, often mind-bending, strategies and technologies that allow GitHub to perform these monumental database migrations – moving entire clusters, upgrading underlying hardware, shifting data centers – all while maintaining a relentless 100% availability for developers worldwide. This isn't just about technical prowess; it's about a philosophy of continuous improvement, an obsession with reliability, and a deep understanding of the delicate dance between data, performance, and user experience.

Prepare to dive deep into the fascinating world of distributed databases, advanced replication, and the sheer computational choreography required to achieve the unthinkable.

---

## The Herculean Challenge: Why Zero-Downtime at GitHub's Scale is a Myth... Until It Isn't.

Let's be brutally honest: most database migrations involve some degree of downtime. Even a few minutes can feel like an eternity for an active service. At GitHub’s scale, where billions of interactions happen daily, even a single second of downtime is a catastrophic event, impacting global development pipelines and costing millions in lost productivity and trust.

What makes this so challenging?

- **Sheer Data Volume:** We're talking terabytes upon terabytes of constantly changing operational data. Copying it takes time, and keeping a copy in sync while the original is still being written to is a formidable task.
- **High Write Throughput:** GitHub isn't just being read from; it's being written to _constantly_. New commits, pull requests, issues, comments – a relentless stream of data modifications that must be captured and replicated.
- **Data Consistency & Integrity:** This is non-negotiable. Every bit of data must arrive at its new home perfectly intact, in the correct order, and without any corruption. Any inconsistency could break Git repositories, corrupt project history, or worse.
- **Global Reach & Latency:** GitHub serves users worldwide. Data needs to be accessible quickly, and migrations must account for network latency between potentially disparate data centers or cloud regions.
- **Complex Dependencies:** The database doesn't live in a vacuum. It underpins countless application services, caching layers, search indexes, and background jobs. All of these must flawlessly switch over to the new database source.
- **The "No Rollback" Scenario:** A migration failure without an immediate, safe rollback path is a disaster. The strategy must inherently include an escape hatch.

Overcoming these hurdles requires not just robust tools, but a deep architectural understanding and a meticulous multi-phase strategy. And for GitHub, this strategy revolves around a powerhouse combination of MySQL, Vitess, `gh-ost`, and `orchestrator`.

---

## GitHub's Database Nexus: A Primer on Their Stack's Superpowers

To understand _how_ GitHub pulls off these migrations, we first need to appreciate the ingenious architecture they've built over years of iteration and scale challenges.

### MySQL at the Core: The Unsung Workhorse

Underneath it all, powering the vast majority of GitHub’s relational data, is MySQL. While often perceived as a "simpler" database than some NoSQL counterparts for extreme scale, its maturity, transactional guarantees, and robust replication capabilities make it an ideal foundation. GitHub uses specific, battle-hardened configurations of MySQL, tuned for extreme performance and reliability.

### Vitess: The Shard Master and Orchestrator of Scale

This is where things get really interesting. Vitess, an open-source database clustering system for MySQL, originally developed at YouTube and now a CNCF project, is the absolute linchpin of GitHub's scalability and migration strategy.

**What Vitess brings to the table:**

- **Sharding:** Vitess intelligently shards GitHub's massive datasets across hundreds of MySQL instances, making individual shards manageable and performant. This horizontal scaling is critical.
- **Connection Pooling & Query Routing:** It acts as a smart proxy layer, aggregating connections, routing queries to the correct shards, and protecting MySQL instances from overload.
- **VReplication:** This is the _killer feature_ for migrations. Vitess's built-in replication engine, VReplication, is a game-changer. It can stream data changes (based on MySQL's binlog) from source to target tables, enabling:
    - **Live Resharding:** Moving data between shards without downtime.
    - **Materialized Views:** Creating custom data views.
    - **Schema Migrations:** Applying schema changes across many shards.
    - **Database Migrations:** Our topic of the day! VReplication is highly configurable, allowing for filtering, transformation, and incredibly precise control over the replication process.

Vitess doesn't just manage sharding; it provides the _primitives_ for orchestrating complex data movements and transformations across a distributed MySQL topology, all while presenting a single logical database interface to the application.

### `gh-ost`: The Silent Schema Whisperer

Schema changes on large tables are historically problematic, often requiring locks that can cause application downtime. Enter `gh-ost`, GitHub's own open-source online schema migration tool.

**How `gh-ost` works its magic:**

1.  It creates a _ghost_ table with the new schema, mirroring the original table.
2.  It uses MySQL's binary logs (binlog) to replicate changes from the original table to the ghost table.
3.  It introduces triggers on the original table to capture _new_ writes and apply them to the ghost table.
4.  Once the ghost table is fully caught up, it performs an atomic cut-over, swapping the original table with the ghost table. This switch is incredibly fast, typically milliseconds, avoiding user-visible downtime.

While `gh-ost` primarily handles schema changes, its underlying principle of logical replication and atomic cutovers is a miniature version of the larger database migration strategy. It validates the approach.

### `orchestrator`: The Conductor of Consensus

Any distributed system needs robust high-availability and failover capabilities. GitHub uses `orchestrator`, another open-source tool, for MySQL topology management, replication health monitoring, and automated failovers.

**Why `orchestrator` is crucial for migrations:**

- **Topology Awareness:** It understands the entire MySQL replication topology, including primaries, replicas, and their relationships.
- **Health Monitoring:** It constantly monitors the health and replication lag of all instances.
- **Automated Failover:** In case of a primary failure, `orchestrator` can automatically promote a healthy replica to be the new primary, minimizing downtime.
- **Planned Failovers:** Crucially for migrations, `orchestrator` facilitates _controlled_ failovers, allowing engineers to gracefully switch primary instances, which is a core component of cutting over to a new database cluster.

This combined stack – MySQL for data storage, Vitess for scalability and complex data operations, `gh-ost` for online schema changes, and `orchestrator` for high availability – forms a symbiotic ecosystem uniquely suited for pulling off these "impossible" migrations.

---

## Deconstructing the Migration Blueprint: From Planning to Permafrost (of Data)

Now, let's break down the multi-stage, zero-downtime migration process itself. This isn't a single "big bang" event; it's a carefully choreographed ballet spanning days or even weeks.

### Phase 1: The Grand Strategy & Blueprinting

Before any data moves, there's an immense amount of planning.

- **Define Objectives:** What's the goal? Hardware upgrade? Data center migration? Major MySQL version upgrade? Shard split?
- **New Architecture Design:** How will the new database cluster look? What hardware specifications, network topology, security policies, and Vitess configurations will be used? This often involves provisioning entirely new infrastructure.
- **Schema Compatibility:** A critical step. The target database's schema _must_ be compatible with the source. This might involve pre-migration schema changes using `gh-ost`.
- **Monitoring & Alerting Plan:** What metrics will be tracked? What thresholds trigger alerts? How will engineers gain visibility into every stage of the migration?
- **Rollback Strategy:** Every step of the migration must have a clearly defined, tested, and rapid rollback plan. If things go sideways, how do we revert to the previous stable state with minimal impact?
- **Runbooks & Dry Runs:** Detailed, step-by-step runbooks are created, reviewed, and practiced in staging environments. Nothing is left to chance.

### Phase 2: Preparing the Arena – Infrastructure & Baselines

This phase is about setting up the destination system, making it ready to receive a copy of the active production data.

1.  **Provision New Infrastructure:** This means spinning up new servers (physical or virtual), installing operating systems, configuring networking, and setting up the target MySQL instances. If moving to a new data center, this involves considerable network engineering.
2.  **Configure Vitess:** The new MySQL instances are brought under Vitess management, establishing new `vtgate` (proxy) and `vttablet` (agent) processes.
3.  **Initial Data Copy (Baseline):** The first massive transfer of data.
    - **Methodology:** For terabytes, a full logical dump (`mysqldump`) is often too slow and resource-intensive. Physical backups like Percona XtraBackup are preferred. It takes a consistent snapshot of the data files and replicates the last few transactions via binlogs.
    - **Restoration:** This baseline backup is restored onto the new MySQL instances in the target cluster. This creates an initial "point-in-time" copy.
    - **Establishing Replication Point:** Crucially, the exact binlog position (file and offset) at which the backup was taken is recorded. This is the starting point for continuous replication.

### Phase 3: The Replication Ballet – Keeping Pace with Chaos

This is the heart of the zero-downtime strategy: continuously syncing the new database with the old, live system.

1.  **Initiate Logical Replication:**
    - **Vitess VReplication:** GitHub primarily leverages Vitess's robust VReplication engine. A `VReplication` stream is configured to read from the binlog of the _source_ primary MySQL instance (or the source `vttablet` managing it) and apply those changes to the target MySQL instances in the new cluster.
    - **Filtering & Transformation:** VReplication allows for advanced filtering (e.g., specific tables or even rows) and data transformations on the fly, which is powerful for more complex migrations like resharding or schema changes between systems.
    - **Schema Sync:** VReplication ensures that any schema changes on the source are also propagated and applied to the target.
2.  **Managing Replication Lag:** This is where the monitoring plan kicks in. Replication lag must be constantly monitored and kept as close to zero as possible.
    - **Alerting:** Aggressive alerting on lag spikes.
    - **Throttling (Optional):** If the target can't keep up, Vitess can sometimes temporarily throttle writes on the source (a controlled slowdown) to allow the target to catch up, though this is a measure of last resort for extreme cases.
    - **Resyncing:** If lag becomes unmanageable or corruption is detected, parts of the data might need to be resynced, though this is rare with Vitess.
3.  **Idempotency & Data Integrity:** Changes are applied to the target in a way that handles potential duplicates or out-of-order delivery without causing data corruption. VReplication ensures transaction boundaries are respected.

### Phase 4: Shadow Writes & Dual Reads – Trust, But Verify (Under Fire)

This phase, while optional, provides an invaluable layer of confidence, especially for critical systems or significant architectural changes.

1.  **Shadow Writes:** The application is configured to write all new data to _both_ the old (source) database and the new (target) database.
    - **Mechanism:** This is typically implemented at the application ORM or data access layer. Writes to the new database are often asynchronous and "best effort" – failures here don't impact the user, as the old database is still the source of truth.
    - **Validation:** The primary purpose is to test the write path of the new system under full production load, identify any performance bottlenecks or unexpected errors _before_ committing. It's a dress rehearsal for the new system's write capacity.
2.  **Dual Reads (Comparison):** For selected critical queries, the application can perform reads against _both_ the old and new databases.
    - **Consistency Checks:** The results are compared. Any discrepancies indicate a potential issue in replication or the new system's data model.
    - **Performance Benchmarking:** This allows direct comparison of read latency and throughput between the old and new systems under live conditions.

This phase is about building confidence. It's like flying a plane with two engines, but one is just a "test engine" mirroring the main one, ensuring it works perfectly before you need to rely on it.

### Phase 5: The Read Switcheroo – Dipping Toes in the New Pool

Before fully committing, GitHub gradually shifts read traffic to the new database.

1.  **Canarying Reads:** A small percentage of read traffic (e.g., 1%) is routed to the new database.
    - **Routing:** This can be done via load balancers, DNS changes, or at the `vtgate` layer within Vitess.
    - **Monitoring:** Intense scrutiny of read latency, error rates, and application logs for this canary group.
2.  **Gradual Increase:** If the canary performs well, the percentage of read traffic is slowly increased (e.g., 5%, 10%, 25%, 50%, 100%).
3.  **Client-Side Caching & Retries:** Applications are designed to handle transient connection issues or brief delays during switchovers, leveraging connection pooling and retry mechanisms to mask any millisecond-level disruptions.

At this point, the new database is handling all read traffic, and it's battle-tested. The old database is still receiving writes and replicating them to the new one, serving as the ultimate fallback.

### Phase 6: The Moment of Truth – The Atomic Write Cutover

This is the most critical and delicate phase, the actual "switch" that transitions the source of truth to the new database. It needs to be fast and atomic.

1.  **Pause Application Writes (Briefly):** The ideal scenario is to bring replication lag to zero and then, for a _microsecond-level_ window, briefly pause new writes to the _old_ database. In a system like GitHub, this "pause" is often not a hard stop, but rather:
    - **Vitess Controlled:** Vitess can temporarily queue or hold writes to specific shards, or even briefly pause `vtgate` processing for the affected keyspace.
    - **Application-Level Coordination:** Some applications might briefly enter a "read-only" mode or use distributed locks, but this is often avoided in favor of transparent routing changes.
2.  **Ensure Zero Replication Lag:** Verify that the new database is 100% caught up with the old. This is paramount. Tools like `orchestrator` and Vitess's `vtctl` commands are used to confirm replication status across all shards:
    ```bash
    # Example Vitess command to check VReplication lag
    vtctlclient --server <vtgate_addr> VReplicationExec --workflow <workflow_name> --tablet_type REPLICA 'show status'
    ```
3.  **Switch Write Traffic:** This is the atomic flip.
    - **DNS Updates:** Update DNS records to point the database endpoint (the `vtgate` cluster for Vitess) to the new set of proxies connected to the new database cluster.
    - **Load Balancer Reconfiguration:** Update load balancer configurations to route traffic to the new `vtgate` instances.
    - **Vitess Topology Change:** Within Vitess, the primary `vttablet` for a keyspace/shard can be gracefully switched to point to the new physical MySQL instance. `orchestrator` can assist in orchestrating the MySQL primary switch for Vitess.
    - **Application Configuration Flip:** In some cases, application configuration pointing to the database is updated and deployed.
4.  **Resume Writes:** Once the switch is confirmed, writes are fully re-enabled and routed to the new database. The entire process, from pausing to resuming writes, is measured in milliseconds, making it imperceptible to end-users due to client-side retries and connection pooling.
5.  **Immediate Validation:** Post-cutover, automated checks immediately run to validate data integrity, application health, and performance on the new primary.

### Phase 7: Post-Migration Nirvana – Validation & Sunset

The migration isn't truly over until the old infrastructure is decommissioned.

1.  **Deep Validation:** Over the next hours and days, engineers meticulously monitor the new system, perform checksums on critical datasets, run advanced queries, and ensure all application logic is functioning perfectly.
2.  **Performance Baseline:** New performance metrics are established for the new hardware, allowing for future optimization and capacity planning.
3.  **Sunset the Old Infrastructure:** After a cooling-off period (to ensure no need for emergency rollback), the old database cluster and its associated infrastructure are gracefully decommissioned and powered down. The data is securely archived or purged.

---

## Engineering Curiosities & The Devil in the Details

Beyond the grand phases, several crucial details and engineering principles underpin GitHub’s success.

- **Network Topology & Cross-DC Migrations:** For cross-data center migrations, network latency becomes a massive factor. GitHub invests heavily in low-latency, high-bandwidth inter-DC connectivity. VReplication streams are optimized to handle network variations, and data transfer often involves parallel streams to maximize throughput.
- **Transaction Boundaries & Consistency:** Maintaining strict ACID properties during a cutover is paramount. Vitess and `orchestrator` work in concert to ensure that when a switch occurs, all in-flight transactions are either fully committed on the new primary or safely rolled back, preventing partial data writes or corruption. The binlog is the source of truth, guaranteeing order.
- **Application Awareness:** The applications themselves are designed with resilience in mind. They expect database endpoints to potentially change, have retry logic for transient errors, and often use read replicas extensively. This looseness in coupling provides robustness during state changes.
- **Observability is King:** GitHub’s monitoring stack is incredibly sophisticated. Thousands of metrics related to database health (QPS, latency, error rates, replication lag, CPU, memory, IOPS, connection counts) are aggregated, visualized, and alerted upon. Dashboards become war rooms during migrations, providing real-time insight into every shard, every replica, and every application service.
- **The Human Element & Automation:** While the process is highly automated, the coordination of multiple engineering teams (DBREs, SREs, network engineers, application developers) is crucial. Detailed runbooks ensure everyone knows their role, and automation scripts remove human error from repetitive tasks. Dry runs are not just for the machines; they're for the humans too. The confidence built through repeated, successful practice in staging environments is invaluable.
- **Gradualism and Reversibility:** These are core tenets. Every major step is broken into smaller, reversible sub-steps. No single action is irreversible without a safety net. This allows engineers to detect and fix issues early, rolling back gracefully if needed, rather than facing a "point of no return."

---

## Beyond the Terabytes: The Future of Frictionless Data Mobility

What GitHub has achieved isn't just a technical marvel; it's a paradigm shift in how we think about database operations at scale. By treating database migration as an _inherent feature_ of the infrastructure, rather than a dreaded, disruptive event, they unlock immense value:

- **Continuous Improvement:** Hardware can be upgraded, database versions patched, and architectural improvements rolled out with minimal friction. This ensures GitHub always runs on the most performant, secure, and up-to-date stack.
- **Increased Agility:** Engineers are no longer constrained by the fear of touching the database. They can iterate faster, knowing that underlying data changes can be managed safely.
- **Unwavering Reliability:** The focus on zero downtime isn't just a goal; it's a foundational promise to their users. This builds immense trust in the platform.

The journey to frictionless data mobility is ongoing. As GitHub's scale continues to explode, new challenges will undoubtedly emerge. But with a robust, flexible, and battle-tested architecture like theirs, coupled with a culture of engineering excellence, the "impossible" continues to become the routine.

Next time you push code to GitHub, take a moment to appreciate the silent, monumental dance of terabytes happening beneath your fingertips – all orchestrated with breathtaking precision, ensuring that your work, and the world's code, keeps flowing without interruption. It's not magic; it's just incredibly thoughtful, tenacious engineering. And it's awesome.
