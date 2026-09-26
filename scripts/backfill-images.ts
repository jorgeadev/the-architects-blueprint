import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import {
    generateWithRetry,
    fetchImageBuffer,
    buildPollinationsImageUrl,
    createAbstractPlaceholderSvg,
} from "./utils";
import { installProcessErrorHandlers } from "./observability";

installProcessErrorHandlers("storage.image-backfill");

async function run() {
    const region = process.env.AWS_REGION;
    const bucket = process.env.S3_BUCKET_NAME;
    const publicBaseUrl = (
        process.env.IMAGE_STORAGE_PUBLIC_BASE_URL ??
        process.env.CONTENT_STORAGE_PUBLIC_BASE_URL ??
        ""
    ).replace(/\/$/, "");
    const databaseUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!region || !bucket || !publicBaseUrl) {
        throw new Error(
            "Cloud-first backfill requires AWS_REGION, S3_BUCKET_NAME, and CONTENT_STORAGE_PUBLIC_BASE_URL."
        );
    }
    if (!databaseUrl) {
        throw new Error("Cloud-first backfill requires DIRECT_DATABASE_URL or DATABASE_URL.");
    }
    const s3 = new S3Client({ region });
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });

    const posts = (
        await pool.query<{ slug: string; title: string; post_url: string }>(
            `SELECT p.slug, p.title, p.post_url
         FROM posts p
         WHERE p.post_url IS NOT NULL
           AND (p.image_path IS NULL OR btrim(p.image_path) = '')
           AND NOT EXISTS (
               SELECT 1 FROM images i
               WHERE i.post_id = p.id AND i.remote_url IS NOT NULL
           )
         ORDER BY p.published_date DESC, p.slug DESC`
        )
    ).rows;

    console.log(`Found ${posts.length} bucket articles with missing images...`);

    try {
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            const postName = post.slug.split("/").at(-1) ?? post.slug;
            console.log(`[${i + 1}/${posts.length}] Processing ${postName} to backfill image...`);

            try {
                const response = await fetch(post.post_url, {
                    headers: { Accept: "text/markdown" },
                });
                if (!response.ok) {
                    console.warn(
                        `   -> Markdown fetch returned ${response.status} for ${post.slug}. Skipping.`
                    );
                    continue;
                }
                const content = await response.text();
                const body = content.replace(/^---[\s\S]*?---\s*/, "");
                const title = post.title || "Complex engineering systems architecture";
                const imagePromptPrompt = `You are a highly creative technical art director.
I have a blog post titled "${title}". Here is a snippet of its actual content:
"""
${body.substring(0, 2000)}...
"""

Based on the actual nuances and metaphors discussed in this content, write a short, highly descriptive image generation prompt (max 60 words). 
CRITICAL RULES:
1. Do not include any text, letters, or words in the generated image. 
2. Be extremely creative and abstract. Do NOT just use "server rooms" or "glowing nodes" every time. 
3. Invent unique visual metaphors deeply related to the specific title and content (e.g. quantum mechanics, futuristic cities, vast crystalline networks, surreal circuitry landscapes). 
4. Pick a completely random distinct artistic style (e.g. synthwave, flat vector, hyperrealistic 3d render, cinematic lighting, cyberpunk, minimalistic abstract).
Only return the raw prompt text.`;

                console.log("   -> Generating AI prompt context...");
                const imagePromptRaw = await generateWithRetry(imagePromptPrompt);
                const imagePrompt = imagePromptRaw.replace(/\n/g, " ").trim();
                const imageUrl = buildPollinationsImageUrl(imagePrompt);

                console.log("   -> Fetching from pollinations.ai...");
                let imageBuffer = await fetchImageBuffer(imageUrl);
                let usedPlaceholderImage = false;

                if (!imageBuffer) {
                    console.warn(
                        `   -> Failed to download custom AI image for ${postName}. Falling back to a placeholder...`
                    );
                    imageBuffer = createAbstractPlaceholderSvg(title);
                    usedPlaceholderImage = true;
                }

                if (!imageBuffer) {
                    console.error(
                        `   -> Failed to retrieve both custom and fallback image buffer for ${postName}. Skipping.`
                    );
                    continue;
                }

                // Publish the image directly to object storage.
                const imageKey = `images/${post.slug}${usedPlaceholderImage ? ".svg" : ".jpg"}`;
                await s3.send(
                    new PutObjectCommand({
                        Bucket: bucket,
                        Key: imageKey,
                        Body: imageBuffer,
                        ContentType: usedPlaceholderImage ? "image/svg+xml" : "image/jpeg",
                        CacheControl: "public, max-age=31536000, immutable",
                    })
                );

                const publicImageUrl = `${publicBaseUrl}/${imageKey}`;
                console.log(`   -> Published image to ${publicImageUrl}`);

                await pool.query(
                    "UPDATE posts SET image_path = $1, updated_at = now() WHERE slug = $2",
                    [publicImageUrl, post.slug]
                );
                console.log(`   -> Database image URL updated for ${post.slug}.`);

                await new Promise((resolve) => setTimeout(resolve, 3000));
            } catch (e) {
                console.error(`Fatal error processing ${post.slug}:`, e);
            }
        }
    } finally {
        await pool.end();
    }

    console.log("\nFinished backfilling bucket images.");
}

run();
