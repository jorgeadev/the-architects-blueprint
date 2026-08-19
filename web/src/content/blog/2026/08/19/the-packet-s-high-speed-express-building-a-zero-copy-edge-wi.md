---
title: "The Packet’s High-Speed Express: Building a Zero-Copy Edge with eBPF and XDP"
shortTitle: "Zero-Copy Edge Networking with eBPF and XDP"
date: 2026-08-19
image: "/images/2026/08/19/the-packet-s-high-speed-express-building-a-zero-copy-edge-wi.svg"
---

Imagine you’re standing at the gates of a stadium. Every second, 100,000 people arrive. Your job is to check their tickets, verify their identity, and point them to their seats. If you take five seconds per person, the line wraps around the block, a riot breaks out, and the stadium remains empty.

Now, imagine that instead of people, these are packets. And instead of 100,000, there are 100 million. Every second.

This is the reality of the Cloudflare edge network. At our scale, the traditional way the Linux kernel handles networking—the way it’s been doing it for thirty years—isn't just slow; it’s a physical bottleneck. When you're processing hundreds of terabits per second across a global fleet, the "Linux Tax"—the CPU cycles spent moving data from the network card to the kernel and then to the application—becomes an existential threat to performance.

To solve this, we’ve moved beyond the traditional stack. We’ve embraced a world of **Zero-Copy Data Planes**, leveraging the combined power of **eBPF (Extended Berkeley Packet Filter)** and **XDP (Express Data Path)**. This isn't just a marginal improvement; it’s a fundamental architectural shift that allows us to process packets at line rate, dropping malicious traffic before the CPU even breaks a sweat.

## The Bottleneck: The Heavyweight History of `sk_buff`

To understand why we needed a zero-copy revolution, we have to look at the "Old Way."

In a standard Linux networking stack, when a packet arrives at the Network Interface Card (NIC), a lot of complex machinery kicks in. The NIC triggers an interrupt, the driver allocates a data structure called an `sk_buff` (socket buffer), and the packet data is copied into kernel memory.

The `sk_buff` is the "Swiss Army Knife" of Linux networking. It contains everything: metadata for routing, firewalling (iptables), NAT, tunneling, and more. It is a massive, heavy structure. For a simple 64-byte packet, the metadata overhead of an `sk_buff` can be hundreds of bytes.

As that packet moves through the stack, the kernel performs:

1.  **Memory Allocations:** Constant `kmalloc` and `kfree` cycles.
2.  **Context Switching:** Moving the packet from Kernel Space to User Space (where your application lives).
3.  **Data Copying:** Physically moving bits from one memory address to another so the application can read them.

At 10Gbps, you might get away with this. At 100Gbps, the CPU spends more time managing the "bureaucracy" of the packet (the `sk_buff`) than actually processing the data. We call this the **Interrupt Storm**. If your CPU is 100% busy just moving data, it has 0% left to actually _do_ something with that data.

## Enter XDP: The First Responder at the Edge

If the traditional Linux stack is a multi-story office building with a slow elevator, **XDP (Express Data Path)** is the VIP fast-track at the front door.

XDP is a framework within the Linux kernel that allows us to run eBPF bytecode directly at the lowest possible level: the network driver itself. The moment the NIC receives a packet, before the kernel even thinks about creating an `sk_buff`, our XDP program runs.

### The XDP Hook Points

XDP works by intercepting the packet in the "RX ring" of the driver. It gives the developer four choices for every packet:

- **XDP_DROP:** Trash the packet immediately. This is our primary weapon against DDoS attacks.
- **XDP_PASS:** Pass it up to the normal Linux stack (for traffic we don't need to optimize).
- **XDP_TX:** Reflect the packet back out of the same interface (useful for load balancing).
- **XDP_REDIRECT:** Send the packet to a different NIC or, more importantly, to a specialized user-space socket via **AF_XDP**.

By making these decisions in the driver, we bypass almost the entire kernel networking stack. The performance gains are staggering. We can process millions of packets per second (Mpps) per CPU core because we’ve eliminated the overhead of the `sk_buff`.

## The Holy Grail: Zero-Copy via AF_XDP

While XDP is great for dropping or redirecting traffic, we still need to get some packets to our user-space applications (like our HTTP proxy, _Pingora_). Traditionally, this meant another copy operation.

This is where **AF_XDP** (Address Family XDP) comes in. It is the "Zero-Copy" magic bullet.

### How AF_XDP Achieves Zero-Copy

In a standard socket, the kernel owns the memory. In an AF_XDP setup, the **User Space and the Kernel share a memory region called a UMEM.**

The UMEM is a contiguous block of memory divided into "frames." We set up four circular buffers (rings) that manage the handoff of these frames:

1.  **Fill Ring:** User space tells the kernel which UMEM frames are ready to be filled with incoming data.
2.  **RX Ring:** The kernel tells user space which frames have been filled with new packets.
3.  **TX Ring:** User space tells the kernel which frames are ready to be sent out.
4.  **Completion Ring:** The kernel tells user space it has finished sending the data from a frame.

**Here is the kicker:** The data never moves. The "copying" is actually just passing a pointer (a descriptor) between the kernel and user space. The packet lands in the UMEM via DMA (Direct Memory Access) from the NIC, and the application reads it directly from that same spot.

**Zero copies. Zero context switches. Pure speed.**

---

## Architecture: A Deep Dive into the Flow

Let's look at how this looks in a production environment at Cloudflare. We aren't just running one script; we’re running a complex, tiered defense and processing system.

### 1. The L4Drop Defense

Every packet first hits our **L4Drop** program. This is an XDP-based firewall. It queries a high-speed eBPF map (a specialized hash table) containing millions of rules generated by our automated DDoS detection systems.

- If a packet matches a "drop" signature, it’s discarded in nanoseconds.
- No memory is allocated. No interrupts are sent to the upper layers of the OS.

### 2. Unimog: The Programmable Load Balancer

If the packet survives the firewall, it might hit **Unimog**, our internal load balancer. Using XDP, Unimog inspects the packet headers and decides which internal server should handle the request. It can use `XDP_TX` to hair-pin the packet back out to the network with a modified destination MAC address, effectively routing traffic without the packet ever "entering" the host system in a traditional sense.

### 3. AF_XDP Hand-off

For traffic destined for our application layer, the packet is redirected via an AF_XDP socket.

```c
// A simplified look at an XDP program redirecting to a socket
SEC("xdp")
int xdp_sock_prog(struct xdp_md *ctx) {
    int index = bpf_get_smp_processor_id();

    // Check if there is an AF_XDP socket bound to this queue
    if (bpf_map_lookup_elem(&xsks_map, &index)) {
        return bpf_redirect_map(&xsks_map, index, 0);
    }

    return XDP_PASS;
}
```

The `bpf_redirect_map` call is the critical link. It tells the kernel: "Don't build an `sk_buff`. Just put this packet into the UMEM frame associated with this socket map."

## Technical Substance: Why This is Hard

If it were easy, everyone would do it. Building a zero-copy data plane involves tackling some of the most difficult problems in systems engineering.

### The Memory Alignment Nightmare

When you are dealing with zero-copy, you are managing memory yourself. You have to ensure that your packet buffers are correctly aligned with the CPU’s cache lines (usually 64 bytes). If a packet header straddles two cache lines, you suffer a performance penalty. We spend a significant amount of time optimizing the layout of our UMEM to ensure "cache-locality."

### The Verifier: The Strict Headmaster

eBPF is safe because it is verified. Before an eBPF program is allowed to run, the kernel "proves" that it won't crash, it won't loop infinitely, and it won't access unauthorized memory.
Writing complex logic (like parsing nested tunnels or GRE headers) within the constraints of the eBPF verifier is an art form. You often have to "hint" to the verifier that you’ve checked the bounds of a packet:

```c
void *data_end = (void *)(long)ctx->data_end;
void *data = (void *)(long)ctx->data;

struct ethhdr *eth = data;
if ((void *)(eth + 1) > data_end) // This check is MANDATORY for the verifier
    return XDP_DROP;
```

Without that `if` check, the kernel will refuse to load the program. This adds safety but requires a shift in how engineers write code.

### The "Head-of-Line" Blocking of the CPU

Even with XDP, if you have one CPU core handling all interrupts from a 100GbE NIC, that core will saturate. We use **RSS (Receive Side Scaling)** to distribute incoming packets across multiple CPU queues, each with its own XDP program and AF_XDP socket. This allows us to scale networking performance linearly with the number of CPU cores.

---

## Why the Hype is Justified (and Why it’s Not Just Hype)

There’s a lot of buzz around eBPF right now. Some call it the "JavaScript of the Kernel." While the hype is loud, the technical substance is transformative.

The reason eBPF/XDP is gaining so much attention isn't just because it's fast—it's because it's **programmable without sacrifice.**

Historically, if you wanted this kind of performance, you had to use **DPDK (Data Plane Development Kit)**. DPDK is a set of libraries that completely bypasses the kernel, taking total control of the NIC.

**But DPDK has massive downsides:**

- **No Kernel Integration:** You lose `tcpdump`, `iptables`, and standard routing. You have to rewrite the entire networking stack in user space.
- **Busy Polling:** DPDK cores stay at 100% CPU usage even when there is no traffic, because they are constantly "polling" the NIC for data.
- **Security:** If your DPDK app crashes, your entire network interface is dead.

**XDP is the "Best of Both Worlds."** It gives us DPDK-like performance (zero-copy, bypass) while remaining _inside_ the kernel ecosystem. We can still use `iproute2` to manage interfaces, and if our XDP program doesn't handle a packet, we can simply `XDP_PASS` it to the standard kernel stack as a fallback.

It’s safety and speed in a single package.

## The Engineering Curiosity: JIT and Hardware Offloading

One of the most fascinating aspects of this stack is the **Just-In-Time (JIT) Compiler**. When we load our eBPF bytecode, the kernel translates it into native x86 or ARM64 machine instructions. This means our packet-processing logic runs at the same speed as code compiled into the kernel itself.

Furthermore, we are now looking at **XDP Hardware Offloading**. Some modern NICs (like those from Netronome or NVIDIA/Mellanox) can actually run eBPF code _on the network card's own processor_.

Think about that: the packet never even reaches the host CPU. The NIC itself runs the eBPF bytecode, decides the packet is part of a DDoS attack, and drops it. The host CPU never even knows the packet existed. This is the ultimate "Zero-Copy" because the data never even enters the system RAM.

## Real-World Impact: The Numbers

At Cloudflare, moving to an eBPF/XDP-centric data plane has yielded dramatic results:

- **DDoS Resilience:** We can process over 100 million packets per second on a single commodity server during an attack.
- **Latency:** By bypassing the `sk_buff` and the complex kernel stack, we’ve reduced the "time-to-first-byte" for our edge services by significantly reducing the jitter caused by interrupt processing.
- **Efficiency:** We can handle the same amount of traffic with fewer servers, reducing our power consumption and hardware footprint—a critical factor in the efficiency of our 310+ global data centers.

## Pushing the Boundaries

Building a zero-copy data plane with eBPF and XDP is like building a high-speed rail system while the trains are already running at 300 mph. It requires a deep understanding of CPU architecture, memory management, and the internal guts of the Linux kernel.

We’ve moved from a world where the kernel was a black box to a world where the kernel is a programmable sandbox. The "Linux Tax" is being repealed, one packet at a time.

As we look toward the future—with 400GbE interfaces on the horizon and the continued rise of resource-intensive protocols like QUIC—the ability to process data without moving it is no longer a luxury. It is the foundation of the modern internet.

We’re not just passing packets anymore; we’re orchestrating them at the speed of light, ensuring that the stadium gates stay wide open, no matter how many millions of people are trying to get in.

---

### Technical Deep-Dive Checklist for the Curious

- **UMEM:** The shared memory space between User and Kernel.
- **Descriptor Rings:** The lockless queues (Fill, RX, TX, Completion) that manage packet ownership.
- **Memory Barriers:** The low-level CPU instructions used to ensure that the kernel and user space see memory updates in the correct order.
- **BTF (BPF Type Format):** The metadata that allows eBPF programs to understand kernel structures across different kernel versions (Compile Once, Run Everywhere).
- **XDP_FLAGS_DRV_MODE:** Forcing XDP to run in the driver for maximum performance vs. SKB mode (generic).

The edge is getting faster, and with eBPF and XDP, we’re the ones holding the throttle.
