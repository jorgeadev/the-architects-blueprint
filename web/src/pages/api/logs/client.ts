import type { APIRoute } from "astro";
import {
    jsonSuccess,
    logger,
    ValidationError,
    withApiObservability,
} from "../../../lib/observability";

export const prerender = false;

const clientLogger = logger("browser");
const recentClients = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request): string {
    return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export const POST: APIRoute = withApiObservability("logs.client", async ({ request }) => {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 32_000) {
        throw new ValidationError("Client report is too large.");
    }

    const key = clientKey(request);
    const now = Date.now();
    const current = recentClients.get(key);
    if (!current || current.resetAt <= now) {
        recentClients.set(key, { count: 1, resetAt: now + 60_000 });
    } else if (current.count >= 30) {
        return new Response(null, { status: 204 });
    } else {
        current.count += 1;
    }

    const body = (await request.json()) as { level?: unknown; error?: unknown; context?: unknown };
    if (!body.error || !["warn", "error", "fatal"].includes(String(body.level))) {
        throw new ValidationError("A client error and valid severity are required.");
    }

    clientLogger[String(body.level) as "warn" | "error" | "fatal"]("client.exception", {
        error: body.error,
        context: body.context,
    });
    return jsonSuccess({ accepted: true });
});
