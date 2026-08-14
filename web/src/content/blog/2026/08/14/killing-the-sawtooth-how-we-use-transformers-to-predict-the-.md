---
title: "Killing the Sawtooth: How We Use Transformers to Predict the Future of Our Edge Network"
shortTitle: "Predicting Edge Network Performance with Transformers"
date: 2026-08-14
image: "/images/2026/08/14/killing-the-sawtooth-how-we-use-transformers-to-predict-the-.svg"
---

Imagine it is 2:59 PM UTC on a Friday. Your global edge network is humming along at a comfortable 40% utilization. Then, a major gaming studio drops a 50GB patch, or a global news event triggers a 10x surge in traffic within seconds.

By the time your traditional Horizontal Pod Autoscaler (HPA) notices the CPU spike, scrapes the metrics, calculates the new target replicas, and pulls the container images, your P99 latency has already skyrocketed. Your users are staring at loading spinners, and your on-call engineers are drowning in PagerDuty alerts.

This is the **Reactive Scaling Trap**. In a world of global edge computing, reacting to the present is already too late. To maintain a seamless experience, you need to scale for the traffic that hasn't arrived yet.

At our scale—managing thousands of Points of Presence (PoPs) and handling hundreds of terabits per second—we realized that traditional threshold-based scaling is a relic of the past. We needed to move from **Reactive** to **Predictive**.

This is the story of how we built a predictive auto-scaling engine using **Transformer-based Time Series Forecasting**, moving away from simple LSTMs to the same attention-based architectures that power LLMs, and integrating them directly into our global orchestration layer.

---

## The Infrastructure Gap: Why "Reactive" is Broken

Standard auto-scaling (like the Kubernetes HPA) relies on a feedback loop:

1. **Observe:** Metric (CPU/RAM) exceeds threshold.
2. **Analyze:** Calculate required replicas.
3. **Act:** Spin up new pods.

The fatal flaw is the **Provisioning Latency**. In a heavy microservices environment, a "cold start" (from pod creation to being ready to accept traffic) can take anywhere from 30 seconds to 3 minutes. If your traffic doubles in 15 seconds, you are effectively flying blind for the most critical window of the spike.

The result is the infamous **"Sawtooth Pattern"**: utilization spikes, the system over-corrects by over-provisioning, utilization drops, the system scales down, and the cycle repeats. This isn't just inefficient; it's expensive. You are either paying for idle silicon or paying the price in user churn due to latency.

---

## The Hype and the Pivot: Why Transformers for Time Series?

For the last year, the world has been obsessed with Transformers in the context of Large Language Models (LLMs) like GPT-4. However, the core innovation of the Transformer—**Multi-Head Self-Attention**—is perhaps even more potent when applied to time-series forecasting for infrastructure.

For years, the industry standard for time-series was the **LSTM (Long Short-Term Memory)** network. LSTMs were great, but they had a "vanishing gradient" problem and processed data sequentially. They were notoriously bad at capturing long-range dependencies (e.g., "How does traffic today relate to the traffic on the same Tuesday three weeks ago?").

Transformers changed the game because:

1. **Parallelization:** Unlike RNNs, Transformers process entire sequences at once.
2. **Global Receptive Field:** Through self-attention, the model can weigh the importance of a data point from 5 minutes ago and a data point from 5 days ago simultaneously.
3. **Multi-Modal Inputs:** We can feed in not just CPU metrics, but also "external" tokens like holiday calendars, scheduled marketing blasts, and even weather patterns (which surprisingly affect internet usage in certain regions).

---

## The Architecture: A Deep Dive

Our predictive scaling engine, which we internally call **Aegis**, isn't just a model; it’s a high-throughput pipeline that bridges the gap between our telemetry stack and our control plane.

### 1. The Data Ingestion Layer: High-Cardinality Telemetry

The foundation is our telemetry mesh. We ingest metrics from Prometheus and VictoriaMetrics across our global PoPs.

The challenge at the edge is **high cardinality**. We aren't just scaling "the app"; we are scaling thousands of service instances across hundreds of geographic regions. Each region has its own personality. Traffic in Tokyo doesn't look like traffic in Frankfurt.

We use a **Vectorized Feature Store** to aggregate these metrics into 1-minute buckets. We don't just look at CPU. We track:

- **Request Rate (RPS)**
- **Packet-per-second (PPS) trends**
- **TCP Connection state counts**
- **Upstream Latency**

### 2. The Model Architecture: Temporal Fusion Transformers (TFT)

We didn't just use a "vanilla" Transformer. We implemented a **Temporal Fusion Transformer (TFT)** architecture.

The TFT is specifically designed for multi-horizon forecasting. It uses **Gating Mechanisms** to skip over unused components of the network, providing adaptive complexity. More importantly, it uses **Variable Selection Networks** to decide which features (e.g., CPU vs. Time-of-Day) are actually relevant for a specific PoP at a specific time.

#### The Code: A Glimpse into the Attention Mechanism

Here is a simplified look at how we structure the Multi-Head Attention for our time-series sequence in PyTorch:

```python
import torch
import torch.nn as nn

class TimeSeriesAttention(nn.Module):
    def __init__(self, embed_dim, num_heads):
        super().__init__()
        self.attention = nn.MultiheadAttention(embed_dim, num_heads)
        self.norm = nn.LayerNorm(embed_dim)
        self.dropout = nn.Dropout(0.1)

    def forward(self, x):
        # x shape: (Sequence_Length, Batch_Size, Embed_Dim)
        # We treat each time-step as a 'token'
        attn_output, _ = self.attention(x, x, x)
        x = x + self.dropout(attn_output)
        x = self.norm(x)
        return x

class PredictiveScalingTransformer(nn.Module):
    def __init__(self, input_dim, model_dim, n_heads, n_layers):
        super().__init__()
        self.input_projection = nn.Linear(input_dim, model_dim)
        self.pos_encoder = nn.Parameter(torch.zeros(1, 500, model_dim)) # Max sequence 500
        self.layers = nn.ModuleList([
            TimeSeriesAttention(model_dim, n_heads) for _ in range(n_layers)
        ])
        self.head = nn.Linear(model_dim, 1) # Predicting the 'Scale Factor'

    def forward(self, x):
        # x: (Batch, Seq_Len, Features)
        x = self.input_projection(x) + self.pos_encoder[:, :x.size(1), :]
        x = x.transpose(0, 1) # Transformer expects (Seq, Batch, Dim)
        for layer in self.layers:
            x = layer(x)
        return torch.sigmoid(self.head(x[-1])) # Return prediction for next step
```

### 3. Quantile Regression: Predicting the Worst Case

A major "Engineering Curiosity" in our design is that we don't predict the **mean** traffic. If you predict the mean and you are wrong 50% of the time, you have 50% dropped packets.

Instead, Aegis uses **Quantile Regression**. The model outputs multiple values: the 10th, 50th, and 90th percentiles ($P_{10}, P_{50}, P_{90}$).

- If the gap between $P_{50}$ and $P_{90}$ is small, the model is confident.
- If the gap is large (high variance), our controller defaults to the $P_{90}$ prediction—effectively "padding" our capacity to account for uncertainty.

---

## Solving the "Cold Start" and the "Flash Crowd"

One of the biggest hurdles in predictive scaling is the **Flash Crowd**—a spike so sudden it looks like a DDoS attack. Transformers are better than LSTMs here, but even they need _some_ signal.

To handle this, we implemented a **Hybrid Control Loop**:

1.  **The Planner (Transformer):** Runs every 5 minutes, looking at a 24-hour window. It emits a "Schedule" for the next 60 minutes.
2.  **The Sentinel (Reactive):** A lightweight Go-based sidecar that monitors local kernel-level metrics. If it detects a 300% deviation from the "Planner's" prediction within a 10-second window, it triggers an emergency "Brake Squeeze" (instant over-provisioning), overriding the Transformer.

This creates a safety net. The Transformer handles the 99% of "predictable" chaos—the daily cycles, the weekend dips, the expected launch events—while the Reactive Sentinel handles the black swan events.

---

## Engineering Challenges at Global Scale

### Model Drift and Federated Learning

At our scale, we cannot train one single model for the whole world. A model trained on US-East-1 traffic will fail miserably in Sydney, Australia.

We utilize a **Federated Training** approach. We have a "Base Model" (the Global Weights) that understands general internet patterns. We then perform **transfer learning** at the edge, where regional controllers fine-tune the model on local data. This allows the Tokyo model to "learn" about the specific timing of the Japanese commute or local holidays without affecting the rest of the network.

### The Compute Tax

Running a Transformer inference every few minutes for thousands of services is compute-intensive. To mitigate this, we don't run these on the Edge nodes themselves (where compute is reserved for customer traffic).

Instead, we stream the telemetry to **Regional Aggregator Hubs**. These hubs run the inference on dedicated GPU/TPU clusters and then push the "Capacity Requirements" down to the Edge PoPs via a specialized GRPC channel. This keeps the Edge nodes lean and focused on their primary job: serving content.

### High-Cardinality Feature Engineering

One of our "Engineering Curiosities" was discovering that **Latency** is a leading indicator for **CPU load**, but only in specific scenarios. When a database back-end slows down, connection queuing causes CPU spikes on the edge proxies due to context switching.

By adding "Upstream P95 Latency" as a token in our Transformer, the model learned to predict capacity spikes _caused by back-end degradation_ before the CPU even started to climb.

---

## The Integration: A Custom Kubernetes Controller

How does a "prediction" become a "running pod"? We replaced the standard HPA with our custom **Predictive-HPA (PHPA) Controller**.

The PHPA Controller is a Kubernetes CRD that:

1.  Watches the `ScalingPrediction` object emitted by Aegis.
2.  Calculates the "Target State" for $T+15$ minutes.
3.  Interfaces with the `cluster-autoscaler` to ensure the underlying Virtual Machines (or Bare Metal nodes) are provisioned before the pods need to land.

**The result is "Just-in-Time" Infrastructure.**

---

## Real-World Impact: The Results

Since moving to Transformer-based predictive scaling, the metrics have been staggering:

- **P99 Latency Reduction:** We saw a **22% improvement** in P99 latency during peak transitions (e.g., the 8 AM "Start of Work" surge).
- **Infrastructure Cost Savings:** By reducing the "Safety Padding" (over-provisioning) from 40% to 15%, we slashed our cloud compute bill by nearly **$2 million per quarter**.
- **On-Call Health:** Incident reports related to "Capacity Exhaustion" dropped by **65%**.

The most fascinating outcome, however, was the **"Smoothing of the Sawtooth."** When you look at our utilization graphs now, they don't look like a jagged mountain range; they look like a gentle, rolling hill. The system is breathing in sync with the internet.

---

## The Future: Towards Fully Autonomous Networks

We are currently experimenting with **Reinforcement Learning (RL)** on top of our Transformer predictions. While the Transformer predicts _what_ will happen, the RL agent learns the _optimal way_ to respond to that prediction to minimize cost while maximizing performance.

The dream is a "Zero-Ops" network—a global infrastructure that anticipates human behavior, adapts to hardware failures before they happen, and scales itself across the globe with zero human intervention.

Predictive auto-scaling is no longer a luxury or a research project; it is a requirement for anyone operating at the edge. The internet moves too fast for us to be reactive. It's time to start looking forward.

---

## Engineering Checklist for Predictive Scaling

If you're looking to implement this in your own stack, here are the key takeaways from our journey:

- **Don't start with the model:** Your telemetry pipeline is 90% of the work. If your data is noisy or late, the best Transformer in the world won't save you.
- **Quantiles > Means:** Always predict for the worst-case scenario. Infrastructure is about reliability, not averages.
- **The Hybrid Approach is King:** Never trust an ML model blindly. Always have a fast, reactive circuit breaker to handle the unexpected.
- **Watch the "Provisioning Lag":** Measure how long it _actually_ takes for your stack to go from `Pending` to `Running`. This is your "Lookahead Window."
- **Context Matters:** Feed your model more than just CPU. Give it time-of-day, day-of-week, and even upstream health metrics.

The transition from $HPA \rightarrow Predictive$ is a fundamental shift in how we think about capacity. We are moving from a world where we manage servers to a world where we manage **probability distributions**. And in that world, the Transformer is the most powerful tool we have.
