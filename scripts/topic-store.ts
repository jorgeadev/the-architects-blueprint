import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const TOPICS_KEY = "generation-topics-v1";

export function createTopicPool(): Pool {
    const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error("Topic storage requires DIRECT_DATABASE_URL or DATABASE_URL.");
    }
    return new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false } });
}

export async function ensureTopicStore(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS generation_topics (
            topic TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS generation_topic_state (
            key TEXT PRIMARY KEY,
            initialized_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);

    const initialized = await pool.query("SELECT 1 FROM generation_topic_state WHERE key = $1", [
        TOPICS_KEY,
    ]);
    if (initialized.rowCount) {
        return;
    }

    const seedPath = path.resolve(process.cwd(), "config", "topics.json");
    const seedContent = await readFile(seedPath, "utf8");
    const seedTopics = (JSON.parse(seedContent) as { topics?: unknown }).topics;
    if (!Array.isArray(seedTopics) || !seedTopics.every((topic) => typeof topic === "string")) {
        throw new Error("config/topics.json must contain a string array named topics.");
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const seedMarker = await client.query(
            `INSERT INTO generation_topic_state (key)
             VALUES ($1)
             ON CONFLICT (key) DO NOTHING
             RETURNING key`,
            [TOPICS_KEY]
        );
        if (seedMarker.rowCount) {
            await client.query(
                `INSERT INTO generation_topics (topic)
                 SELECT DISTINCT btrim(seed.topic)
                 FROM unnest($1::text[]) AS seed(topic)
                 WHERE btrim(seed.topic) <> ''
                 ON CONFLICT (topic) DO NOTHING`,
                [seedTopics]
            );
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function getTopics(pool: Pool): Promise<string[]> {
    const result = await pool.query<{ topic: string }>(
        "SELECT topic FROM generation_topics ORDER BY created_at, topic"
    );
    return result.rows.map((row) => row.topic);
}

export async function getTopicCount(pool: Pool): Promise<number> {
    const result = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM generation_topics"
    );
    return Number(result.rows[0]?.count ?? 0);
}

export async function removeTopic(pool: Pool, topic: string): Promise<void> {
    await pool.query("DELETE FROM generation_topics WHERE topic = $1", [topic]);
}

export async function addTopics(pool: Pool, topics: string[]): Promise<number> {
    const uniqueTopics = [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))];
    if (!uniqueTopics.length) {
        return 0;
    }

    const result = await pool.query(
        `INSERT INTO generation_topics (topic)
         SELECT unnest($1::text[])
         ON CONFLICT (topic) DO NOTHING`,
        [uniqueTopics]
    );
    return result.rowCount ?? 0;
}
