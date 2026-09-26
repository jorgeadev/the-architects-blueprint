import { Pool, type QueryResultRow } from "pg";
import { captureServerException, logger } from "./observability";

const dbLogger = logger("database");

const globalDatabase = globalThis as typeof globalThis & {
    __architectsPool?: Pool;
};

function connectionString(): string {
    const value = process.env.DATABASE_URL ?? import.meta.env.DATABASE_URL;
    if (!value) {
        throw new Error("DATABASE_URL is not configured");
    }
    return value;
}

export function databasePool(): Pool {
    if (!globalDatabase.__architectsPool) {
        globalDatabase.__architectsPool = new Pool({
            connectionString: connectionString(),
            max: 1,
            idleTimeoutMillis: 10_000,
            ssl: { rejectUnauthorized: false },
        });
        globalDatabase.__architectsPool.on("error", (error) => {
            captureServerException("database", error, { event: "pool.error" });
        });
    }
    return globalDatabase.__architectsPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
): Promise<T[]> {
    const startedAt = performance.now();
    const operation = text.trim().replace(/\s+/g, " ").slice(0, 120);
    try {
        const result = await databasePool().query<T>(text, values);
        const durationMs = Math.round(performance.now() - startedAt);
        if (durationMs >= 250) {
            dbLogger.warn("query.slow", { operation, durationMs });
        }
        return result.rows;
    } catch (error) {
        captureServerException("database", error, {
            operation,
            durationMs: Math.round(performance.now() - startedAt),
        });
        throw error;
    }
}
