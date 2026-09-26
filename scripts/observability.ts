import { Pool } from "pg";

type ScriptLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const globalLogging = globalThis as typeof globalThis & {
    __architectsScriptLogPool?: Pool;
    __architectsScriptLogTableReady?: Promise<void>;
};

function serializeError(value: unknown): Record<string, unknown> {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
            cause: value.cause,
        };
    }

    return { value };
}

function logPool(): Pool | null {
    const connectionString =
        process.env.LOG_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.DIRECT_DATABASE_URL;
    if (!connectionString) {
        return null;
    }
    if (!globalLogging.__architectsScriptLogPool) {
        globalLogging.__architectsScriptLogPool = new Pool({
            connectionString,
            max: 1,
            idleTimeoutMillis: 10_000,
            ssl: { rejectUnauthorized: false },
        });
    }
    return globalLogging.__architectsScriptLogPool;
}

async function persistLog(entry: Record<string, unknown>): Promise<void> {
    const pool = logPool();
    if (!pool) {
        return;
    }
    try {
        if (!globalLogging.__architectsScriptLogTableReady) {
            globalLogging.__architectsScriptLogTableReady = pool
                .query(
                    `
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
            `
                )
                .then(() => undefined)
                .catch((error) => {
                    globalLogging.__architectsScriptLogTableReady = undefined;
                    throw error;
                });
        }
        await globalLogging.__architectsScriptLogTableReady;
        const fields = { ...entry };
        delete fields.timestamp;
        delete fields.level;
        delete fields.service;
        delete fields.environment;
        delete fields.message;
        await pool.query(
            `INSERT INTO application_logs
                (occurred_at, level, service, message, environment, fields)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
                entry.timestamp,
                entry.level,
                entry.service,
                entry.message,
                entry.environment,
                JSON.stringify(fields),
            ]
        );
    } catch (error) {
        console.error(
            JSON.stringify({
                timestamp: new Date().toISOString(),
                level: "error",
                service: "observability",
                message: "log.persistence.failed",
                error: serializeError(error),
            })
        );
    }
}

export function scriptLog(
    level: ScriptLogLevel,
    service: string,
    message: string,
    fields: Record<string, unknown> = {}
) {
    const record = {
        timestamp: new Date().toISOString(),
        level,
        service,
        environment: process.env.GITHUB_ACTIONS
            ? "github-actions"
            : (process.env.NODE_ENV ?? "development"),
        message,
        ...fields,
    };

    const output = JSON.stringify(record);
    if (level === "error" || level === "fatal") {
        console.error(output);
    } else {
        console.log(output);
    }
    void persistLog(record);
}

export function installProcessErrorHandlers(service: string) {
    process.on("uncaughtException", (error) => {
        scriptLog("fatal", service, "process.uncaught_exception", { error: serializeError(error) });
        process.exitCode = 1;
    });

    process.on("unhandledRejection", (reason) => {
        scriptLog("fatal", service, "process.unhandled_rejection", {
            error: serializeError(reason),
        });
        process.exitCode = 1;
    });
}
