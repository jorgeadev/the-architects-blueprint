---
title: "Beyond the Copper Ceiling: Inside Google’s Optical Alchemy for TPU v6"
shortTitle: "Google TPU v6: Breaking the Copper Ceiling with Optics"
date: 2026-08-08
image: "/images/2026/08/08/beyond-the-copper-ceiling-inside-google-s-optical-alchemy-fo.svg"
---

In the basement of every massive AI hype cycle sits a cold, hard physical reality: wires are getting too slow, too hot, and too expensive.

As we push into the era of Trillium (Google’s TPU v6), the industry is hitting a "Communication Wall." We can build chips with trillions of transistors and HBM3e memory that screams, but if you can’t move petabytes of gradients between tens of thousands of those chips in milliseconds, your shiny new AI cluster is just a very expensive space heater.

For years, the gold standard for data center networking was the **Electrical Packet Switch (EPS)**. You take a signal, turn it into electrons, buffer it, look at a header, route it, and turn it back into light. But at the scale of Google’s latest TPU pods, that process is a death sentence for performance.

Enter Google’s masterstroke: **The Optical Circuit Switch (OCS).**

With TPU v6, Google isn't just building faster chips; they are redesigning the very physics of how those chips talk. We’re talking about a hardware-software co-design that replaces traditional power-hungry switches with arrays of microscopic mirrors that move light at the speed of... well, light.

This isn't just a hardware upgrade. It’s a complete reimagining of the data center as a single, reconfigurable, optical computer. Let’s go deep.

---

## The Fatal Flaw of Electricity: Why OCS Had to Happen

To understand why Google spent years developing custom MEMS (Micro-Electro-Mechanical Systems) for their OCS, you have to understand the **O-E-O (Optical-Electrical-Optical) bottleneck**.

In a traditional network, your fiber optic cable carries data as photons. When it hits a switch, you have to:

1.  **Convert** photons to electrons using a transceiver.
2.  **Process** those electrons in a silicon switch chip (which generates massive heat).
3.  **Buffer** the data (introducing latency).
4.  **Convert** electrons back into photons to send them to the next hop.

As bandwidth scales from 400G to 800G and soon 1.6T per link, the power consumption of these O-E-O conversions is exploding. In a massive TPU pod, the switches can consume nearly **30% of the total power budget**. That is 30% of your electricity bill going toward moving data instead of computing it.

Google’s solution—code-named **Apollo** and refined for the TPU v6 era—bypasses this entirely. An OCS doesn't "read" the data. It doesn't look at headers. It simply uses tiny, steerable mirrors to physically point a beam of light from an input fiber to an output fiber.

**Zero O-E-O conversion. Near-zero power consumption for data transit. Nanosecond-level latency.**

---

## The Hardware: MEMS and the Magic of Mirror Tilting

The heart of the TPU v6 interconnect is the **Palomar OCS**. This is a custom-built chassis that looks like something out of a sci-fi movie. Inside, you won't find a massive Broadcom switching ASIC. Instead, you'll find two arrays of **MEMS mirrors**.

### How the Light Flows

Imagine an input array of 176 tiny mirrors and an output array of 176 mirrors. When TPU A wants to talk to TPU B, the control software sends a signal to the MEMS controller.

- Mirror A1 tilts to a specific angle to bounce its laser beam toward Mirror B1.
- Mirror B1 tilts to catch that beam and reflect it into the output fiber connected to TPU B.

### The Engineering Curiosity: The "Blind" Alignment Problem

Here is the catch: these mirrors are microscopic and the distances are large enough that a deviation of a fraction of a degree means the light misses the target. Unlike an electrical switch, an OCS is "transparent." It has no idea what data is flowing through it.

To solve this, Google’s engineers didn't use the data signal to align the mirrors. They use a **separate "pilot" laser** (often at a different wavelength) and a set of photodetectors to constantly monitor the alignment. The system is self-healing; it can jitter-correct in real-time to maintain the highest possible signal-to-noise ratio.

---

## The Software: Co-Design and the "Jupiter" Control Plane

Hardware is only half the story. An OCS is a **Circuit Switch**, not a **Packet Switch**. This means it doesn't handle "bursty" traffic well if you have to move mirrors every few microseconds (mirror switching takes about 10-100 milliseconds).

This is where the **Hardware-Software Co-design** shines. Google’s XLA (Accelerated Linear Algebra) compiler and the "Jupiter" network control plane work in a synchronized dance.

### 1. Topology-Aware Scheduling

In a standard data center, the network is static (usually a Fat-Tree or Clos topology). In a TPU v6 pod, the **topology is dynamic**.
If a specific training job requires a 3D-Torus configuration for optimal All-Reduce performance, the software tells the OCS to move its mirrors. Within milliseconds, the physical layout of the data center changes to match the mathematical structure of the neural network.

### 2. Failure Masking at the Speed of Software

In a massive cluster, chips die. In a traditional electrical network, a dead switch or a cut fiber can trigger a massive "re-routing" event that causes congestion across the whole cluster.
With TPU v6 and OCS, the control plane identifies a failing node and simply **patches around it** by reconfiguring the mirrors. The rest of the "pod" continues to see a perfect, contiguous logical topology. This is called **"Optical Grafting,"** and it’s why Google can maintain such high MFU (Model Flop Utilization) across months of training.

### 3. The Sparse All-to-All Breakthrough

Modern MoE (Mixture of Experts) models rely heavily on **All-to-All** communication patterns. In an electrical network, All-to-All is a nightmare; it creates "incast" congestion where many inputs scream at one output.
Google’s software co-design handles this by scheduling "circuits" in time-slices. The OCS configures a path, the TPUs blast their data, and then the OCS reconfigures for the next leg of the All-to-All. Because there is no buffering in the switch, there is **zero tail latency jitter**.

---

## The Scale: TPU v6 (Trillium) and the 100,000-Chip Dream

With TPU v6, Google has pushed the scale to a point where traditional networking would simply melt. We are looking at pods that can scale to tens of thousands of chips with a bisection bandwidth measured in **Petabits per second**.

### Why OCS makes TPU v6 different:

- **Cost:** Optical transceivers are the most expensive part of a network. Because OCS has no O-E-O in the middle, Google saves billions on transceivers at the scale of a planetary-class AI cloud.
- **Reliability:** Mechanical mirrors, surprisingly, are more reliable than high-power switching silicon. There is no heat to dissipate within the "switching fabric" itself. The Palomar switches have shown an MTBF (Mean Time Between Failure) that puts traditional routers to shame.
- **The Power "Dividend":** By saving 30% of the power on networking, Google can pump that energy back into the TPUs. This is how they achieve the massive performance-per-watt gains advertised with Trillium.

---

## Engineering Curiosities: The "Dirty" Secrets of Light

Building this wasn't all smooth sailing. There are technical "quirks" that Google’s team had to overcome, which highlight the depth of the co-design:

- **Circulators and Bi-Directional Light:** To maximize the fiber, Google uses different wavelengths for upstream and downstream traffic on the same physical fiber string. Managing the "crosstalk" between these light waves while bouncing them off a MEMS mirror requires insane precision in the coating of the mirrors themselves.
- **The "Warming" Effect:** Even though the OCS doesn't process data, the laser light itself carries energy. At Petabit scales, the cumulative energy of the photons can actually cause microscopic thermal expansion in the MEMS arrays, requiring a software-feedback loop to slightly adjust mirror angles as the pod "warms up" during a training run.
- **The SDN Controller is the King:** Unlike an Ethernet switch that runs its own routing protocols (like BGP), the OCS is "dumb." It relies entirely on a centralized Software-Defined Networking (SDN) controller. If the controller dies, the mirrors don't know where to point. Google had to build a hyper-redundant, sub-millisecond control plane to ensure the "brain" of the network never blinks.

---

## The Hype vs. The Substance

If you follow tech Twitter or LinkedIn, you've seen the hype around "Optical Interconnects" and "Silicon Photonics." Startups are raising hundreds of millions to do what Google is doing.

**The Hype:** "We will put lasers on the chip and get rid of all wires!"
**The Substance:** Putting lasers on a hot compute die is a reliability nightmare. Lasers hate heat.

**The Google Approach:** Keep the lasers in the transceivers, keep the mirrors in a separate, cool chassis, and use **Software-Defined Architecture** to link them. Google’s TPU v6 interconnect isn't just about "better tech"—it's about **pragmatic engineering**. They realized that you don't need to change the _physics_ of the chip; you need to change the _topology_ of the system.

By using OCS, Google has effectively turned their data center into a giant, modular chip. The fibers are the traces, and the OCS is the crossbar.

---

## Deep Dive: The Data Path of a TPU v6 Training Step

To truly appreciate the hardware-software co-design, let’s trace a single gradient synchronization step in a TPU v6 pod:

1.  **The Trigger:** The XLA compiler finishes a forward-backward pass. It knows it needs to perform an `All-Reduce`.
2.  **The Setup:** The "Jupiter" control plane has already pre-configured the OCS mirrors based on the known communication pattern of the model (e.g., Megatron-LM style tensor parallelism).
3.  **The Blast:** The TPU v6 chips initiate a "Direct Memory Access" (DMA) over the optical link. The data leaves the chip, enters a 1.6T transceiver, and becomes light.
4.  **The Mirror Bounce:** That light hits the Palomar OCS. It bounces off Mirror A, hits Mirror B, and is directed toward the target TPU.
5.  **The Receipt:** The target TPU receives the light, converts it back to electrons, and stores it in HBM3e.
6.  **The Reconfig:** If the next step is a "Shuffle" for an MoE layer, the Jupiter controller sends a "tilt" command to the MEMS. In 20ms, the mirrors reposition. The TPUs wait for a "Clear to Send" signal from the SDN, and then the next blast happens.

This synchronization—the fact that the compiler knows exactly when the mirrors are moving—is the definition of **Hardware-Software Co-design**. You cannot buy this off the shelf from Cisco or Arista. You have to build the compiler, the NIC, the Switch, and the Control Plane in unison.

---

## The Big Picture: Why This Matters for the Future of AI

We are rapidly approaching the limit of how much compute we can cram onto a single piece of silicon (the Reticle Limit). The future of AI isn't "bigger chips"; it's **"bigger clusters that act like a single chip."**

Google’s OCS-based interconnect for TPU v6 is the first true "Warehouse-Scale Computer" fabric. It treats the network not as a utility, but as a dynamic, programmable component of the compute pipeline.

By moving the "intelligence" of the network into the software (SDN and XLA) and the "efficiency" into the physics (MEMS and Photons), Google has created a blueprint for the next decade of AI infrastructure. While the rest of the world is struggling with the power and latency of massive electrical switch trees, Google is playing a different game—one played with mirrors, light, and a lot of very smart code.

**The result?** TPU v6 (Trillium) can train models that are orders of magnitude larger than previous generations, not just because the chips are faster, but because the light between them never has to stop for directions.
