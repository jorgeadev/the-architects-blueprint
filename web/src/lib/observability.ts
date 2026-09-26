import { AsyncLocalStorage } from "node:async_hooks";
import type { APIRoute, APIContext } from "astro";
import { Pool } from "pg";

type RuntimeEnv = Record<string, string | undefined>;

const requestStorage = new AsyncLocalStorage<{ requestId: string }>();
const globalLogging = globalThis as typeof globalThis & {
    __architectsLogPool?: Pool;
    __architectsLogTableReady?: Promise<void>;
};
const sensitiveKey =
    /(password|secret|token|authorization|cookie|api[_-]?key|database[_-]?url|connectionstring)/i;
const maxValueLength = 4000;

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LogFields = Record<string, unknown>;

export class AppError extends Error {
    readonly code: string;
    readonly status: number;
    readonly operational: boolean;
    readonly details?: LogFields;

    constructor(
        message: string,
        options: {
            code: string;
            status?: number;
            operational?: boolean;
            details?: LogFields;
            cause?: unknown;
        }
    ) {
        super(message, { cause: options.cause });
        this.name = "AppError";
        this.code = options.code;
        this.status = options.status ?? 500;
        this.operational = options.operational ?? true;
        this.details = options.details;
    }
}

export class ValidationError extends AppError {
    constructor(message: string, details?: LogFields) {
        super(message, { code: "VALIDATION_ERROR", status: 400, details });
    }
}

export class AuthenticationError extends AppError {
    constructor(message = "Authentication is required.") {
        super(message, { code: "AUTHENTICATION_REQUIRED", status: 401 });
    }
}

export class AuthorizationError extends AppError {
    constructor(message = "You are not allowed to perform this action.") {
        super(message, { code: "FORBIDDEN", status: 403 });
    }
}

export function getRuntimeEnv(): RuntimeEnv {
    const astroEnv = (import.meta as ImportMeta & { env?: RuntimeEnv }).env ?? {};
    return { ...astroEnv, ...process.env };
}

function truncate(value: string): string {
    return value.length > maxValueLength ? `${value.slice(0, maxValueLength)}…` : value;
}

export function redact<T>(value: T, key = ""): T {
    if (sensitiveKey.test(key)) {
        return "[REDACTED]" as T;
    }
    if (value instanceof Error) {
        return {
            name: value.name,
            message: truncate(value.message),
            stack: value.stack ? truncate(value.stack) : undefined,
            cause: value.cause ? redact(value.cause, "cause") : undefined,
        } as T;
    }
    if (typeof value === "string") {
        return truncate(value) as T;
    }
    if (Array.isArray(value)) {
        return value.map((item) => redact(item)) as T;
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
                entryKey,
                redact(entryValue, entryKey),
            ])
        ) as T;
    }
    return value;
}

export function errorInfo(error: unknown): LogFields {
    if (error instanceof AppError) {
        return {
            name: error.name,
            message: error.message,
            code: error.code,
            status: error.status,
            operational: error.operational,
            details: error.details,
            cause: error.cause,
            stack: error.stack,
        };
    }
    if (error instanceof Error) {
        return redact(error) as unknown as LogFields;
    }
    return { message: String(error) };
}

function createRequestId(value?: string | null): string {
    return value && /^[a-zA-Z0-9._:-]{8,128}$/.test(value) ? value : crypto.randomUUID();
}

function environmentName(): string {
    const env = getRuntimeEnv();
    return env.VERCEL_ENV ?? env.NODE_ENV ?? "development";
}

function logPool(): Pool | null {
    const env = getRuntimeEnv();
    const connectionString = env.LOG_DATABASE_URL ?? env.DATABASE_URL ?? env.DIRECT_DATABASE_URL;
    if (!connectionString) {
        return null;
    }

    if (!globalLogging.__architectsLogPool) {
        globalLogging.__architectsLogPool = new Pool({
            connectionString,
            max: 1,
            idleTimeoutMillis: 10_000,
            ssl: { rejectUnauthorized: false },
        });
    }

    return globalLogging.__architectsLogPool;
}

async function ensureLogTable(pool: Pool): Promise<void> {
    if (!globalLogging.__architectsLogTableReady) {
        globalLogging.__architectsLogTableReady = pool
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
                globalLogging.__architectsLogTableReady = undefined;
                throw error;
            });
    }

    await globalLogging.__architectsLogTableReady;
}

async function persistNeonLog(entry: LogFields): Promise<void> {
    const pool = logPool();
    if (!pool) {
        return;
    }

    try {
        await ensureLogTable(pool);
        const metadata = Object.fromEntries(
            Object.entries(entry).filter(
                ([key]) =>
                    ![
                        "timestamp",
                        "level",
                        "service",
                        "message",
                        "environment",
                        "requestId",
                    ].includes(key)
            )
        );
        await pool.query(
            `INSERT INTO application_logs
                (occurred_at, level, service, message, environment, request_id, fields)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [
                entry.timestamp,
                entry.level,
                entry.service,
                entry.message,
                entry.environment,
                entry.requestId ?? null,
                JSON.stringify(metadata),
            ]
        );
    } catch (error) {
        // Logging must never become an application outage or recursively log itself.
        console.error(
            JSON.stringify({
                timestamp: new Date().toISOString(),
                level: "error",
                service: "observability",
                message: "log.persistence.failed",
                error: redact(errorInfo(error)),
            })
        );
    }
}

async function forwardRemote(entry: LogFields): Promise<void> {
    const env = getRuntimeEnv();
    const endpoint = env.LOG_INGEST_URL;
    if (!endpoint) {
        return;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(env.LOG_INGEST_TOKEN
                    ? { Authorization: `Bearer ${env.LOG_INGEST_TOKEN}` }
                    : {}),
            },
            body: JSON.stringify(entry),
            signal: controller.signal,
        });
        clearTimeout(timeout);
    } catch {
        // Remote telemetry must never become an application outage.
    }
}

export function log(
    level: LogLevel,
    service: string,
    message: string,
    fields: LogFields = {}
): void {
    const entry = redact({
        timestamp: new Date().toISOString(),
        level,
        service,
        message,
        environment: environmentName(),
        requestId: requestStorage.getStore()?.requestId,
        ...fields,
    });

    const output = JSON.stringify(entry);
    if (level === "error" || level === "fatal") {
        console.error(output);
    } else if (level === "warn") {
        console.warn(output);
    } else {
        console.log(output);
    }
    void persistNeonLog(entry);
    void forwardRemote(entry);
}

export function logger(service: string) {
    return {
        debug: (message: string, fields?: LogFields) => log("debug", service, message, fields),
        info: (message: string, fields?: LogFields) => log("info", service, message, fields),
        warn: (message: string, fields?: LogFields) => log("warn", service, message, fields),
        error: (message: string, fields?: LogFields) => log("error", service, message, fields),
        fatal: (message: string, fields?: LogFields) => log("fatal", service, message, fields),
    };
}

export function toAppError(error: unknown): AppError {
    if (error instanceof AppError) {
        return error;
    }
    return new AppError("An unexpected application error occurred.", {
        code: "INTERNAL_ERROR",
        status: 500,
        operational: false,
        cause: error,
    });
}

function jsonResponse(payload: unknown, status: number, requestId: string): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Request-ID": requestId,
        },
    });
}

export function jsonSuccess(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
    });
}

export function jsonError(
    error: unknown,
    requestId = requestStorage.getStore()?.requestId ?? crypto.randomUUID()
): Response {
    const appError = toAppError(error);
    return jsonResponse(
        {
            error: appError.operational
                ? appError.message
                : "Something went wrong. Please try again.",
            code: appError.code,
            requestId,
        },
        appError.status,
        requestId
    );
}

export function withApiObservability(name: string, handler: APIRoute): APIRoute {
    return async (context: APIContext) => {
        const requestId = createRequestId(context.request.headers.get("x-request-id"));
        const startedAt = performance.now();

        return requestStorage.run({ requestId }, async () => {
            const requestLogger = logger(`api.${name}`);
            requestLogger.info("request.started", {
                method: context.request.method,
                path: new URL(context.request.url).pathname,
            });

            try {
                const response = await handler(context);
                const headers = new Headers(response.headers);
                headers.set("X-Request-ID", requestId);
                requestLogger.info("request.completed", {
                    status: response.status,
                    durationMs: Math.round(performance.now() - startedAt),
                });
                return new Response(response.body, { status: response.status, headers });
            } catch (error) {
                const appError = toAppError(error);
                requestLogger.error("request.failed", {
                    ...errorInfo(error),
                    durationMs: Math.round(performance.now() - startedAt),
                });
                return jsonError(appError, requestId);
            }
        });
    };
}

export function captureServerException(service: string, error: unknown, fields?: LogFields): void {
    logger(service).error("exception.captured", { ...fields, error: errorInfo(error) });
}
