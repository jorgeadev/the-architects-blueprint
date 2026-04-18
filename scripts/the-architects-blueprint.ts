import * as fs from "fs";
import * as path from "path";
import { loadTopics, generateWithRetry } from "./utils";

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

function saveToDisk(content: string, imageUrl: string) {
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
        const frontmatter = `---\ntitle: "${frontmatterTitle}"\ndate: ${dateString}\nimage: "${imageUrl}"\n---\n\n`;
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
        fs.writeFileSync(configPath, JSON.stringify({ topics }, null, 2), "utf8");
        console.log(`Deducted processed topic. Total topics remaining in pool: ${topics.length}`);

        const content = await generateContent(randomTopic);
        console.log(content.substring(0, 1500) + "\n\n... [TRUNCATED] ...\n");

        const imagePromptPrompt = `Write a short, highly descriptive image generation prompt (max 60 words) for a blog post about: "${randomTopic}". Do not include any text, letters, or words in the generated image. Describe an aesthetic, highly technical, premium abstract representation (like server rooms, glowing data nodes, isometric architecture, etc). Only return the raw prompt text.`;
        console.log("Generating AI image prompt...");
        const imagePromptRaw = await generateWithRetry(imagePromptPrompt);
        const imagePrompt = imagePromptRaw.replace(/\n/g, " ").trim();
        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?width=1200&height=630&nologo=true`;
        console.log(`Generated image URL: ${imageUrl}`);

        saveToDisk(content, imageUrl);

        console.log("The Architect's Blueprint workflow completed.");
    } catch (e) {
        console.error("Failed executing generation pipe", e);
        process.exit(1);
    }
}

run();
