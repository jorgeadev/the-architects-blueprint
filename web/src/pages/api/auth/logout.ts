import type { APIRoute } from "astro";
import { clearSession } from "../../../lib/auth";
import { jsonSuccess, withApiObservability } from "../../../lib/observability";

export const prerender = false;

export const POST: APIRoute = withApiObservability("auth.logout", async ({ cookies }) => {
    clearSession(cookies);
    return jsonSuccess({ success: true });
});
