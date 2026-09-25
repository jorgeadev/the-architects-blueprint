---
title: "The Thermal Wall and the Silicon Spine: Inside Google’s Jupiterean Consolidation"
shortTitle: "Google’s Infrastructure Consolidation: Solving Scaling and Thermal Limits"
date: 2026-09-25
image: "/images/2026/09/25/the-thermal-wall-and-the-silicon-spine-inside-google-s-jupit.svg"
---

For the last decade, the mantra of the hyperscale datacenter was "homogeneity is king." You built rows of identical racks, filled them with identical x86 servers, and let the software layer (Borg, in Google’s case) figure out how to abstract the mess away. It was clean, it was predictable, and it was—frankly—becoming a bottleneck.

As we pivoted into the era of Large Language Models (LLMs) and massive-scale generative AI, the "standard rack" died. We hit a wall where power density, networking latency, and thermal limits converged into a singular engineering crisis. You can’t train a Gemini-class model on a fragmented collection of pizza-box servers connected by legacy copper.

Google’s response wasn't just to build a bigger fan or a faster chip. It was a fundamental architectural shift known as **Jupiterean Consolidation**. By merging heterogeneous CPU and TPU pools into a singular, optically-switched fabric and solving the resulting "kilowatt-per-sq-ft" nightmare with chemically-etched, liquid-cooled rear-door heat exchangers (RDHXs), Google has effectively turned the entire datacenter into a single, cohesive supercomputer.

Let’s go under the floor tiles and see how they did it.

---

## The Death of the Pod: Moving to Heterogeneous Fabric

In the old world, you had "TPU Pods" and "Compute Clusters." They lived in different parts of the building, often separated by several network hops. If a TPU needed to fetch data from a Spanner database sitting on a CPU cluster, it had to traverse multiple layers of the hierarchy, introducing tail latency that kills training efficiency.

**Jupiterean Consolidation** changes the topology. Instead of discrete islands, Google has moved to a **disaggregated, heterogeneous architecture**.

### 1. The Jupiter Direct-Connect Fabric

At the heart of this is the **Jupiter** network. While the industry was busy arguing about InfiniBand vs. Ethernet, Google built their own path using **Optical Circuit Switches (OCS)**, codenamed _Apollo_.

The magic of Apollo OCS is that it doesn't "route" packets in the traditional, power-hungry sense. It uses MEMS (Micro-Electro-Mechanical Systems) mirrors to physically steer beams of light between fibers.

- **Zero-latency switching:** Once the mirror is set, the data moves at the speed of light through glass with virtually no electrical overhead.
- **Dynamic Topology:** If a training job needs 4,000 TPU v5p chips to talk to 1,000 CPU nodes for preprocessing, Jupiter can physically reconfigure the network patch panel in milliseconds to create a direct optical path.

### 2. Mixed-Resource Scheduling

By placing TPUs (Tensor Processing Units) and CPUs on the same optical spine, Google can now create "Heterogeneous Pools." A single job in Borg (Google’s cluster manager) can request a slice of a "Jupiterean block" that looks like this:

```protobuf
// A simplified representation of a Jupiterean Resource Request
job_spec {
  name: "gemini-ultra-train"
  resource_requirement {
    tpu_v5p_count: 8192
    cpu_cores: 16384 // High-perf ARM-based Axion cores
    local_ssd_petabytes: 2.5
    interconnect_bandwidth_gbps: 3200
    topology: "torus_linked_mesh"
  }
  placement_constraint: "JUPITER_FABRIC_ZONE_7"
}
```

This consolidation allows for **synchronous data augmentation**. In traditional setups, the CPU prepares the data, sends it over the network, and the TPU waits. In the Jupiterean model, the CPU and TPU share a "near-memory" proximity over the optical fabric, reducing the "stall time" of the AI accelerators to near zero.

---

## The Density Problem: When Racks Start Melting

The move to heterogeneous pools sounds great on paper, but physics has a vote. A standard datacenter rack is designed for roughly 15kW to 20kW of power. A single modern AI server—packed with 8 TPUs or H100s—can pull 10kW alone. When you consolidate these into "super-nodes" to minimize latency, you end up with racks demanding **100kW to 300kW**.

At 300kW, air cooling is no longer a physical possibility. You could blast the rack with a jet engine's worth of air, and the silicon would still hit thermal throttling within seconds. The heat flux is simply too high for air molecules to carry away.

This is where the **Chemically-Etched, Liquid-Cooled Rear-Door Heat Exchanger (RDHX)** enters the frame.

### The Physics of the Microchannel

Google’s latest thermal solution isn't just a radiator bolted to the back of a rack. It’s a masterpiece of fluid dynamics.

Standard heat exchangers use copper pipes with fins. They are bulky and have high thermal resistance. To achieve the density required for Jupiterean compute, Google engineers turned to **Photochemical Machining (PCM)**—the same process used to create intricate medical devices or aerospace components.

By chemically etching microchannels into cold plates and heat exchanger cores, they can create a vastly higher surface-area-to-volume ratio.

- **The "Waffle" Effect:** The etching creates a complex, non-linear path for the coolant (usually a water-glycol mixture). This ensures the flow stays **turbulent** (high Reynolds number) rather than laminar. Turbulent flow is significantly better at "scrubbing" heat away from the metal walls.
- **Low Pressure Drop:** Despite the complexity of the channels, the chemical etching allows for "manifold-style" distribution that keeps the pressure drop low, meaning the pumps don't have to work as hard (improving PUE).

### Why the Rear Door?

While some companies are experimentating with "Immersion Cooling" (dunking servers in mineral oil), Google has doubled down on the **Rear-Door Heat Exchanger**.

1.  **Serviceability:** You can still open the door and swap a failed DIMM or a faulty NIC without getting oil on your shoes.
2.  **Room Neutrality:** The RDHX is so efficient that the air leaving the rack is actually _cooler_ than the air entering it. The rack becomes a "carbon-negative" heat source for the room. The liquid loop captures ~95% of the heat before it ever enters the datacenter floor.

---

## Inside the Silicon: TPU v5p and the Interconnect

The "Jupiterean" shift isn't just about the network and the plumbing; it’s about the silicon that facilitates this density. The **TPU v5p** is the crown jewel of this consolidation.

Each TPU v5p pod consists of 8,960 chips interconnected in a 3D torus topology. But in the consolidated model, these pods aren't isolated. They are "pluggable" into the Jupiter OCS.

### The ICI (Inter-Core Interconnect)

The TPU v5p uses a proprietary **Inter-Core Interconnect (ICI)** that runs at speeds exceeding 4,800 Gbps per chip. When you have thousands of these chips in a single pool, the "East-West" traffic is staggering.

The Jupiterean consolidation allows Google to use **Optical Direct Connect** for the ICI. Instead of converting electrical signals to optical at every switch jump, the TPU’s ICI signals can stay in the optical domain for longer stretches, thanks to the OCS. This drastically reduces the power consumption of the "networking tax" that usually plagues large-scale AI.

| Metric                     | TPU v4 (Previous Gen) | TPU v5p (Jupiterean Era) |
| :------------------------- | :-------------------- | :----------------------- |
| **Peak FLOPs (bf16)**      | 275 Tflops            | 459 Tflops               |
| **HBM Capacity**           | 32 GB                 | 95 GB                    |
| **Interconnect Bandwidth** | 1,600 Gbps            | 4,800 Gbps               |
| **Cooling Method**         | Air/Hybrid            | Advanced Liquid RDHX     |

---

## The Engineering Curiosity: The "Chem-Etch" Secret Sauce

Why go through the trouble of chemical etching? It sounds expensive, and it is. But when you look at the **Thermal Resistance ($\theta$)** equation, the reasoning becomes clear:

$$\theta = \frac{L}{k \cdot A}$$

Where:

- $L$ is the thickness of the material.
- $k$ is thermal conductivity.
- $A$ is the surface area.

In a standard rack, $A$ (surface area) is limited by the physical size of the pipes. By using chemical etching, Google can create a "fractal" surface area within a plate that is only a few millimeters thick. They are essentially maximizing $A$ while minimizing $L$, driving the thermal resistance to near-theoretical limits.

This allows them to run the coolant at higher temperatures (e.g., 27°C to 32°C). This might sound counterintuitive—wouldn't you want ice-cold water? No. By using **warm-water cooling**, Google can eliminate the need for massive, energy-sucking mechanical chillers. They can use simple cooling towers (evaporative cooling), which is the primary reason Google’s datacenters maintain a PUE (Power Usage Effectiveness) of ~1.10 while the rest of the industry struggles at 1.5.

---

## Software-Defined Infrastructure: The "Borg" Evolution

You can’t manage this level of complexity with a static configuration. The Jupiterean consolidation requires a software layer that is aware of the **thermal and optical topology** of the datacenter.

Google updated Borg to include **Thermal-Aware Placement**. If a specific row of RDHXs is reporting a slight increase in "Approach Temperature" (the delta between the liquid and the air), Borg can dynamically migrate non-critical background tasks to a different part of the Jupiterean fabric or throttle the TPU clock speeds in that specific zone to prevent a "thermal runaway" event.

### The Code of Scale

Consider a simplified scheduler logic that handles this:

```python
def place_workload(job):
    # Find nodes with the required TPU/CPU ratio on the Jupiter Spine
    candidate_nodes = jupiter_fabric.query_resources(
        type=["TPU_V5P", "AXION_CPU"],
        min_bandwidth=job.bandwidth_req
    )

    # Filter by thermal headroom of the RDHX system
    optimized_nodes = []
    for node in candidate_nodes:
        rack_thermal_load = cooling_system.get_rack_load(node.rack_id)
        if rack_thermal_load + job.thermal_impact < MAX_RDHX_CAPACITY:
            optimized_nodes.append(node)

    # Instruct Apollo OCS to steer the optical beams
    ocs_controller.reconfigure_topology(optimized_nodes)

    return borg.allocate(optimized_nodes, job)
```

---

## Why This Matters: The New Moat

There has been a lot of hype around "sovereign AI" and building your own clusters. But the technical substance behind Google’s Jupiterean Consolidation reveals the massive "infrastructure gap" that exists.

Building a cluster of GPUs is easy. Building a **Warehouse-Scale Computer** where 100,000+ heterogeneous cores act as a single, liquid-cooled, optically-switched organism is an entirely different level of engineering.

### 1. Economics of Density

By consolidating resources, Google reduces "stranded capacity." In a siloed datacenter, you might have 20% of your CPUs sitting idle while your TPUs are oversubscribed. In the Jupiterean model, that 20% is on the same fabric and can be instantly repurposed for TPU preprocessing or embeddings.

### 2. The Speed of Iteration

Training Gemini 1.5 Pro didn't just require a lot of chips; it required a stable, low-latency environment. When a training run takes three months, a 1% improvement in networking efficiency or a 2% reduction in thermal throttling translates to **days** of saved time and millions of dollars in power costs.

### 3. Sustainability at Scale

The chemically-etched RDHX isn't just a cooling solution; it’s a sustainability solution. By capturing heat at the source and using warm-water loops, Google is proving that the AI revolution doesn't have to be a climate catastrophe.

---

## The Jupiterean Future

As we look toward the next generation of compute, the lessons from Jupiterean Consolidation are clear: **The rack is no longer the unit of compute. The datacenter is.**

We are moving away from the era of "General Purpose" and into the era of "Extreme Integration." The wall between the network, the cooling system, the silicon, and the scheduler has vanished.

When you see Google announcing breakthroughs in model context windows or multi-modal reasoning, remember the "chemically-etched" truth behind it. Those models are floating on a sea of turbulent-flow coolant, orchestrated by mirrors of light, and powered by a consolidated architecture that has redefined what "compute density" actually means.

The Jupiterean era hasn't just arrived; it’s currently cooling the very servers that are writing the next chapter of human intelligence.
