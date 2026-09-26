import type { APIRoute } from "astro";
import { authenticate, setSession } from "../../../lib/auth";
import { jsonSuccess, ValidationError, withApiObservability } from "../../../lib/observability";

export const prerender = false;

export const POST: APIRoute = withApiObservability("auth.login", async ({ request, cookies }) => {
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    if (typeof body.email !== "string" || typeof body.password !== "string") {
        throw new ValidationError("Email and password are required.");
    }
    const session = await authenticate(body.email.trim(), body.password);
    if (!session) {
        return jsonSuccess(
            { error: "Invalid dashboard credentials.", code: "INVALID_CREDENTIALS" },
            401
        );
    }
    await setSession(cookies, session);
    return jsonSuccess({ success: true, role: session.role });
});
