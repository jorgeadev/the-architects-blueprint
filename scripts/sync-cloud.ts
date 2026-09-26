import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { installProcessErrorHandlers, scriptLog } from "./observability";

installProcessErrorHandlers("storage.cloud-sync");

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

function storageUrl(url: string | null, baseUrl: string): string | null {
    if (!url || !baseUrl) {
        return url;
    }
    return `${baseUrl}${new URL(url).pathname}`;
}

async function run() {
    const region = process.env.AWS_REGION;
    const bucket = process.env.S3_BUCKET_NAME;
    const databaseUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
    const contentBaseUrl = (
        process.env.CONTENT_STORAGE_PUBLIC_BASE_URL ??
        process.env.IMAGE_STORAGE_PUBLIC_BASE_URL ??
        ""
    ).replace(/\/$/, "");
    const imageBaseUrl = (
        process.env.IMAGE_STORAGE_PUBLIC_BASE_URL ??
        process.env.CONTENT_STORAGE_PUBLIC_BASE_URL ??
        ""
    ).replace(/\/$/, "");
    if (!region || !bucket) {
        throw new Error("Cloud sync requires AWS_REGION and S3_BUCKET_NAME.");
    }
    if (!databaseUrl) {
        throw new Error("Cloud sync requires DIRECT_DATABASE_URL or DATABASE_URL.");
    }

    const s3 = new S3Client({ region });
    const manifestResponse = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: "posts/index.json" })
    );
    const rawManifest = await manifestResponse.Body?.transformToString("utf8");
    const manifest = rawManifest ? (JSON.parse(rawManifest) as ManifestPost[]) : [];
    const pool = new Pool({
        connectionString: databaseUrl,
        max: 2,
        ssl: { rejectUnauthorized: false },
    });

    try {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            for (const post of manifest) {
                const contentUrl = storageUrl(post.contentUrl, contentBaseUrl);
                const imageUrl = storageUrl(post.imageUrl, imageBaseUrl);
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
                        post.date,
                        imageUrl,
                        post.wordCount,
                        contentUrl,
                        post.excerpt,
                    ]
                );
                const postId = result.rows[0]?.id;
                if (!postId || !imageUrl) {
                    continue;
                }

                const updatedImage = await client.query(
                    `UPDATE images
                     SET remote_url = $1, local_path = $2
                     WHERE post_id = $3 AND remote_url = $1`,
                    [imageUrl, imageUrl, postId]
                );
                if (updatedImage.rowCount === 0) {
                    await client.query(
                        `INSERT INTO images (post_id, local_path, source_url, is_placeholder, remote_url)
                         VALUES ($1, $2, $3, false, $4)`,
                        [postId, imageUrl, null, imageUrl]
                    );
                }
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    } finally {
        await pool.end();
    }

    scriptLog("info", "storage.cloud-sync", "database.manifest_synchronized", {
        postCount: manifest.length,
    });
    console.log(`Synchronized ${manifest.length} cloud posts into Neon.`);
}

run().catch((error) => {
    scriptLog("fatal", "storage.cloud-sync", "database.manifest_sync_failed", {
        error:
            error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : { value: error },
    });
    process.exitCode = 1;
});
