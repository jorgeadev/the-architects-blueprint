import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth";
import {
    AuthenticationError,
    AuthorizationError,
    jsonSuccess,
    ValidationError,
    withApiObservability,
} from "../../../lib/observability";
import { createDashboardUser, isUserRole, listDashboardUsers } from "../../../lib/users";

export const prerender = false;

async function requireAdmin(cookies: Parameters<typeof getSession>[0]): Promise<void> {
    const session = await getSession(cookies);
    if (!session) {
        throw new AuthenticationError("Sign in to manage users.");
    }
    if (session.role !== "admin") {
        throw new AuthorizationError("Only administrators can manage users.");
    }
}

export const GET: APIRoute = withApiObservability("users.list", async ({ cookies }) => {
    await requireAdmin(cookies);
    return jsonSuccess({ users: await listDashboardUsers() });
});

export const POST: APIRoute = withApiObservability("users.create", async ({ request, cookies }) => {
    await requireAdmin(cookies);
    const body = (await request.json()) as { email?: unknown; password?: unknown; role?: unknown };
    if (
        typeof body.email !== "string" ||
        typeof body.password !== "string" ||
        !isUserRole(body.role)
    ) {
        throw new ValidationError("Email, password, and a valid role are required.");
    }
    const user = await createDashboardUser({
        email: body.email,
        password: body.password,
        role: body.role,
    });
    return jsonSuccess({ success: true, user }, 201);
});
