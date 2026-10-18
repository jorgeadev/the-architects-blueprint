import {
    generateWithGemini,
    generateWithGrok,
    generateWithOpenRouter,
    generateWithDeepSeek,
} from "./ai-service";

// ==========================================
// CONFIGURATION
// Choose ONE fallback provider explicitly: "DeepSeek" | "Grok" | "OpenRouter"
// ==========================================
export const FALLBACK_PROVIDER: "DeepSeek" | "Grok" | "OpenRouter" = "DeepSeek";

const MAX_IMAGE_PROMPT_CHARS = 220;

function normalizeImagePrompt(prompt: string): string {
    return prompt
        .replace(/\*\*/g, "")
        .replace(/:/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_IMAGE_PROMPT_CHARS)
        .trim();
}

function hashString(value: string): number {
    let hash = 0;

    for (let index = 0; index < value.length; index++) {
        hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }

    return hash;
}

export function buildPollinationsImageUrl(prompt: string): string {
    const normalizedPrompt =
        normalizeImagePrompt(prompt) || "abstract biological circuitry landscape";
    return `${process.env.POLLINATIONS_BASE_URL ?? "https://gen.pollinations.ai/image"}/${encodeURIComponent(normalizedPrompt)}?model=flux&width=1024&height=1024`;
}

export function createAbstractPlaceholderSvg(seedText: string): Buffer {
    const hash = hashString(seedText || "fallback");
    const hueA = hash % 360;
    const hueB = (hash * 7) % 360;
    const hueC = (hash * 13) % 360;
    const drift = 120 + (hash % 180);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
    <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="hsl(${hueA} 48% 12%)" />
            <stop offset="55%" stop-color="hsl(${hueB} 44% 18%)" />
            <stop offset="100%" stop-color="hsl(${hueC} 38% 10%)" />
        </linearGradient>
        <radialGradient id="pulse" cx="50%" cy="45%" r="45%">
            <stop offset="0%" stop-color="hsla(${hueB}, 90%, 72%, 0.95)" />
            <stop offset="55%" stop-color="hsla(${hueC}, 90%, 60%, 0.35)" />
            <stop offset="100%" stop-color="hsla(${hueA}, 90%, 55%, 0)" />
        </radialGradient>
        <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="22" />
        </filter>
    </defs>
    <rect width="1024" height="1024" fill="url(#bg)" />
    <circle cx="512" cy="460" r="290" fill="url(#pulse)" filter="url(#blur)" />
    <path d="M120 700 C 260 ${drift} 380 920 520 640 C 650 360 790 760 930 420" fill="none" stroke="hsla(${hueB}, 88%, 72%, 0.7)" stroke-width="18" stroke-linecap="round" />
    <path d="M100 360 C 240 240 360 320 500 210 C 650 90 780 300 930 170" fill="none" stroke="hsla(${hueC}, 80%, 68%, 0.58)" stroke-width="12" stroke-linecap="round" />
    <g fill="none" stroke-linecap="round">
        <path d="M180 840 C 300 760 390 760 520 830 C 650 900 770 900 860 820" stroke="hsla(${hueA}, 95%, 75%, 0.45)" stroke-width="10" />
        <path d="M210 210 C 330 270 430 270 540 205 C 650 140 760 150 820 230" stroke="hsla(${hueB}, 95%, 70%, 0.4)" stroke-width="8" />
    </g>
    <g fill="hsla(${hueC}, 90%, 80%, 0.8)">
        <circle cx="220" cy="650" r="10" />
        <circle cx="320" cy="560" r="7" />
        <circle cx="420" cy="470" r="9" />
        <circle cx="620" cy="430" r="8" />
        <circle cx="720" cy="520" r="11" />
        <circle cx="820" cy="640" r="7" />
    </g>
</svg>`;

    return Buffer.from(svg, "utf8");
}

export async function fetchImageBuffer(url: string): Promise<Buffer | null> {
    try {
        const headers: Record<string, string> = {};
        if (process.env.POLLINATIONS_API_KEY) {
            headers["Authorization"] = `Bearer ${process.env.POLLINATIONS_API_KEY}`;
        }
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        console.error("Failed to download image from API:", error);
        return null;
    }
}

export async function generateWithRetry(prompt: string): Promise<string> {
    const maxRetries = 5;
    let baseDelay = 15000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await generateWithGemini(prompt);
        } catch (e: unknown) {
            console.error(`Error generating content on attempt ${attempt}`);
            if (attempt === maxRetries) {
                console.error("Max retries reached. Failing.");
                return Promise.reject(e);
            }

            const errMsg = e instanceof Error ? e.message : String(e);
            const status = (e as Record<string, unknown>)?.status;
            if (
                status === 503 ||
                status === 429 ||
                errMsg.includes("503") ||
                errMsg.includes("429") ||
                errMsg.includes("high demand")
            ) {
                console.log(
                    `Gemini is unavailable or rate limited. Instantly failing over to ${FALLBACK_PROVIDER}...`
                );
                try {
                    if (FALLBACK_PROVIDER === "DeepSeek") {
                        return await generateWithDeepSeek(prompt);
                    } else if (FALLBACK_PROVIDER === "Grok") {
                        return await generateWithGrok(prompt);
                    } else if (FALLBACK_PROVIDER === "OpenRouter") {
                        return await generateWithOpenRouter(prompt);
                    }
                } catch {
                    console.log(
                        `${FALLBACK_PROVIDER} fallback also failed. Falling back to retry queue in ${baseDelay / 1000} seconds...`
                    );
                    await new Promise((resolve) => setTimeout(resolve, baseDelay));
                    baseDelay *= 2;
                }
            } else {
                return Promise.reject(e);
            }
        }
    }
    return Promise.reject(new Error("Failed to generate content"));
}

export async function generateNewTopics(
    amount: number,
    excludedTopics: string[] = [],
    attempt = 1
): Promise<string[]> {
    const exclusions = excludedTopics.length
        ? `\nDo not repeat or closely rephrase any of these topics:\n${JSON.stringify(excludedTopics)}\n`
        : "";
    const prompt = `
Generate exactly ${amount} distinct, technically grounded blog post topics for software and infrastructure engineers. Match the existing pool's focus on AI systems, databases, networking, storage, cloud infrastructure, security, and reliability.
Choose a focused topic with enough public documentation and technical depth for an accurate 2,000–3,500 word engineering article. Do not invent company internals, incidents, benchmarks, scale claims, or product features. Use a company-specific case study only when it is based on publicly documented material. Avoid near-duplicates and sensational claims.
This is generation attempt ${attempt}; produce a fresh candidate rather than repeating a previous response.
${exclusions}
DO NOT output any markdown formatting, text, or explanations. 
Output ONLY a raw JSON array of ${amount} strings. Example format:
[
  "How request batching changes latency and throughput in model serving"
]
`;

    console.log(`Generating ${amount} new topics to replenish the pool...`);
    let text = "";
    try {
        text = await generateWithRetry(prompt);
    } catch (error) {
        console.error("Failed to generate replacement topic.", error);
        throw error;
    }

    try {
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start !== -1 && end !== -1) {
            const jsonText = text.substring(start, end + 1);
            const parsed = JSON.parse(jsonText);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed
                    .filter((topic): topic is string => typeof topic === "string")
                    .slice(0, amount);
            }
        }
    } catch {
        console.error("Failed to parse the new topics output:", text);
    }
    return [];
}

export async function generateReplacementTopic(
    consumedTopic: string,
    currentTopics: string[]
): Promise<string> {
    const excludedTopics = [...new Set([...currentTopics, consumedTopic])];
    const normalize = (topic: string): string =>
        topic
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim()
            .replace(/\s+/g, " ");
    const ignoredWords = new Set([
        "a",
        "an",
        "and",
        "at",
        "behind",
        "for",
        "from",
        "how",
        "in",
        "into",
        "of",
        "on",
        "or",
        "the",
        "to",
        "using",
        "with",
        "architecture",
        "architecting",
        "design",
        "designing",
        "system",
        "systems",
        "scale",
        "scaling",
        "deep",
        "dive",
        "trade",
        "offs",
        "engineering",
        "explained",
    ]);
    const words = (topic: string): Set<string> =>
        new Set(
            normalize(topic)
                .split(" ")
                .filter((word) => word.length > 2 && !ignoredWords.has(word))
        );

    for (let attempt = 1; attempt <= 4; attempt++) {
        const [candidate] = await generateNewTopics(1, excludedTopics, attempt);
        const replacement = candidate?.trim().replace(/\s+/g, " ");
        if (!replacement || replacement.length < 30 || replacement.length > 180) {
            continue;
        }

        const replacementKey = normalize(replacement);
        const replacementWords = words(replacement);
        if (replacementWords.size < 4) {
            continue;
        }
        const isDuplicate = excludedTopics.some((existingTopic) => {
            if (normalize(existingTopic) === replacementKey) {
                return true;
            }
            const existingWords = words(existingTopic);
            const intersectionSize = [...replacementWords].filter((word) =>
                existingWords.has(word)
            ).length;
            const unionSize = new Set([...replacementWords, ...existingWords]).size;
            return unionSize > 0 && intersectionSize / unionSize >= 0.72;
        });

        if (!isDuplicate) {
            return replacement;
        }

        excludedTopics.push(replacement);
        console.warn(
            `Generated replacement topic was too similar to the pool (attempt ${attempt}/4).`
        );
    }

    throw new Error("Could not generate a unique replacement topic after four attempts.");
}
