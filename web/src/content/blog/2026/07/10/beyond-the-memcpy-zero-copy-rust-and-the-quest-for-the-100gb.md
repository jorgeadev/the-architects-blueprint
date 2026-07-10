---
title: "Beyond the Memcpy: Zero-Copy Rust and the Quest for the 100Gbps Edge"
shortTitle: "Zero-Copy Rust for 100Gbps Edge"
date: 2026-07-10
image: "/images/2026/07/10/beyond-the-memcpy-zero-copy-rust-and-the-quest-for-the-100gb.svg"
---

Imagine you’re building a high-frequency trading platform or a global content delivery network (CDN). You’ve invested in 100Gbps NICs (Network Interface Cards), your NVMe drives are screamingly fast, and your CPU has 64 cores. Yet, when you run your load tests, you hit a brick wall at 10Gbps. Your CPU is pegged at 100%, but the actual throughput is a fraction of the hardware's potential.

You look at the flame graph. The culprit? `memcpy`.

In the world of high-performance networking, the act of moving data from one memory location to another is the "silent killer." Every time the Linux kernel hands a packet to your application, and every time your application hands that packet to a library for processing, a copy operation occurs. At the scale of millions of packets per second, these copies destroy your L1/L2 cache locality, trigger TLB misses, and consume precious CPU cycles that should be spent on logic, not logistics.

This is the challenge of **Zero-Copy Networking**. In this deep dive, we’re going to explore how we can use Rust—a language designed for memory safety without a garbage collector—to architect a next-generation edge proxy that treats the Linux kernel not as a manager, but as a pass-through, achieving near-wire-speed performance.

## The Tyranny of the System Call

To understand why we need zero-copy, we have to understand why the standard way we write network code is fundamentally broken for high-throughput applications.

Traditionally, when a packet arrives at your NIC, the following happens:

1.  **Hardware Interrupt:** The NIC signals the CPU.
2.  **Kernel Handling:** The kernel driver allocates a buffer (an `sk_buff`) and copies the packet from the NIC into kernel memory.
3.  **Context Switch:** Your application calls `recv()`. The CPU switches from user-space to kernel-space.
4.  **The Great Copy:** The kernel copies the data from the `sk_buff` in kernel memory into a buffer you provided in user-space memory.
5.  **Processing:** Your application finally sees the bytes.

For a 64-byte packet (common in DNS or small API requests), the overhead of the context switch and the copy operation is often an order of magnitude larger than the actual processing of the packet. If you're aiming for 100 million packets per second (Mpps), you have exactly **10 nanoseconds** to process each packet. A single context switch can take upwards of 1,000 nanoseconds.

The math simply doesn't work. We need to bypass the kernel’s standard path.

## The Rise of Userspace Networking and AF_XDP

The industry's first answer to this was **DPDK (Data Plane Development Kit)**. DPDK completely takes over the NIC, removing it from the kernel's control and giving the application direct access to the hardware. It’s incredibly fast, but it’s a nightmare to manage. You lose the entire Linux networking stack—no more `iptables`, no more standard routing, no more `tcpdump`.

Enter **AF_XDP (Address Family eXpress Data Path)**.

AF_XDP is the "Goldilocks" solution. It’s an eBPF-powered socket that allows you to bypass most of the kernel network stack while still playing nice with the Linux ecosystem. It works by creating a shared memory area (a `UMEM`) between the kernel and the user-space application.

The NIC DMAs (Direct Memory Access) the packet directly into this shared memory. The kernel then sends a descriptor—essentially a pointer—to the user-space application. **No data is copied.** The application reads the data exactly where the hardware dropped it.

## Why Rust? The Ownership Model as a Hardware Mapping

Writing zero-copy code in C or C++ is like juggling chainsaws in a dark room. You are dealing with raw pointers to memory that the NIC might be writing to at any moment. If you access a buffer after you've told the NIC it can reuse it, you have a data race. If you forget to return a buffer to the pool, you have a memory leak that brings down your proxy in minutes.

Rust change the game. Its **ownership and lifetime systems** are not just for preventing crashes; they are the perfect abstractions for modeling hardware buffers.

### The Buffer Lifecycle in Rust

In a zero-copy system, a packet isn't just a `Vec<u8>`. It's a slice of a pre-allocated memory region. We can use Rust’s lifetimes to ensure that a packet buffer cannot be accessed once it’s been handed back to the NIC.

```rust
pub struct Packet<'a> {
    // The actual raw data in the UMEM
    data: &'a mut [u8],
    // The index of the frame in the UMEM ring
    addr: u64,
    // A reference back to the ring so we can return the buffer
    ring: &'a FillRing,
}

impl<'a> Drop for Packet<'a> {
    fn drop(&mut self) {
        // Automatically return the buffer to the NIC when the Packet goes out of scope
        self.ring.release(self.addr);
    }
}
```

In this model, the Rust compiler enforces our zero-copy constraints at compile time. If you try to store a `Packet` in a global cache without the proper lifetime annotations, the compiler will stop you. This allows us to write "fearless" high-performance code.

## Architecting the Proxy: The UMEM and Ring Buffers

To build a high-scale proxy, we need to move away from the "one thread per connection" model. We need a purely asynchronous, event-driven architecture that is **NUMA-aware**.

### 1. The UMEM Layout

The UMEM is a large, contiguous block of memory divided into "frames" (usually 2KB or 4KB each). We map this memory into our process using `mmap`.

```rust
let umem_config = xsk::UmemConfig::default();
let (umem, fill_ring, comp_ring) = xsk::Umem::new(
    umem_config,
    num_frames,
    true // Use hugepages for better TLB performance
)?;
```

### 2. The Four Rings

AF_XDP uses four circular ring buffers to communicate between the kernel and user-space:

- **Fill Ring:** User-space tells the kernel: "Here are empty buffers you can use for incoming packets."
- **RX Ring:** The kernel tells user-space: "Here are buffers containing new packets."
- **TX Ring:** User-space tells the kernel: "Here are buffers I’ve filled that you should send out."
- **Completion Ring:** The kernel tells user-space: "I’ve finished sending these buffers; you can reuse them."

### 3. Avoiding the MPSC Bottleneck

Most developers' first instinct is to use an `mpsc` (Multi-Producer, Single-Consumer) channel to move packets between threads. **Don't do this.** In a 100Gbps architecture, the synchronization overhead of a channel is a performance killer.

Instead, we use **Core Pinning** and **Lockless Rings**. Each CPU core gets its own AF_XDP socket and its own dedicated slice of the UMEM. There is no shared state between cores. This is the "Shared-Nothing" architecture popularized by ScyllaDB and Seastar.

## Technical Deep Dive: The Pinning and Memory Alignment

When dealing with zero-copy, you aren't just writing code; you're orchestrating hardware.

### The Importance of `Pin<T>`

In Rust, we often use `Pin` to ensure that data doesn't move in memory. While AF_XDP memory is usually "pinned" via the `mmap` and kernel-space locking, our user-space structures that manage these pointers must also be stable. If we move a struct that contains a pointer to the UMEM, we risk invalidating the memory addresses we've shared with the NIC.

### Hugepages and TLB Efficiency

Standard memory pages are 4KB. For a 10GB UMEM, that’s 2.5 million pages. The CPU’s Translation Lookaside Buffer (TLB) cannot cache all those mappings. By using **2MB Hugepages**, we reduce the number of entries the CPU has to track, significantly reducing the latency of memory access.

In Rust, we can use the `mmap-fixed` or `hugepages` crates to ensure our UMEM is backed by these large pages:

```rust
// Allocating 1GB of memory using 2MB Hugepages
let mem = MmapOptions::new()
    .len(1 << 30)
    .huge(HugePageSize::TwoMB)
    .map_anon()?;
```

## The Compute Scale: Parallelism without Contention

If we have 32 cores, we run 32 independent "Packet Loops." Each loop is pinned to a physical core using the `nix` or `libc` crates.

```rust
for i in 0..num_cores {
    thread::spawn(move || {
        core_affinity::set_for_current(CoreId { id: i });
        let mut worker = PacketWorker::new(i);
        worker.run();
    });
}
```

### SIMD-Accelerated Parsing

Once we have the packet in user-space via zero-copy, we still need to process it. For an edge proxy, this means parsing Ethernet, IP, and TCP/UDP headers.

Instead of parsing byte-by-byte, we use **SIMD (Single Instruction, Multiple Data)**. Using the `packed_simd` crate or the newer `std::simd` (in nightly), we can load 16 or 32 bytes of a packet header into a single register and validate the checksum or extract the destination IP in a single CPU cycle.

```rust
// Example: Using SIMD to quickly scan for a specific byte in a header
let header_chunk = u8x16::from_slice(&packet.data[0..16]);
let mask = header_chunk.lanes_eq(u8x16::splat(target_byte));
if mask.any() {
    // Process matching header...
}
```

## Handling the "Heavy Lifting": State and Logic

The proxy isn't just a pipe; it's an intelligent router. It might be doing Load Balancing (consistent hashing), Rate Limiting (Token Bucket), or TLS Termination.

### Lock-Free DashMaps

If we need shared state (like a global rate-limit counter), we avoid `Mutex<T>`. A Mutex causes "bus locking," which slows down every other core. We use lock-free data structures like `DashMap` or `crossbeam-utils`'s atomic primitives. For global counters, `AtomicU64` with `Ordering::Relaxed` is your best friend—it provides the necessary performance while maintaining eventual consistency across cores.

### The "Zero-Copy" Transformation

The real magic happens when you need to modify a packet and forward it. In a traditional stack, you'd create a new buffer, copy the payload, and swap the headers.

In our Rust-based zero-copy proxy:

1.  We receive the `Packet` struct.
2.  We use `split_at_mut()` to get a mutable reference to the header section.
3.  We modify the headers in-place.
4.  We pass the _same_ memory address to the TX ring.

The data never moves. The CPU just updates a few bytes at a specific memory address, and the NIC reads them directly.

## The Engineering Curiosity: How do we handle TCP?

AF_XDP is a raw packet interface. It gives you L2 frames. It does **not** give you TCP streams. Implementing a high-performance TCP stack in user-space is a monumental task (just ask the authors of `mtcp` or `lwIP`).

However, for an edge proxy, we often use **TCP Splicing** or **XDP Redirect**. If we determine that a flow belongs to a specific backend server, we can tell the kernel to "splice" the two sockets, or we can use BPF maps to redirect packets at the XDP level before they even reach our user-space code. This allows us to handle the "elephant flows" (large data transfers) in the kernel/hardware, while our Rust code handles the "mice flows" (complex request logic).

## Putting it all Together: The Performance Profile

When you combine AF_XDP, Rust’s ownership model, Core Pinning, and Hugepages, the performance transformation is staggering.

- **Standard Nginx/Envoy:** ~1-2 Mpps per core.
- **Rust + AF_XDP Zero-Copy:** ~10-15 Mpps per core.

At 15 Mpps, a 32-core server can handle **480 million packets per second**. That is enough to saturate a 400Gbps link with small packets—performance that was previously only possible with expensive, proprietary FPGA hardware.

## The Future: io_uring and Beyond

While AF_XDP is the current king of zero-copy networking on Linux, the horizon is shifting toward `io_uring`. Originally designed for disk I/O, `io_uring` has added `IORING_OP_SEND_ZC` (Zero Copy) and `IORING_OP_RECV_ZC` support.

The beauty of `io_uring` is that it provides a unified interface for both networking and file I/O. Imagine an edge proxy that can stream a file from NVMe to a TCP socket without the CPU ever touching the data. The kernel simply coordinates the DMA from the disk to the NIC.

Rust is uniquely positioned to dominate this future. The asynchronous nature of `io_uring` maps perfectly to `Rust's async/await` syntax, and the `tokio-uring` project is already showing how we can have high-level ergonomics with low-level performance.

## Beyond the Hype: The Reality of Implementation

Is zero-copy Rust the right choice for every project? **Absolutely not.**

It comes with significant "complexity tax":

1.  **Memory Management:** You become the garbage collector. You must manually manage the UMEM pool.
2.  **Driver Support:** AF_XDP requires modern kernels (5.4+) and drivers that support "Zero-copy mode" (like `i40e`, `ixgbe`, or `mlx5`).
3.  **The "Unsafe" Reality:** To interface with AF_XDP and `mmap`, you will have to use `unsafe` blocks. Rust doesn't eliminate `unsafe`; it allows you to encapsulate it behind a safe, robust API.

However, for the infrastructure that powers the next generation of the internet—the edge proxies, the firewalls, the 5G core networks—the "complexity tax" is a small price to pay for a 10x increase in efficiency.

## The New Standard

The era of "fast enough" networking is ending. As we push toward 400Gbps and 800Gbps data centers, the bottleneck is no longer the wire; it’s the way we handle memory.

By leveraging Rust’s type system to enforce zero-copy semantics, we aren't just writing faster code; we’re writing more reliable infrastructure. We’re moving from an era where we "copy and pray" to an era where the hardware and the software exist in a perfectly synchronized, zero-copy dance.

If you’re still `memcpy`-ing your packets in 2024, you’re leaving 90% of your hardware performance on the table. It’s time to get closer to the metal. It’s time for Zero-Copy Rust.
