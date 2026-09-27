import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import {
    generateNewTopics,
    generateWithRetry,
    fetchImageBuffer,
    buildPollinationsImageUrl,
    createAbstractPlaceholderSvg,
} from "./utils";
import { installProcessErrorHandlers, scriptLog } from "./observability";
import {
    addTopics,
    createTopicPool,
    ensureTopicStore,
    getTopicCount,
    getTopics,
    removeTopic,
} from "./topic-store";

installProcessErrorHandlers("generation.orchestrator");

// Initialize configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY as string;
const AWS_REGION = process.env.AWS_REGION;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const STORAGE_PUBLIC_BASE_URL = (
    process.env.IMAGE_STORAGE_PUBLIC_BASE_URL ??
    process.env.CONTENT_STORAGE_PUBLIC_BASE_URL ??
    ""
).replace(/\/$/, "");

if (!GEMINI_API_KEY) {
    scriptLog("fatal", "generation.orchestrator", "configuration.missing_gemini_api_key");
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

function requiredCloudEnv(): { client: S3Client; bucket: string; publicBaseUrl: string } {
    if (!AWS_REGION || !S3_BUCKET_NAME || !STORAGE_PUBLIC_BASE_URL) {
        throw new Error(
            "Cloud-first generation requires AWS_REGION, S3_BUCKET_NAME, and CONTENT_STORAGE_PUBLIC_BASE_URL (or IMAGE_STORAGE_PUBLIC_BASE_URL)."
        );
    }
    return {
        client: new S3Client({ region: AWS_REGION }),
        bucket: S3_BUCKET_NAME,
        publicBaseUrl: STORAGE_PUBLIC_BASE_URL,
    };
}

function slugFromContent(content: string): string {
    const titleMatch = content.match(/^#\s+(.+)$/m);
    return titleMatch?.[1]
        ? titleMatch[1]
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "")
            .substring(0, 60)
        : "untitled";
}

function publicUrl(baseUrl: string, key: string): string {
    return `${baseUrl}/${key}`;
}

type NeonPostSync = {
    slug: string;
    title: string;
    shortTitle: string | null;
    publishedDate: string;
    imageUrl: string;
    imageKey: string;
    contentUrl: string;
    excerpt: string;
    wordCount: number;
    isPlaceholder: boolean;
};

async function syncPostToNeon(post: NeonPostSync): Promise<void> {
    const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error("Post synchronization requires DIRECT_DATABASE_URL or DATABASE_URL.");
    }

    const pool = new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query<{ id: number }>(
            `INSERT INTO posts
                (slug, title, short_title, published_date, image_path, word_count, post_url, excerpt, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
             ON CONFLICT (slug) DO UPDATE SET
                title = EXCLUDED.title,
                short_title = EXCLUDED.short_title,
                published_date = EXCLUDED.published_date,
                image_path = EXCLUDED.image_path,
                word_count = EXCLUDED.word_count,
                post_url = EXCLUDED.post_url,
                excerpt = EXCLUDED.excerpt,
                updated_at = now()
             RETURNING id`,
            [
                post.slug,
                post.title,
                post.shortTitle,
                post.publishedDate,
                post.imageUrl,
                post.wordCount,
                post.contentUrl,
                post.excerpt,
            ]
        );

        const postId = result.rows[0]?.id;
        if (!postId) {
            throw new Error(`Neon did not return an id for post ${post.slug}.`);
        }

        const existingImage = await client.query(
            `UPDATE images
             SET local_path = $1,
                 is_placeholder = $2,
                 remote_url = $3,
                 created_at = now()
             WHERE post_id = $4 AND remote_url = $3`,
            [post.imageKey, post.isPlaceholder, post.imageUrl, postId]
        );

        if (existingImage.rowCount === 0) {
            await client.query(
                `INSERT INTO images
                    (post_id, local_path, source_url, is_placeholder, remote_url)
                 VALUES ($1, $2, $3, $4, $5)`,
                [postId, post.imageKey, null, post.isPlaceholder, post.imageUrl]
            );
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

type ManifestPost = {
    slug: string;
    title: string;
    shortTitle: string | null;
    date: string;
    imageUrl: string | null;
    contentUrl: string;
    excerpt: string;
    wordCount: number;
};

async function readManifest(client: S3Client, bucket: string): Promise<ManifestPost[]> {
    try {
        const response = await client.send(
            new GetObjectCommand({ Bucket: bucket, Key: "posts/index.json" })
        );
        const raw = await response.Body?.transformToString("utf8");
        return raw ? (JSON.parse(raw) as ManifestPost[]) : [];
    } catch (error) {
        if (error instanceof Error && error.name === "NoSuchKey") {
            return [];
        }
        throw error;
    }
}

async function publishManifest(
    client: S3Client,
    bucket: string,
    posts: ManifestPost[]
): Promise<void> {
    posts.sort((left, right) => right.date.localeCompare(left.date));
    await client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: "posts/index.json",
            Body: JSON.stringify(posts),
            ContentType: "application/json; charset=utf-8",
            CacheControl: "public, max-age=60, must-revalidate",
        })
    );
}

async function saveToCloud(
    content: string,
    imageBuffer: Buffer,
    imageFileName: string,
    usedPlaceholderImage: boolean
) {
    const { client, bucket, publicBaseUrl } = requiredCloudEnv();
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const dateString = `${year}-${month}-${day}`;

    const titleMatch = content.match(/^#\s+(.+)$/m);
    const titleSlug = slugFromContent(content);
    const contentKey = `posts/${year}/${month}/${day}/${titleSlug}.md`;
    const imageKey = `images/${year}/${month}/${day}/${imageFileName}`;

    let finalContent = content;
    let shortTitle: string | null = null;
    if (titleMatch && titleMatch[1]) {
        const frontmatterTitle = titleMatch[1].replace(/"/g, "\\\"");
        const shortTitleRaw = await generateWithRetry(
            `Summarize this title into a short, impactful version (maximum 100 characters) that summarizes the core topic. Do not use markdown, quotes, emojis, or conversational text. Output ONLY the short title. Original Title: "${frontmatterTitle}"`
        );
        shortTitle = shortTitleRaw.replace(/\n/g, "").trim();
        const frontmatterShortTitle = shortTitle.replace(/"/g, "\\\"");

        const frontmatter = `---
title: "${frontmatterTitle}"
shortTitle: "${frontmatterShortTitle}"
date: ${dateString}
image: "${publicUrl(publicBaseUrl, imageKey)}"
---

`;
        finalContent = frontmatter + content.replace(titleMatch[0], "");
    }

    await client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: imageKey,
            Body: imageBuffer,
            ContentType: usedPlaceholderImage ? "image/svg+xml" : "image/jpeg",
            CacheControl: "public, max-age=31536000, immutable",
        })
    );
    await client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: contentKey,
            Body: finalContent,
            ContentType: "text/markdown; charset=utf-8",
            CacheControl: "public, max-age=31536000, immutable",
        })
    );

    const manifest = await readManifest(client, bucket);
    const nextPost: ManifestPost = {
        slug: `${year}/${month}/${day}/${titleSlug}`,
        title: titleMatch?.[1] ?? titleSlug,
        shortTitle,
        date: dateString,
        imageUrl: publicUrl(publicBaseUrl, imageKey),
        contentUrl: publicUrl(publicBaseUrl, contentKey),
        excerpt: finalContent
            .replace(/^---[\s\S]*?---\s*/, "")
            .replace(/[#*_>`]/g, "")
            .trim()
            .slice(0, 260),
        wordCount: finalContent.split(/\s+/).filter(Boolean).length,
    };
    await syncPostToNeon({
        slug: nextPost.slug,
        title: nextPost.title,
        shortTitle: nextPost.shortTitle,
        publishedDate: nextPost.date,
        imageUrl: nextPost.imageUrl ?? publicUrl(publicBaseUrl, imageKey),
        imageKey,
        contentUrl: nextPost.contentUrl,
        excerpt: nextPost.excerpt,
        wordCount: nextPost.wordCount,
        isPlaceholder: usedPlaceholderImage,
    });
    scriptLog("info", "generation.orchestrator", "database.post_synchronized", {
        slug: nextPost.slug,
    });
    await publishManifest(client, bucket, [
        nextPost,
        ...manifest.filter((post) => post.slug !== nextPost.slug),
    ]);
    console.log(`\nSuccessfully published Markdown, image, and manifest to s3://${bucket}`);
}

async function orchestrate() {
    let topicPool: Pool | null = null;
    try {
        console.log("Starting centralized automation pipeline...");

        // 1. Load topic rotation state from Neon, seeding it from config once.
        topicPool = createTopicPool();
        await ensureTopicStore(topicPool);
        const topics = await getTopics(topicPool);
        if (topics.length === 0) {
            throw new Error(
                "Topic pool is empty. Add seed topics to config/topics.json or replenish Neon."
            );
        }

        const randomIndex = Math.floor(Math.random() * topics.length);
        const randomTopic = topics[randomIndex];
        console.log(`Selected topic: ${randomTopic}`);

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
            const imageUrl = buildPollinationsImageUrl(imagePrompt);
            console.log(`Generated image URL: ${imageUrl}`);

            console.log("Downloading image buffer...");
            let imageBuffer = await fetchImageBuffer(imageUrl);
            let usedPlaceholderImage = false;

            if (!imageBuffer) {
                console.warn(
                    "Failed to download custom AI image. Falling back to a reliable abstract placeholder image..."
                );
                imageBuffer = createAbstractPlaceholderSvg(randomTopic);
                usedPlaceholderImage = true;
            }

            if (!imageBuffer) {
                console.error(
                    "Critical: Failed to retrieve both custom and fallback image buffer. Aborting pipeline."
                );
                process.exit(1);
            }

            const titleMatch = content.match(/^#\s+(.+)$/m);
            let imageSlug = "untitled";
            if (titleMatch && titleMatch[1]) {
                imageSlug = titleMatch[1]
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/(^-|-$)/g, "")
                    .substring(0, 60);
            }

            const imageFileName = `${imageSlug}${usedPlaceholderImage ? ".svg" : ".jpg"}`;
            await saveToCloud(content, imageBuffer, imageFileName, usedPlaceholderImage);
            await removeTopic(topicPool, randomTopic);
        } catch (e) {
            console.error("Critical Failure in Image Generation. Aborting pipeline.", e);
            process.exit(1);
        }

        // 4. Replenish Topics (NON-CRITICAL PATH)
        try {
            console.log("Attempting topic pool replenishment...");
            const topicCount = await getTopicCount(topicPool);
            const amountToGenerate = topicCount < 20 ? 10 : 3;
            const newTopics = await generateNewTopics(amountToGenerate);

            if (newTopics.length > 0) {
                const addedCount = await addTopics(topicPool, newTopics);
                console.log(
                    `Successfully rotated topics. Deducted 1, added ${addedCount}. Total topics in pool: ${await getTopicCount(topicPool)}`
                );
            } else {
                console.log(
                    "No new topics generated (rate limited or empty). The consumed topic remains removed from Neon."
                );
            }
        } catch (e) {
            console.error("Non-critical failure: topic replenishment failed.", e);
        }

        console.log(
            "Centralized pipeline successfully completed. Topic state is persisted in Neon."
        );
    } catch (e) {
        console.error("Fatal exception in main orchestrator loop.", e);
        process.exit(1);
    } finally {
        await topicPool?.end();
    }
}

orchestrate();
