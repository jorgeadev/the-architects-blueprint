---
title: "From Sequences to Symmetry: Rewiring Gene Therapy with GNNs and Exascale Compute"
shortTitle: "Transforming Gene Therapy with GNNs and Exascale Compute"
date: 2026-06-20
image: "/images/2026/06/20/from-sequences-to-symmetry-rewiring-gene-therapy-with-gnns-a.jpg"
---

The dream of gene therapy is simple: if a piece of biological "code" (DNA) is broken, we should be able to send in a patch. But in biology, the "installer" is often more complex than the "software." For decades, the bottleneck of genetic medicine hasn't just been identifying the right genes—it’s been the delivery vehicle. Specifically, the **Adeno-Associated Virus (AAV)**.

AAVs are the workhorses of gene therapy. They are small, non-pathogenic viruses that we strip of their viral DNA and pack with therapeutic payloads. But here’s the engineering nightmare: natural AAVs are like generic delivery trucks trying to navigate a city without a GPS. They get stuck in the liver (even when you want them in the brain), they get hijacked by the immune system, and they often carry a "payload" that’s too heavy for their chassis.

To solve this, we’ve moved from "discovering" viruses to **engineering them**. But the search space for a single AAV capsid (the protein shell) is roughly $20^{735}$—a number so vast it makes the number of atoms in the observable universe look like a rounding error.

We can’t "wet-lab" our way out of this. We need to build a digital twin of the protein universe. This is the story of how we’re using **Advanced Graph Neural Networks (GNNs)** and **cloud-scale orchestration** to navigate the impossible geometry of the viral capsid.

---

## Why Graphs? The Geometry of a Protein

For years, the "State of the Art" in protein modeling treated amino acid sequences like text. We used Recurrent Neural Networks (RNNs) and then Transformers to predict properties based on the "sentence" of the protein. While effective for some tasks, this approach ignores a fundamental truth: **Biology happens in 3D.**

A protein isn’t just a string of characters; it’s a complex, folding, vibrating structure in Euclidean space. If two amino acids are far apart in a sequence but touch each other when the protein folds, a standard Transformer might struggle to capture that local physical interaction without massive amounts of data.

### The Graph Advantage

In a Graph Neural Network, we represent the AAV capsid as a graph $G = (V, E)$:

- **Nodes ($V$):** Each amino acid or even individual atoms.
- **Edges ($E$):** The chemical bonds or spatial proximity (e.g., any two residues within 8 Angstroms of each other).
- **Node Features:** Charge, hydrophobicity, side-chain orientation.
- **Edge Features:** Distance, bond type, or relative orientation.

By using GNNs, we encode the **inductive bias** of physics directly into the model. The model "knows" that things closer in 3D space should influence each other more than things far away. This allows us to achieve higher accuracy with significantly less training data—a critical factor when high-quality "wet-lab" experimental data is expensive and slow to produce.

---

## The Architecture: Message Passing at the Atomic Scale

To design a better viral vector, we aren't just predicting if a capsid _folds_; we are predicting **tropism** (which tissue it goes to) and **immunogenicity** (whether the body attacks it).

We utilize a variant of **Equivariant Graph Neural Networks (EGNNs)**. The "Equivariant" part is crucial. If you rotate an AAV capsid in space, its biological function doesn't change. A standard neural network might see a rotated protein as an entirely different data point. An Equivariant model mathematically guarantees that the output remains consistent regardless of the protein's orientation or position in the coordinate system.

### The Message Passing Loop

The core of our architecture relies on **Message Passing**. In each layer of the GNN, nodes "talk" to their neighbors:

1.  **Message Generation:** Each edge computes a message based on the source node, target node, and edge features.
2.  **Aggregation:** Each node collects messages from its neighbors (using permutation-invariant functions like `sum` or `mean`).
3.  **Update:** The node updates its own internal state based on the aggregated messages.

```python
import torch
from torch_geometric.nn import MessagePassing

class CapsidConv(MessagePassing):
    def __init__(self, in_channels, out_channels):
        super(CapsidConv, self).__init__(aggr='add')
        self.mlp = torch.nn.Sequential(
            torch.nn.Linear(2 * in_channels + 1, out_channels),
            torch.nn.ReLU(),
            torch.nn.Linear(out_channels, out_channels)
        )

    def forward(self, x, edge_index, edge_attr):
        # x: Node features [num_nodes, in_channels]
        # edge_index: Graph connectivity [2, num_edges]
        # edge_attr: Distances between residues [num_edges, 1]
        return self.propagate(edge_index, x=x, edge_attr=edge_attr)

    def message(self, x_i, x_j, edge_attr):
        # Concatenate features of neighboring nodes with their spatial distance
        tmp = torch.cat([x_i, x_j, edge_attr], dim=-1)
        return self.mlp(tmp)
```

In the context of an AAV, this allows the model to "feel" the surface of the virus. If a specific cluster of positively charged amino acids appears on a protruding loop of the capsid, the GNN identifies this as a potential binding site for a cell receptor.

---

## Infrastructure: Scaling to the "Dry Lab"

Training a GNN on a single protein is easy. Training a generative model to design billions of potential capsids and simulating their interactions with human cell receptors is a **compute-bound nightmare**.

To handle this, we’ve moved away from monolithic servers to a **cloud-native, distributed GPU architecture**.

### The High-Throughput Data Pipeline

The raw data starts as Cryo-EM structures and DNA sequencing results from "Directed Evolution" experiments. This data is messy.

1.  **Ingestion:** Raw FASTQ files (DNA sequences) are uploaded to an **S3-compatible object store**.
2.  **Normalization:** We use **Apache Spark** on Kubernetes to process these sequences, translating them to 3D graph representations.
3.  **Graph Databases:** While the training happens in PyTorch, the relationships between millions of capsid variants are stored in a graph database like **Neo4j** or **AWS Neptune**. This allows our researchers to query for things like "Find all variants with a specific mutation pattern in the VP3 region that also showed high heart-tissue uptake."

### Distributed Training and the "Monster" Nodes

We aren't just using "a GPU." We’re using clusters of **NVIDIA H100s** linked via **NVLink** and **InfiniBand**.

When training GNNs at this scale, the bottleneck is often the **CPU-to-GPU data transfer**. Graphs are sparse data structures. Unlike images, which are dense blocks of pixels, graphs require "gathering" data from scattered memory locations.

- **The Solution:** We leverage **DGL (Deep Graph Library)** and **PyTorch Geometric** with custom CUDA kernels to parallelize the neighbor aggregation.
- **Model Parallelism:** Since the AAV capsid is a massive assembly of 60 identical proteins (an icosahedron), we use **Symmetry-Aware Folding**. We don't model the whole 60-unit structure at once; we model one unit and use the symmetry operators to calculate the global energy state. This reduces the memory footprint by 60x.

---

## Beyond the Hype: Is this just "AlphaFold for Viruses"?

Recent headlines have been dominated by AlphaFold 3 and ESM-3. The hype suggests that "AI has solved biology." From an engineering perspective, this is a dangerous oversimplification.

**AlphaFold** is a structural prediction tool. It tells you what a protein looks like.
**Viral Vector Design** is an _inverse_ problem and a _multi-objective optimization_ problem.

Knowing the structure is step one. Step two is engineering a structure that:

1.  **Evades Neutralizing Antibodies:** (The "Cloaking" problem).
2.  **Crosses the Blood-Brain Barrier:** (The "Access" problem).
3.  **Packages DNA Efficiently:** (The "Payload" problem).
4.  **Can be Manufactured at Scale:** (The "Yield" problem).

The technical substance behind the hype isn't just "better AI"—it's the transition from **Generative AI (creating sequences)** to **Model-Based Optimization (MBO)**. We use our GNN as a "surrogate model" (an oracle). We then use **Bayesian Optimization** or **Reinforcement Learning (RL)** to "walk" through the landscape of possible capsids, asking the GNN at each step: _"Is this one better than the last?"_

---

## The Engineering Curiosity: Equivariance and "The 100-Angstrom Problem"

One of the most fascinating challenges we faced is the scale of the capsid. An AAV capsid is roughly 25 nanometers (250 Angstroms) in diameter. In the world of atomic physics, that is a vast distance.

Standard GNNs suffer from **"Over-smoothing."** If you have too many layers (to allow a node on one side of the virus to "hear" about a node on the other side), all the node features start to look the same. The signal turns into gray noise.

We solved this using **Hierarchical Graph Neural Networks**.

- **Level 1 (Atomic):** GNNs capture the local chemistry of single amino acids.
- **Level 2 (Domain):** We "pool" those nodes into functional loops and beta-sheets.
- **Level 3 (Capsid):** We treat these functional units as nodes in a global icosahedral graph.

This multi-scale approach mirrors how biology actually works. A mutation in a tiny pocket of the protein can cause a "conformational change" that ripples across the entire shell, changing how the virus behaves.

---

## Cloud-Scale Inference: The "Dry Lab" at 1 Million Capsids/Sec

Once we have a trained model, the goal is to find the "needle in the haystack." We run **Exascale Virtual Screening**.

We spin up thousands of spot instances on AWS or GCP. Each instance takes a batch of a million "candidate" capsids generated by our RL agent. The GNN scores these candidates for multiple traits.

The engineering challenge here is **Cost Optimization**. Running H100s for inference is expensive. We use:

1.  **Quantization (INT8/FP8):** Reducing the precision of the GNN weights. In biology, we often don't need 32-bit precision to know if a protein is stable. 8-bit is often enough to filter out the 99.9% of "junk" designs.
2.  **Operator Fusion:** Combining the "Message" and "Aggregate" steps into a single GPU kernel to minimize memory read/writes.
3.  **Knowledge Distillation:** We take our massive, multi-billion parameter GNN and "distill" its knowledge into a smaller, faster "Student" network that can run on cheaper T4 or L4 GPUs for the initial screening phases.

---

## The Feedback Loop: Wet Lab as the "Ground Truth"

Even the best GNN is just a map—not the territory. The most critical part of our infrastructure isn't the GPUs; it's the **Automated Wet-Lab Loop**.

When the model identifies the top 1,000 candidate capsids, these are sent to a robotic synthesis lab. The DNA is printed, the viruses are grown, and they are tested on "Organ-on-a-chip" systems.

The results—successes and, more importantly, failures—are fed back into our S3 buckets.

- **Active Learning:** Our models are retrained every week on the new data.
- **Uncertainty Estimation:** We don't just ask the GNN for a score; we ask for a confidence interval. If the model says, "I think this capsid is great, but I'm not sure," we prioritize testing _that_ variant because it provides the most information to the model.

---

## The Real Technical Substance: Overcoming "Out-of-Distribution" Data

The hardest part of this engineering feat is that we want to design viruses that are **different** from anything in nature. If we only train on natural AAVs, the model will only suggest "slightly better" natural AAVs.

This is the **Out-of-Distribution (OOD)** problem. To overcome this, we use **Physics-Informed Neural Networks (PINNs)**. We augment our GNN loss function with physical constraints, like Van der Waals forces and electrostatic repulsion.

Even if the model has never seen a specific protein configuration before, it knows it can't violate the laws of physics (e.g., two atoms cannot occupy the same space). This "physical guardrail" allows us to push the generative models into entirely new areas of the "Capsid Landscape," creating synthetic delivery vehicles that nature never intended to build.

---

## The Road to $1.0 Beta

We are currently in a transition period for gene therapy. We are moving from the "Heroic Age"—where a single therapy takes 10 years and $2 billion to develop—to the **"Platform Age."**

By treating the AAV capsid as a programmable graph and leveraging cloud-scale compute to simulate its behavior, we are essentially building a **Compiler for Gene Therapy**.

In this new paradigm:

- **The Input:** A target tissue (e.g., "Cardiac Myocytes") and a payload size.
- **The Process:** GNN-driven design, Bayesian optimization, and automated synthesis.
- **The Output:** A custom-engineered viral vector with 100x the efficiency of its natural counterpart.

Engineering at the intersection of GNNs and biotechnology is messy, computationally expensive, and incredibly complex. But the stakes are as high as they get. We aren't just optimizing click-through rates or reducing latency in a video stream. We are debugging the human condition, one node and edge at a time.

The "FedEx problem" of gene therapy is finally being solved—not by a better truck, but by an intelligent, graph-aware, cloud-powered delivery system.
