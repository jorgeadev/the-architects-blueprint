---
title: "The Physics of Video Egress: How Netflix Pushed io_uring and XDP to 1.5 Tbps per Node"
shortTitle: "Scaling Netflix Video Egress to 1.5 Tbps via io_uring and XDP"
date: 2026-06-20
image: "/images/2026/06/20/the-physics-of-video-egress-how-netflix-pushed-io-uring-and-.jpg"
---

Imagine every single person in a major metropolitan city—let’s say, Chicago—deciding to watch a 4K stream of _Stranger Things_ at the exact same moment. To make that happen, you aren’t just looking at a software problem; you are looking at a fundamental battle against the physics of silicon, electricity, and the Linux kernel.

At Netflix, this isn't a "what-if" scenario. It is the baseline reality for the Open Connect team. To keep up with global demand, the goal has always been to push more bits out of fewer boxes. We recently crossed a threshold that was once considered theoretically impossible for a single commodity server: **1.5 Terabits per second (Tbps) of encrypted video egress.**

Achieving this required more than just "optimizing code." It required us to fundamentally rethink how data moves from an NVMe drive to a network interface card (NIC). We had to bypass the very heart of the operating system—the Linux kernel—using a combination of **io_uring**, **AF_XDP**, and a relentless focus on **NUMA-aware mechanical sympathy.**

This is the story of how we broke the 1.5 Tbps barrier.

---

### The Bottleneck: Why the Kernel is Too Slow

To understand the solution, we first have to understand why the traditional Linux networking stack is the enemy of high-throughput egress.

In a standard Linux environment, when a web server wants to send a file over a socket, the process looks something like this:

1.  **Syscall:** The application calls `sendfile()` or `write()`.
2.  **Context Switch:** The CPU switches from user-space to kernel-space. This involves flushing TLBs (Translation Lookaside Buffers) and moving execution context—a "heavy" operation in CPU cycles.
3.  **Data Copying:** The kernel must manage the data, often involving copies between user-space buffers and kernel-space socket buffers (`sk_buff`).
4.  **The Stack:** The data travels through the generic networking stack (TCP/IP), which is designed for versatility, not raw speed. It handles firewalls, routing, and complex state machines that we simply don't need for a high-performance CDN node.
5.  **Interrupts:** For every packet or batch of packets sent, the hardware triggers interrupts, forcing the CPU to stop what it's doing and handle the I/O.

At 10 Gbps, this overhead is negligible. At 100 Gbps, it’s a nuisance. At **1.5 Tbps**, the kernel becomes a brick wall. The "Interrupt Storm" alone would consume 100% of the CPU cycles just managing the metadata of the packets, leaving zero room for actually serving video.

### The Physics of the Machine: PCIe and NUMA

Before we touch the software, we have to talk about the hardware. A 1.5 Tbps node is a beast of a machine, typically featuring Dual AMD EPYC or Intel Xeon Scalable processors and multiple 400GbE NICs.

But here’s where the "physics" comes in. Data doesn't just "exist" on a motherboard; it has to travel across the **PCIe bus**.

- **PCIe Gen 5 x16** provides roughly 512 Gbps of theoretical bandwidth.
- To hit 1.5 Tbps, we need multiple 400GbE NICs and a massive array of NVMe drives.

The killer at this scale is **NUMA (Non-Unified Memory Access)**. If your NVMe drive is connected to CPU Socket 0, but your NIC is connected to CPU Socket 1, every bit of video data must travel across the **AMD Infinity Fabric** or **Intel UPI** link between sockets. This inter-socket link is a massive bottleneck.

To achieve 1.5 Tbps, we treat the server not as one machine, but as two independent halves. We ensure that the data read from a specific NVMe drive stays on the same NUMA node as the NIC that will eventually egress it. **Cross-talk is the enemy of throughput.**

---

### Enter io_uring: Asynchronous Mastery

The first piece of our 1.5 Tbps puzzle is **io_uring**. Created by Jens Axboe, io_uring changed the game for I/O in Linux.

Traditionally, I/O is blocking. You ask for a file, and you wait. Even with `epoll` and non-blocking I/O, you are still constantly making system calls. **io_uring** eliminates the syscall overhead by using two ring buffers shared between the kernel and user-space:

1.  **Submission Queue (SQ):** The application places I/O requests here.
2.  **Completion Queue (CQ):** The kernel places the results here.

The magic? **No syscalls are required to submit or collect I/O once the rings are established.** We can "batch" thousands of read/write requests and the kernel picks them up automatically.

For Netflix, this means we can trigger massive reads from NVMe storage into memory without the CPU ever leaving user-space. By using the `IORING_SETUP_SQPOLL` flag, we can even have a dedicated kernel thread polling the queue, allowing our application to be truly "asynchronous."

```c
// Simplified io_uring submission for video blocks
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, fd, buffer, BUF_SIZE, offset);
sqe->user_data = MY_VIDEO_BLOCK_ID;
io_uring_submit(&ring);
```

### Bypassing the Stack with AF_XDP

While io_uring solved our storage I/O bottleneck, we still had the networking problem. Even with `sendfile()`, the kernel’s TCP stack is too heavy. This is where **XDP (eBPF Express Data Path)** and **AF_XDP** come in.

XDP allows us to run a custom eBPF program directly in the NIC driver, before the packet even reaches the Linux kernel stack. **AF_XDP** is a specialized socket address family that allows us to redirect those packets directly into user-space memory (the "UMEM").

By using AF_XDP in **Zero-Copy mode**, the NIC hardware places the packet data directly into a memory buffer that our application can access. No `sk_buff` allocation, no context switching, and no TCP stack overhead.

We essentially treat the NIC like a high-speed ring buffer. We are no longer "sending packets" in the traditional sense; we are managing a massive circular buffer of memory that the hardware and software share.

### The Secret Sauce: kTLS and Inline Encryption

You might be wondering: "If you bypass the kernel, how do you handle encryption?"

Netflix streams are encrypted via TLS. Traditionally, encryption happens in user-space (OpenSSL). But at 1.5 Tbps, encrypting data in software would melt the CPUs.

Our architecture leverages **kTLS (Kernel TLS)**, but with a twist: **Hardware Offload.**
Modern 200GbE and 400GbE NICs (like the Mellanox ConnectX-6 or 7) support **Inline TLS**.

The workflow looks like this:

1.  The application tells the NIC the TLS keys for a specific flow.
2.  The application sends _plaintext_ data to the NIC via AF_XDP/io_uring.
3.  The **NIC hardware** encrypts the data on-the-fly as it hits the wire.

This is a massive win. The CPU never has to touch the encrypted bits. It only manages the "orchestration" of the data movement.

---

### Orchestrating the Flow: The Zero-Copy Pipeline

To hit 1.5 Tbps, we had to stitch these technologies into a unified pipeline. We call it the "Zero-Copy Video Path."

#### 1. The Request Phase

A client requests a chunk of a movie. Our user-space server (built on an asynchronous event loop) determines which NVMe drive holds that data.

#### 2. The Storage Phase (io_uring)

We submit a read request via **io_uring**. Because we use `O_DIRECT`, the data is read directly from the NVMe disk into a pre-allocated "Super Buffer" in memory. This buffer is aligned to the memory pages of the specific NUMA node.

#### 3. The Framing Phase

Once the data is in memory, we don't copy it. We simply wrap it in the necessary headers (Ethernet, IP, TCP). Since we are using AF_XDP, we manually construct these headers in user-space. While this sounds like a lot of work, it is actually faster because we can pre-calculate 90% of the header once and just update the sequence numbers.

#### 4. The Egress Phase (AF_XDP + kTLS)

We hand the buffer address to the **AF_XDP** ring. The NIC's DMA (Direct Memory Access) engine pulls the data directly from our "Super Buffer." As it leaves the NIC, the hardware TLS engine encrypts the payload.

**Total copies: Zero.**
**Total syscalls: Zero (in the steady state).**

---

### The Engineering Challenges: What Went Wrong?

You don't just turn on io_uring and get 1.5 Tbps. We hit several "physical" limits during development:

**1. PCIe TLP Payloads:**
We noticed that throughput would plateau even when CPU usage was low. It turned out we were hitting the limit of **TLP (Transaction Layer Packet)** efficiency on the PCIe bus. By tuning the `Max_Payload_Size` (MPS) and `Max_Read_Request_Size` (MRRS) of the PCIe devices, we were able to squeeze out an extra 15% of bandwidth.

**2. Cache Line Contention:**
When multiple CPU cores are trying to update the same AF_XDP ring buffer, they fight over "ownership" of the cache line. This causes "Cache Coherency Traffic" across the CPU, which slows everything down. We solved this by implementing **Core-Local Queues**. Each CPU core gets its own dedicated io_uring and AF_XDP instance, pinned to its own hardware queue on the NIC. No sharing, no locking, no contention.

**3. The "Slow" Speed of Light:**
At 1.5 Tbps, the timing of packet pacing becomes critical. If you "burst" too many packets at once, you overflow the buffers of the downstream switches. We had to implement a user-space **Packet Pacer** that uses the high-resolution TSC (Time Stamp Counter) of the CPU to "trickle" packets onto the wire at a precise rate, avoiding congestion collapse.

---

### Why This Matters for the Industry

The work we've done to bypass the kernel isn't just about Netflix. It represents a paradigm shift in systems engineering. For decades, the Operating System was the gatekeeper of the hardware. But as hardware speeds have moved from 1Gbps to 400Gbps, the OS has become a bottleneck—a "Tax" that we can no longer afford to pay.

By using **io_uring** and **XDP**, we are moving toward a "User-space OS" model where the kernel provides the security and isolation, but the application manages the raw throughput.

#### The Metrics of Success:

- **Old Stack:** 200 Gbps per node at 90% CPU utilization.
- **New Stack (io_uring + XDP):** 1.5 Tbps per node at 50% CPU utilization.

We didn't just increase the speed by 7.5x; we did it while making the system _more_ efficient. This allows us to put more content closer to users, reduce the power footprint of our data centers, and ultimately, ensure that your Friday night movie marathon never suffers a "buffering" wheel.

### The Road to 2 Tbps

Is 1.5 Tbps the limit? Not even close. With the arrival of **PCIe Gen 6** and **CXL (Compute Express Link)**, the "Physics of Egress" will shift again. CXL will allow even tighter integration between the CPU, memory, and the NIC, potentially allowing the NIC to access CPU cache directly without even touching the main RAM.

We are already looking at architectures that could push us toward 2 or 3 Tbps. At that point, the bottleneck won't be the software or the bus—it might literally be the ability of the fiber optic cables to dissipate the heat of so many photons.

But for now, the combination of a lean Linux kernel, the raw power of io_uring, and the surgical precision of XDP has turned our servers into the fastest video delivery machines on the planet.

**The kernel isn't dead—it just needs to get out of the way.**
