---
title: "When the Silicon Sweats: Meta’s Thermal-Aware Scheduler and the Physics of Hyperscale GPU Orchestration"
shortTitle: "Meta’s Thermal-Aware GPU Scheduling for Hyperscale Infrastructure"
date: 2026-06-06
image: "/images/2026/06/06/when-the-silicon-sweats-meta-s-thermal-aware-scheduler-and-t.jpg"
---

At the scale of Meta’s AI infrastructure—where clusters of 24,576 NVIDIA H100 GPUs are becoming the baseline—the laws of computer science begin to collide violently with the laws of thermodynamics.

In the old days of web serving, "locality" meant putting your compute near your data to minimize latency. If a server got a bit warm, the fans spun up, and the load balancer shifted some traffic. But as we move into the era of Llama 3 and beyond, we aren't just dealing with "warm" servers; we are dealing with silicon that consumes 700W to 1000W per chip. When you pack eight of these into a **Grand Teton** platform and fill a row of racks with them, you aren't just running a data center—you are operating a high-energy physics experiment.

The challenge Meta faced was profound: If you schedule a massive training job based solely on network proximity (the traditional "gold standard"), you create localized "heat islands." These islands trigger hardware thermal throttling, which desynchronizes the GPU clocks across the collective. In a synchronous training environment (like All-Reduce), your entire $500 million cluster effectively slows down to the speed of the single hottest, most throttled GPU.

This is the story of how Meta re-engineered its scheduler to be **thermal-aware**, moving from simple bin-packing to a complex, physics-informed orchestration of heat, power, and bits.

---

## The Hype and the Hard Reality: Why "Just Add Fans" Doesn't Work

For the last year, the industry has been obsessed with "GPU Racks per Square Foot." We’ve seen the hype around liquid cooling and the staggering lead times for specialized power transformers. But the software side of this physical problem is often overlooked.

The hype suggests that if you have the GPUs and the InfiniBand/RoCE fabric, you’re ready to train the next GPT-5. The reality? **Thermal jitter.**

In a hyperscale cluster, heat isn't distributed evenly. Due to airflow dynamics, the "top of the rack" is often hotter than the bottom. The "end of the row" might have different pressure than the middle. If a scheduler places a 2,000-GPU job in a physically dense block, it creates a thermal spike that the cooling infrastructure (CRAC units and liquid loops) cannot compensate for instantly.

Meta realized that to maximize **TFLOPS-per-watt**, the scheduler had to treat "thermal headroom" as a first-class resource, just like RAM or VRAM.

---

## The Architecture of Thermal-Awareness

To understand Meta's solution, we have to look at the three layers of the stack: the **Physical Topology**, the **Telemetry Pipeline**, and the **Objective Function**.

### 1. The Physical-Digital Twin

Meta’s scheduler doesn't just see a list of available hostnames. It maintains a high-fidelity map of the data center floor. This includes:

- **Vertical Position:** Which RU (Rack Unit) is the server in?
- **Horizontal Proximity:** Which rack is next to which?
- **Cooling Proximity:** How far is this rack from the nearest cooling distribution unit (CDU)?

By integrating Data Center Infrastructure Management (DCIM) data into the job orchestrator, the scheduler understands that Host A and Host B might be on the same network switch, but Host A is dumping heat directly into Host B’s intake.

### 2. The Telemetry Pipeline (The "Nervous System")

A thermal-aware scheduler is only as good as its sensors. Meta utilizes a massive telemetry ingestion engine (built on top of tools like **Scuba** and **ODS**) that polls thousands of endpoints per second:

- **GPU Junction Temperatures:** The actual heat at the silicon die.
- **Inlet/Outlet Delta-T:** The difference in temperature of the air entering and leaving the chassis.
- **Liquid Flow Rates:** For liquid-cooled racks, the millisecond-by-millisecond status of the coolant loop.
- **Fan PWM Signals:** How hard the hardware is struggling to stay cool.

### 3. The Multi-Objective Scheduler

Traditional schedulers solve a "Bin Packing" problem: _Fit X jobs into Y slots while minimizing network hops._
Meta’s Thermal-Aware Scheduler (TAS) solves a **Constrained Optimization** problem. It uses a weighted cost function that looks something like this (simplified for conceptual clarity):

$$Cost = \alpha(Latency) + \beta(Fragmentation) + \gamma(Thermal\_Gradient)$$

Where:

- **$\alpha(Latency)$** ensures GPUs are close enough for RoCE v2 performance.
- **$\beta(Fragmentation)$** prevents the "swiss cheese" effect in the cluster.
- **$\gamma(Thermal\_Gradient)$** penalizes placing jobs in racks that are already approaching their thermal ceiling.

---

## Deep-Dive: The "Thermal Shadow" Problem

One of the most fascinating engineering curiosities Meta encountered is the **"Thermal Shadow."**

In a traditional air-cooled row, the hot air exhausted by one row of racks can occasionally be "re-entrained" or sucked back into the intake of an adjacent row due to pressure differentials. If the scheduler is "blind" to this, it might schedule a massive training run in Row A, unknowingly causing the GPUs in Row B to throttle because their "cool air" is now 10°C warmer than it should be.

### The Solution: Space-Time Scheduling

Meta’s scheduler uses a technique called **Spatial Smoothing**. Instead of packing a job into the tightest possible physical cluster, it "sprays" the job across a wider area—_if and only if_ the network topology (Fat-Tree or Rail-Optimized) can handle the extra hops without a latency penalty.

By spreading the thermal load, the scheduler increases the "surface area" of the heat being generated, allowing the facility’s HVAC and liquid cooling systems to work more efficiently. This effectively increases the **Total Power Envelope (TPE)** of the entire data center without adding a single new fan.

---

## Implementing the Logic: A Glimpse into the Scheduler Code

While Meta’s internal code is proprietary, the logic follows a pattern that integrates with orchestration frameworks like Kubernetes (via custom Kube-Schedulers) or Meta’s own internal Tectonic/Twine systems.

Imagine a scheduling plugin that evaluates a "Heat Score" for a proposed set of nodes:

```python
def calculate_thermal_fitness(candidate_nodes, job_power_profile):
    """
    Evaluates if a set of nodes can handle the thermal load of a new AI training job.
    """
    current_cluster_thermal_map = telemetry_service.get_real_time_temps()
    rack_power_limits = dcim_service.get_rack_power_caps()

    total_penalty = 0

    for node in candidate_nodes:
        # Predict temperature rise based on Job's TDP (e.g., 700W per H100)
        predicted_temp = current_cluster_thermal_map[node].inlet_temp + \
                         (job_power_profile.per_gpu_tdp * thermal_constant)

        # Check against hardware throttling thresholds
        if predicted_temp > node.throttling_threshold:
            return float('inf')  # Node is a no-go

        # Penalize nodes in "Hot Zones"
        zone_congestion = current_cluster_thermal_map.get_zone_saturation(node.zone)
        total_penalty += (zone_congestion * thermal_weight)

    return total_penalty

# The scheduler then picks the candidate_nodes with the lowest (Latency + Thermal) cost.
```

In practice, this is implemented using **Mixed-Integer Linear Programming (MILP)** to ensure that the scheduler doesn't take five minutes to make a decision while thousands of GPUs sit idle.

---

## The Network Trade-off: RoCE v2 and Data Locality

You might ask: _"If we spread the GPUs out to keep them cool, doesn't the network performance go to hell?"_

This is where the **Physics of Data Locality** gets interesting. In Meta’s Grand Teton architecture, they utilize a **Rail-Optimized Topology**.

In a rail-optimized network, GPU #1 in every server is connected to the same leaf switch, GPU #2 to another, and so on. This creates "rails" of high-speed connectivity. Because of this specialized wiring, you can actually spread a job across multiple racks while keeping all the GPUs that need to talk to each other on the same "rail."

The thermal-aware scheduler exploits this. It knows it can move a job "horizontally" across racks (increasing thermal spacing) without moving it "vertically" across switch layers (which would increase latency).

**The result:** The GPUs "feel" like they are right next to each other on the network, but they are physically separated by enough air/coolant to stay at peak clock speeds.

---

## Hardware-Software Co-Design: The Grand Teton Factor

You cannot build a thermal-aware scheduler in a vacuum. It requires a specific hardware architecture. Meta’s **Grand Teton** (the successor to Zion EX) was designed specifically with this telemetry in mind.

- **Integrated BMCs:** Every tray has a Baseboard Management Controller that streams high-fidelity power and thermal data via OpenBMC.
- **Power Capping at Scale:** The scheduler can communicate with the racks to implement **Rack-Level Power Capping (RLPC)**. If the facility’s cooling loop experiences a partial failure, the scheduler doesn't just crash the jobs; it gracefully throttles the power cap across the entire cluster, maintaining synchronization while lowering the heat output.

---

## Why This Matters for the Future of AI

We are reaching the end of the "brute force" era of data center management. As we look toward 1,000,000-GPU clusters, the complexity grows exponentially.

### 1. PUE (Power Usage Effectiveness)

By being thermal-aware, Meta can run their data centers "warmer." Instead of chilling the entire room to 18°C (64°F) just to protect a few hotspots, they can let the room rise to 25°C (77°F) and use the scheduler to manage the risks. This saves megawatts of power on cooling alone, directly lowering the PUE and the carbon footprint of every Llama model trained.

### 2. Hardware Longevity

Thermal cycling (the constant expansion and contraction of silicon and solder as it heats and cools) is the primary killer of GPUs. A thermal-aware scheduler acts as a "smooth operator," preventing the jagged temperature spikes that lead to micro-fractures in the chips. This increases the MTBF (Mean Time Between Failures) of the cluster.

### 3. Training Stability

In LLM training, a single node failure can trigger a "checkpoint and restart" cycle that wastes hours of compute time. By avoiding thermal throttling and heat-induced failures, the scheduler ensures that training runs stay "in the green" for weeks at a time.

---

## The Engineering Frontier

The next step for Meta isn't just reacting to heat—it's **Predictive Thermal Modeling**.

By using machine learning to analyze past training runs, the scheduler can predict the thermal signature of a specific model architecture. For example, a "MoE" (Mixture of Experts) model has a very different power profile than a dense Transformer. A predictive scheduler could "pre-cool" a specific row of racks or adjust the liquid flow rates _before_ the job even starts.

Meta is essentially turning the data center into a giant, programmable organism. The scheduler is no longer just a piece of software that assigns tasks to CPUs; it is a sophisticated governor that balances the digital demands of AI against the uncompromising physics of the real world.

When we talk about "The Physics of Data Locality," we aren't just talking about where the bits are stored. We are talking about where the energy is transformed, where the heat is dissipated, and how we can orchestrate tens of thousands of screaming GPUs to work as one single, cool-headed machine.

This isn't just engineering—it's a masterclass in hyperscale survival.
