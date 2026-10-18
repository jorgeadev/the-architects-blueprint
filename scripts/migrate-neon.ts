import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

type ManifestPost = {
    slug: string;
    title: string;
    shortTitle?: string | null;
    date: string;
    imageUrl?: string | null;
    contentUrl: string;
    excerpt?: string | null;
    wordCount: number;
};

type ImportPost = {
    slug: string;
    title: string;
    short_title: string | null;
    published_date: string;
    image_url: string | null;
    image_key: string | null;
    content_url: string;
    excerpt: string | null;
    word_count: number;
    is_placeholder: boolean;
};

function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required to migrate the archive.`);
    }
    return value;
}

function imageObjectKey(imageUrl: string): string {
    const pathname = new URL(imageUrl).pathname;
    const marker = pathname.lastIndexOf("/images/");
    if (marker < 0) {
        throw new Error(`Image URL does not contain an /images/ object path: ${imageUrl}`);
    }
    return decodeURIComponent(pathname.slice(marker + 1));
}

function parseManifest(raw: string): ManifestPost[] {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("S3 posts/index.json must be a non-empty array.");
    }

    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object") {
            throw new Error(`Manifest entry ${index + 1} is not an object.`);
        }
        const post = entry as Partial<ManifestPost>;
        if (
            typeof post.slug !== "string" ||
            !post.slug.trim() ||
            typeof post.title !== "string" ||
            !post.title.trim() ||
            typeof post.date !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(post.date) ||
            typeof post.contentUrl !== "string" ||
            !post.contentUrl.trim() ||
            typeof post.wordCount !== "number" ||
            !Number.isInteger(post.wordCount) ||
            post.wordCount < 0 ||
            (post.imageUrl != null && typeof post.imageUrl !== "string") ||
            (post.shortTitle != null && typeof post.shortTitle !== "string") ||
            (post.excerpt != null && typeof post.excerpt !== "string")
        ) {
            throw new Error(`Manifest entry ${index + 1} has invalid or missing fields.`);
        }

        const imageUrl = post.imageUrl ?? null;
        const imageKey = imageUrl ? imageObjectKey(imageUrl) : null;
        return {
            slug: post.slug,
            title: post.title,
            short_title: post.shortTitle ?? null,
            published_date: post.date,
            image_url: imageUrl,
            image_key: imageKey,
            content_url: post.contentUrl,
            excerpt: post.excerpt ?? null,
            word_count: post.wordCount,
            is_placeholder: Boolean(imageKey?.toLowerCase().endsWith(".svg")),
        };
    });
}

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS posts (
        id BIGSERIAL PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        short_title TEXT,
        published_date DATE NOT NULL,
        image_path TEXT,
        word_count INTEGER NOT NULL DEFAULT 0,
        post_url TEXT,
        excerpt TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS posts_published_date_idx
        ON posts (published_date DESC, slug DESC);

    CREATE TABLE IF NOT EXISTS images (
        id BIGSERIAL PRIMARY KEY,
        post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        local_path TEXT NOT NULL,
        source_url TEXT,
        is_placeholder BOOLEAN NOT NULL DEFAULT false,
        remote_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT images_post_id_remote_url_unique UNIQUE (post_id, remote_url)
    );
    CREATE INDEX IF NOT EXISTS images_post_created_at_idx
        ON images (post_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS generation_topics (
        topic TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS generation_topic_state (
        key TEXT PRIMARY KEY,
        initialized_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS dashboard_users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS application_logs (
        id BIGSERIAL PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
        service TEXT NOT NULL,
        message TEXT NOT NULL,
        environment TEXT NOT NULL,
        request_id TEXT,
        fields JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS application_logs_occurred_at_idx
        ON application_logs (occurred_at DESC);
    CREATE INDEX IF NOT EXISTS application_logs_service_level_idx
        ON application_logs (service, level);
    CREATE INDEX IF NOT EXISTS application_logs_request_id_idx
        ON application_logs (request_id)
        WHERE request_id IS NOT NULL;
`;

async function migrate(): Promise<void> {
    // Prefer a dedicated target variable so a stale DIRECT_DATABASE_URL cannot redirect the import.
    const connectionString =
        process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error(
            "Set MIGRATION_DATABASE_URL or DATABASE_URL to the destination Neon database."
        );
    }

    const region = requiredEnv("AWS_REGION");
    const bucket = requiredEnv("S3_BUCKET_NAME");
    const s3 = new S3Client({ region });
    const response = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: "posts/index.json" })
    );
    const manifestText = await response.Body?.transformToString("utf8");
    if (!manifestText) {
        throw new Error("S3 returned an empty posts/index.json manifest.");
    }

    const posts = parseManifest(manifestText);
    const topicsPath = path.resolve(process.cwd(), "config", "topics.json");
    const topicsDocument = JSON.parse(await readFile(topicsPath, "utf8")) as { topics?: unknown };
    if (
        !Array.isArray(topicsDocument.topics) ||
        !topicsDocument.topics.every((topic) => typeof topic === "string")
    ) {
        throw new Error("config/topics.json must contain a string array named topics.");
    }
    const topics = [...new Set(topicsDocument.topics.map((topic) => topic.trim()).filter(Boolean))];

    const pool = new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(SCHEMA_SQL);

        const seedMarker = await client.query(
            `INSERT INTO generation_topic_state (key)
             VALUES ('generation-topics-v1')
             ON CONFLICT (key) DO NOTHING
             RETURNING key`
        );
        let seededTopics = 0;
        if (seedMarker.rowCount) {
            const seedResult = await client.query(
                `INSERT INTO generation_topics (topic)
                 SELECT unnest($1::text[])
                 ON CONFLICT (topic) DO NOTHING`,
                [topics]
            );
            seededTopics = seedResult.rowCount ?? 0;
        }

        const serializedPosts = JSON.stringify(posts);
        const postResult = await client.query(
            `INSERT INTO posts
                (slug, title, short_title, published_date, image_path, word_count, post_url, excerpt, updated_at)
             SELECT slug, title, short_title, published_date::date, image_url, word_count,
                    content_url, excerpt, now()
             FROM jsonb_to_recordset($1::jsonb) AS item(
                slug text,
                title text,
                short_title text,
                published_date text,
                image_url text,
                content_url text,
                excerpt text,
                word_count integer
             )
             ON CONFLICT (slug) DO UPDATE SET
                title = EXCLUDED.title,
                short_title = EXCLUDED.short_title,
                published_date = EXCLUDED.published_date,
                image_path = EXCLUDED.image_path,
                word_count = EXCLUDED.word_count,
                post_url = EXCLUDED.post_url,
                excerpt = EXCLUDED.excerpt,
                updated_at = now()`,
            [serializedPosts]
        );

        const imagePosts = posts.filter(
            (post): post is ImportPost & { image_url: string; image_key: string } =>
                Boolean(post.image_url && post.image_key)
        );
        let imageRows = 0;
        if (imagePosts.length) {
            const imageResult = await client.query(
                `INSERT INTO images
                    (post_id, local_path, source_url, is_placeholder, remote_url)
                 SELECT p.id, item.image_key, NULL, item.is_placeholder, item.image_url
                 FROM jsonb_to_recordset($1::jsonb) AS item(
                    slug text,
                    image_key text,
                    image_url text,
                    is_placeholder boolean
                 )
                 JOIN posts p ON p.slug = item.slug
                 ON CONFLICT (post_id, remote_url) DO UPDATE SET
                    local_path = EXCLUDED.local_path,
                    is_placeholder = EXCLUDED.is_placeholder`,
                [JSON.stringify(imagePosts)]
            );
            imageRows = imageResult.rowCount ?? 0;
        }

        await client.query("COMMIT");
        console.log(
            `Neon archive migration complete: ${postResult.rowCount ?? 0} post records upserted, ${imageRows} image records upserted, ${seededTopics} topics seeded.`
        );
        console.log(
            "The script created empty dashboard_users and application_logs tables if needed."
        );
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
        await pool.end();
        s3.destroy();
    }
}

migrate().catch((error: unknown) => {
    console.error("Neon archive migration failed.", error);
    process.exitCode = 1;
});
