import type { CollectionEntry } from "astro:content";

export type BlogPost = CollectionEntry<"blog">;

type TopicDefinition = {
    label: string;
    query: string;
    keywords: string[];
};

const TOPIC_DEFINITIONS: TopicDefinition[] = [
    {
        label: "AI & Models",
        query: "ai llm model gpu training",
        keywords: [
            "ai",
            "llm",
            "llms",
            "model",
            "models",
            "gpu",
            "gpus",
            "training",
            "inference",
            "multimodal",
        ],
    },
    {
        label: "Data & Streaming",
        query: "data stream kafka pipeline analytics",
        keywords: [
            "data",
            "stream",
            "streaming",
            "kafka",
            "pipeline",
            "analytics",
            "warehouse",
            "event",
            "events",
        ],
    },
    {
        label: "Cloud & Infra",
        query: "cloud infra serverless distributed hyperscale",
        keywords: [
            "cloud",
            "infra",
            "infrastructure",
            "serverless",
            "distributed",
            "hyperscale",
            "kubernetes",
            "edge",
        ],
    },
    {
        label: "Databases",
        query: "database spanner storage consistency sharding",
        keywords: [
            "database",
            "databases",
            "spanner",
            "storage",
            "consistency",
            "sharding",
            "replication",
            "transaction",
            "cxl",
        ],
    },
    {
        label: "Biotech",
        query: "bio crispr genome protein medicine",
        keywords: [
            "bio",
            "biology",
            "biotech",
            "crispr",
            "genome",
            "genomics",
            "protein",
            "rna",
            "medicine",
            "phage",
        ],
    },
    {
        label: "Observability",
        query: "observability tracing metrics monitoring ebpf",
        keywords: ["observability", "tracing", "metrics", "monitoring", "telemetry", "ebpf"],
    },
    {
        label: "Networking",
        query: "network latency rdma optics router",
        keywords: [
            "network",
            "networks",
            "latency",
            "rdma",
            "optical",
            "optics",
            "router",
            "interconnect",
            "packet",
        ],
    },
    {
        label: "Product",
        query: "product search recommendation feed ui ux",
        keywords: [
            "product",
            "feature",
            "search",
            "recommendation",
            "recommendations",
            "feed",
            "ui",
            "ux",
            "experience",
        ],
    },
];

export function sortBlogPosts(posts: BlogPost[]) {
    return [...posts].sort((left, right) => {
        const leftTime = left.data.date?.getTime() ?? 0;
        const rightTime = right.data.date?.getTime() ?? 0;

        if (leftTime !== rightTime) {
            return rightTime - leftTime;
        }

        return right.id.localeCompare(left.id);
    });
}

export function formatBlogDate(date?: Date) {
    if (!date) {
        return "Undated";
    }

    return new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);
}

export function estimateReadingTime(body: string) {
    const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(wordCount / 200));
}

export function createExcerpt(body: string, maxLength = 180) {
    const withoutCode = body.replace(/```[\s\S]*?```/g, "");
    const firstParagraph =
        withoutCode
            .split(/\n\s*\n/)
            .map((chunk) =>
                chunk
                    .replace(/^#+\s*/gm, "")
                    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
                    .replace(/[*_`>#]/g, "")
                    .replace(/\s+/g, " ")
                    .trim()
            )
            .find(Boolean) ?? "";

    if (!firstParagraph) {
        return "";
    }

    if (firstParagraph.length <= maxLength) {
        return firstParagraph;
    }

    return `${firstParagraph.slice(0, maxLength - 1).trimEnd()}…`;
}

export function createSearchText(post: BlogPost) {
    return [post.data.title, post.data.shortTitle, createExcerpt(post.body || "", 220)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
}

export function extractTopics(posts: BlogPost[], limit = 6) {
    const topics = TOPIC_DEFINITIONS.map((definition) => {
        const count = posts.reduce((total, post) => {
            const source = `${post.data.title} ${post.data.shortTitle ?? ""}`.toLowerCase();
            return definition.keywords.some((keyword) => source.includes(keyword))
                ? total + 1
                : total;
        }, 0);

        return {
            label: definition.label,
            query: definition.query,
            count,
        };
    });

    return topics
        .filter((topic) => topic.count > 0)
        .sort((left, right) => {
            if (left.count !== right.count) {
                return right.count - left.count;
            }

            return left.label.localeCompare(right.label);
        })
        .slice(0, limit);
}

export function formatCount(value: number) {
    return new Intl.NumberFormat("en").format(value);
}
