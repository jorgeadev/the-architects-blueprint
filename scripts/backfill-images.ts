import * as fs from "fs";
import * as path from "path";
import { generateWithRetry, fetchImageBuffer } from "./utils";

async function run() {
    const rootDir = process.cwd();
    const blogDir = path.join(rootDir, "web", "src", "content", "blog");
    const imageDir = path.join(rootDir, "web", "public", "images");

    if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
    }

    const files = fs.readdirSync(blogDir).filter((f) => f.endsWith(".md"));

    console.log(`Found ${files.length} markdown articles. Checking for missing images...`);

    for (let i = 0; i < files.length; i++) {
        const fileName = files[i];
        const filePath = path.join(blogDir, fileName);
        const content = fs.readFileSync(filePath, "utf8");

        // Check if the file already has an image tag in its frontmatter
        if (content.includes("\nimage: ") || content.includes("\r\nimage: ")) {
            console.log(`[${i + 1}/${files.length}] Skipping ${fileName} - Image already exists.`);
            continue;
        }

        console.log(`[${i + 1}/${files.length}] Processing ${fileName} to backfill image...`);

        // Parse title from frontmatter to use as prompt context
        let title = "Complex engineering systems architecture";
        const titleMatch =
            content.match(/^title:\s*"(.*)"\s*$/m) || content.match(/^title:\s*(.*)\s*$/m);
        if (titleMatch && titleMatch[1]) {
            title = titleMatch[1];
        }

        try {
            // Generate Image Prompt based on ACTUAL CONTENT
            const imagePromptPrompt = `You are a highly creative technical art director. 
I have a blog post titled "${title}". Here is a snippet of its actual content:
"""
${content.substring(0, 2000)}...
"""

Based on the actual nuances and metaphors discussed in this content, write a short, highly descriptive image generation prompt (max 60 words). 
CRITICAL RULES:
1. Do not include any text, letters, or words in the generated image. 
2. Be extremely creative and abstract. Do NOT just use "server rooms" or "glowing nodes" every time. 
3. Invent unique visual metaphors deeply related to the specific title and content (e.g. quantum mechanics, futuristic cities, vast crystalline networks, surreal circuitry landscapes). 
4. Pick a completely random distinct artistic style (e.g. synthwave, flat vector, hyperrealistic 3d render, cinematic lighting, cyberpunk, minimalistic abstract).
Only return the raw prompt text.`;

            console.log("   -> Generating AI prompt context...");
            console.log("Prompt sent to image generator:\n" + imagePromptPrompt);
            const imagePromptRaw = await generateWithRetry(imagePromptPrompt);
            const imagePrompt = imagePromptRaw.replace(/\n/g, " ").trim();
            const randomSeed = Math.floor(Math.random() * 10000000);
            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?width=1200&height=630&nologo=true&seed=${randomSeed}`;

            console.log("   -> Fetching from pollinations.ai...");
            const imageBuffer = await fetchImageBuffer(imageUrl);

            if (!imageBuffer) {
                console.error(
                    `   -> Failed to retrieve AI Image buffer for ${fileName}. Skipping.`
                );
                continue;
            }

            // Save image identically to the existing slug pattern
            const baseSlug = fileName.replace(/\.md$/, "");
            const imageFileName = `${baseSlug}.jpg`;
            const absoluteImagePath = path.join(imageDir, imageFileName);

            fs.writeFileSync(absoluteImagePath, imageBuffer);
            console.log(`   -> Downloaded local image to /images/${imageFileName}`);

            // Replace frontmatter block directly to inject the image path safely
            const publicImageUrl = `/images/${imageFileName}`;
            const newContent = content.replace(/^---\s*$/m, `---\nimage: "${publicImageUrl}"`);

            fs.writeFileSync(filePath, newContent, "utf8");
            console.log(`   -> Frontmatter updated for ${fileName}.`);

            // small delay to prevent rapid-fire throttling from generation
            await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch (e) {
            console.error(`Fatal error processing ${fileName}:`, e);
        }
    }

    console.log("\nFinished backfilling all missing images to public repository!");
}

run();
