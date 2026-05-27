"""Resolve topics.json merge conflict: remove published topics, add new ones from main."""
import json
import sys

path = "config/topics.json"

with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

topics = data["topics"]
before = len(topics)

# Remove topics already published as articles on main branch
topics = [t for t in topics if not ("Fastly" in t and "CDN" in t and "Varnish" in t)]
topics = [t for t in topics if not ("MLOps Stack" in t and "Trillion-Parameter" in t)]

removed = before - len(topics)
if removed != 2:
    print(f"ERROR: Expected to remove 2 topics, but removed {removed}", file=sys.stderr)
    sys.exit(1)

# Add 6 new topics from main branch (commits #229 and #230 additions)
new_topics = [
    "Disaggregated Memory Architectures in Hyperscale Cloud: Addressing Latency, Bandwidth, and Resource Orchestration Challenges with CXL and UCIe.",
    "Beyond Strong Consistency: Leveraging Causal and Eventual Consistency Models for Geo-Distributed Multi-Master Databases in Mission-Critical Systems.",
    "Synthetic Phage Engineering for Targeted Microbiome Modulation: Overcoming Off-Target Effects and Developing Programmable Viral Vectors for Therapeutics.",
    "Beyond BBR: Next-Generation Congestion Control Protocols for Petabit-Scale Global Interconnects",
    "The Architectural Deep Dive into Quantization and Indexing Algorithms for Exabyte-Scale Vector Databases",
    "Engineering CRISPR-Cas Systems for Programmable Epigenetic Editing and Cellular Reprogramming at Scale",
]
topics.extend(new_topics)

data["topics"] = topics

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=4, ensure_ascii=False)
    f.write("\n")

print(f"Done: removed {removed} topics, added {len(new_topics)} new topics. Total: {len(topics)}")
