import * as fs from "fs";
import * as path from "path";
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

export async function fetchImageBuffer(url: string): Promise<Buffer | null> {
    try {
        // Native fetch fallback
        const response = await fetch(url);
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

export async function loadTopics(): Promise<{ topics: string[]; configPath: string }> {
    const configPath = path.join(process.cwd(), "config", "topics.json");
    let topics = [
        "The engineering behind Twitter/X: transitioning from a monolith to microservices and how they handle viral hype spikes.",
    ];
    if (fs.existsSync(configPath)) {
        try {
            const configContent = fs.readFileSync(configPath, "utf8");
            const parsedConfig = JSON.parse(configContent);
            if (Array.isArray(parsedConfig.topics) && parsedConfig.topics.length > 0) {
                topics = parsedConfig.topics;
            }
        } catch {
            console.error("Failed to parse topics.json");
        }
    }
    return { topics, configPath };
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

export async function generateNewTopics(amount: number): Promise<string[]> {
    const prompt = `
Generate exactly ${amount} brand new, highly technical blog post topics about big tech infrastructure, massive scale systems architecture, or viral engineering news.
DO NOT output any markdown formatting, text, or explanations. 
Output ONLY a raw JSON array of ${amount} strings. Example format:
[
  "The architecture behind...",
  "An in-depth analysis of...",
  "How [Company] scaled..."
]
`;

    console.log(`Generating ${amount} new topics to replenish the pool...`);
    let text = "";
    try {
        text = await generateWithRetry(prompt);
    } catch {
        console.error("Skipping topic replenishment due to persistent rate limiting.");
        return [];
    }

    try {
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start !== -1 && end !== -1) {
            const jsonText = text.substring(start, end + 1);
            const parsed = JSON.parse(jsonText);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed;
            }
        }
    } catch {
        console.error("Failed to parse the new topics output:", text);
    }
    return [];
}
