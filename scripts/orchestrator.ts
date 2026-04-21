import * as fs from "fs";
import * as path from "path";
import { generateNewTopics } from "./utils";
import { loadTopics, generateWithRetry, fetchImageBuffer } from "./utils";

// Initialize configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY as string;

if (!GEMINI_API_KEY) {
    console.error("Missing GEMINI_API_KEY from environment.");
    process.exit(1);
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

async function saveToDisk(content: string, localImagePath: string) {
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
        const shortTitleRaw = await generateWithRetry(
            `Summarize this title into a short, impactful version (maximum 100 characters) that summarizes the core topic. Do not use markdown, quotes, emojis, or conversational text. Output ONLY the short title. Original Title: "${frontmatterTitle}"`
        );
        const shortTitle = shortTitleRaw.replace(/"/g, "\\\"").replace(/\n/g, "").trim();

        const frontmatter = `---
title: "${frontmatterTitle}"
shortTitle: "${shortTitle}"
date: ${dateString}
image: "${localImagePath}"
---

`;
        finalContent = frontmatter + content.replace(titleMatch[0], "");
    }

    fs.writeFileSync(filePath, finalContent, "utf8");
    console.log(`\nSuccessfully saved thesis to: ${filePath}`);
}

async function orchestrate() {
    try {
        console.log("Starting centralized automation pipeline...");

        // 1. Fetch Topics
        const { topics, configPath } = await loadTopics();
        if (topics.length === 0) {
            console.error("Critical: Topic pool is completely empty. Aborting pipeline.");
            process.exit(1);
        }

        const randomIndex = Math.floor(Math.random() * topics.length);
        const randomTopic = topics[randomIndex];
        console.log(`Selected topic: ${randomTopic}`);

        // Deduct topic locally first so we can save state immediately
        topics.splice(randomIndex, 1);

        // 2. Generate Blog Post Content (CRITICAL PATH)
        let content;
        try {
            content = await generateContent(randomTopic);
            console.log(content.substring(0, 1500) + "\n\n... [TRUNCATED] ...\n");
        } catch (e) {
            console.error("Critical Failure in Blog Post Generation. Aborting pipeline.", e);
            process.exit(1);
        }

        // 3. Generate Image using AI (CRITICAL PATH)
        let imageUrlPath = "";
        try {
            const imagePromptPrompt = `You are a highly creative technical art director. 
I have a blog post about "${randomTopic}". Here is a snippet of its actual content:
"""
${content.substring(0, 2000)}...
"""

Based on the actual nuances and metaphors discussed in this content, write a short, highly descriptive image generation prompt (max 260 words). 
CRITICAL RULES:
1. Do not include any text, letters, or words in the generated image. 
2. Be extremely creative and abstract. Do NOT just use "server rooms" or "glowing nodes" every time. 
3. Invent unique visual metaphors deeply related to the specific topic and content (e.g. quantum mechanics, futuristic cities, vast crystalline networks, surreal circuitry landscapes). 
4. Pick a completely random distinct artistic style (e.g. synthwave, flat vector, hyperrealistic 3d render, cinematic lighting, cyberpunk, minimalistic abstract).
Only return the raw prompt text.`;
            console.log("Prompt sent to image generator:\n" + imagePromptPrompt);
            console.log("Generating AI image prompt...");
            const imagePromptRaw = await generateWithRetry(imagePromptPrompt);
            console.log("Processed image prompt:\n" + imagePromptRaw);
            const imagePrompt = imagePromptRaw.replace(/\n/g, " ").trim();
            const randomSeed = Math.floor(Math.random() * 10000000);
            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?width=1200&height=630&nologo=true&seed=${randomSeed}`;
            console.log(`Generated image URL: ${imageUrl}`);

            console.log("Downloading image buffer...");
            const imageBuffer = await fetchImageBuffer(imageUrl);

            if (!imageBuffer) {
                console.error("Failed to receive image buffer. Aborting pipeline.");
                process.exit(1);
            }

            // Figure out image slug based on post slug schema
            let imageSlug = new Date().toISOString().split("T")[0];
            const titleMatch = content.match(/^#\s+(.+)$/m);
            if (titleMatch && titleMatch[1]) {
                const cleanTitle = titleMatch[1]
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/(^-|-$)/g, "");
                imageSlug = `${imageSlug}-${cleanTitle}`;
            }
            if (imageSlug.length > 60) {
                imageSlug = imageSlug.substring(0, 60);
            }

            const imageFileName = `${imageSlug}.jpg`;
            const imageDir = path.join(process.cwd(), "web", "public", "images");

            if (!fs.existsSync(imageDir)) {
                fs.mkdirSync(imageDir, { recursive: true });
            }

            const absoluteImagePath = path.join(imageDir, imageFileName);
            fs.writeFileSync(absoluteImagePath, imageBuffer);
            console.log(`Successfully saved image natively to: ${absoluteImagePath}`);

            // This is the public path the browser requests
            imageUrlPath = `/images/${imageFileName}`;
        } catch (e) {
            console.error("Critical Failure in Image Generation. Aborting pipeline.", e);
            process.exit(1);
        }

        // 4. Save Blog Content with local Image Link and generate Short Title
        await saveToDisk(content, imageUrlPath);

        // 5. Replenish Topics (NON-CRITICAL PATH)
        try {
            console.log("Attempting topic pool replenishment...");
            const amountToGenerate = topics.length < 20 ? 10 : 3;
            const newTopics = await generateNewTopics(amountToGenerate);

            if (newTopics.length > 0) {
                topics.push(...newTopics);
                fs.writeFileSync(configPath, JSON.stringify({ topics }, null, 2), "utf8");
                console.log(
                    `Successfully rotated topics. Deducted 1, added ${newTopics.length}. Total topics in pool: ${topics.length}`
                );
            } else {
                console.log(
                    "No new topics generated (rate limited or empty). Saving current pool with deductive state."
                );
                fs.writeFileSync(configPath, JSON.stringify({ topics }, null, 2), "utf8");
            }
        } catch (e) {
            console.error(
                "Non-critical failure: topic generation failed. We'll still save current deductive state.",
                e
            );
            fs.writeFileSync(configPath, JSON.stringify({ topics }, null, 2), "utf8");
        }

        console.log(
            "Centralized pipeline successfully completed. State is prepared for atomic commit."
        );
    } catch (e) {
        console.error("Fatal exception in main orchestrator loop.", e);
        process.exit(1);
    }
}

orchestrate();
