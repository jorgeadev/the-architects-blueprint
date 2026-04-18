import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";

// Initialize configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY as string;

if (!GEMINI_API_KEY) {
    console.error("Missing GEMINI_API_KEY from environment.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

async function loadTopics(): Promise<{ topics: string[]; configPath: string }> {
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

async function generateWithRetry(prompt: string): Promise<string> {
    const maxRetries = 5;
    let baseDelay = 15000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await model.generateContent(prompt);
            return result.response.text();
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
                    `Service unavailable or rate limited. Retrying in ${baseDelay / 1000} seconds...`
                );
                await new Promise((resolve) => setTimeout(resolve, baseDelay));
                baseDelay *= 2;
            } else {
                return Promise.reject(e);
            }
        }
    }
    return Promise.reject(new Error("Failed to generate content"));
}

async function generateContent(randomTopic: string): Promise<string> {
    const prompt = `
Write an incredibly engaging, highly technical, and conversational blog post about the following topic: 
"${randomTopic}"

Requirements for the blog post:
- It should feel like a premium engineering blog post (similar to those by Cloudflare, Uber Engineering, or Netflix TechBlog).
- Use a catchy, attention-grabbing # Title at the very top.
- Include a brief hook or introduction that pulls the reader in immediately.
- Dive deep into the technical architecture, infrastructure details, compute scale, or engineering curiosities relevant to the topic.
- If the topic involves recent tech news or hype, narrate the context of the hype, why it gained attention, and the actual technical substance behind it.
- Use clear headings, bullet points, code snippets (if applicable), and bold text for emphasis to make it highly readable and scannable.
- Maintain an enthusiastic and expert tone.
- Do not use academic terms like "Abstract", "Conclusion", or "Thesis statement".
- Write an extensive, deep-dive article (around 2000 to 3500 words) that provides profound insights, not a superficial summary. Use markdown formatting.
`;

    console.log("Generating blog post using Google Gemini...");
    return await generateWithRetry(prompt);
}

async function generateNewTopics(amount: number): Promise<string[]> {
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

function saveToDisk(content: string) {
    const rootDir = process.cwd();
    const articlesDir = path.join(rootDir, "web", "src", "content", "blog");

    if (!fs.existsSync(articlesDir)) {
        fs.mkdirSync(articlesDir, { recursive: true });
    }

    let titleSlug = new Date().toISOString().split("T")[0];
    const titleMatch = content.match(/^#\s+(.+)$/m);

    if (titleMatch && titleMatch[1]) {
        const cleanTitle = titleMatch[1]
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "");

        titleSlug = `${titleSlug}-${cleanTitle}`;
    }

    if (titleSlug.length > 60) {
        titleSlug = titleSlug.substring(0, 60);
    }

    const fileName = `${titleSlug}.md`;
    const filePath = path.join(articlesDir, fileName);

    let finalContent = content;
    if (titleMatch && titleMatch[1]) {
        const frontmatterTitle = titleMatch[1].replace(/"/g, "\\\"");
        const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})/);
        const dateString = dateMatch ? dateMatch[1] : "";
        const frontmatter = `---\ntitle: "${frontmatterTitle}"\ndate: ${dateString}\n---\n\n`;
        finalContent = frontmatter + content.replace(titleMatch[0], "");
    }

    fs.writeFileSync(filePath, finalContent, "utf8");
    console.log(`\nSuccessfully saved thesis to: ${filePath}`);
}

async function run() {
    try {
        const { topics, configPath } = await loadTopics();
        const randomIndex = Math.floor(Math.random() * topics.length);
        const randomTopic = topics[randomIndex];
        console.log(`Selected topic: ${randomTopic}`);

        topics.splice(randomIndex, 1);

        // Infinite topic generation
        const amountToGenerate = topics.length < 20 ? 10 : 5;
        const newTopics = await generateNewTopics(amountToGenerate);

        if (newTopics.length > 0) {
            topics.push(...newTopics);
            fs.writeFileSync(configPath, JSON.stringify({ topics }, null, 2), "utf8");
            console.log(
                `Successfully rotated topics. Deducted 1, added ${newTopics.length}. Total topics in pool: ${topics.length}`
            );
        } else {
            console.log(
                "Skipping topic rotation because AI failed to generate valid JSON or rate limited."
            );
        }

        const content = await generateContent(randomTopic);
        console.log(content.substring(0, 1500) + "\n\n... [TRUNCATED] ...\n");

        saveToDisk(content);

        console.log("The Architect's Blueprint workflow completed.");
    } catch (e) {
        console.error("Failed executing generation pipe", e);
        process.exit(1);
    }
}

run();
