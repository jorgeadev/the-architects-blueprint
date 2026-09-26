import { query } from "./db";
import { hashPassword, type UserRole, verifyPassword } from "./users";
import { captureServerException } from "./observability";

export type Role = UserRole;

export type Session = {
    email: string;
    role: Role;
    expiresAt: number;
};

type CookieJar = {
    get(name: string): { value: string } | undefined;
    set(name: string, value: string, options: Record<string, unknown>): void;
    delete(name: string, options?: Record<string, unknown>): void;
};

const SESSION_COOKIE = "architects_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function secret(): string {
    const value = process.env.DASHBOARD_SESSION_SECRET ?? import.meta.env.DASHBOARD_SESSION_SECRET;
    if (!value) {
        throw new Error("DASHBOARD_SESSION_SECRET is not configured");
    }
    return value;
}

function encode(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
    return Buffer.from(value, "base64url").toString("utf8");
}

async function sign(value: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret()),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return Buffer.from(signature).toString("base64url");
}

export async function authenticate(email: string, password: string): Promise<Session | null> {
    const users = await query<{ email: string; role: Role; password_hash: string }>(
        `SELECT email, role, password_hash
         FROM dashboard_users
         WHERE lower(email) = lower($1)
         LIMIT 1`,
        [email]
    );
    const user = users[0];
    if (!user) {
        return null;
    }

    if (!(await verifyPassword(password, user.password_hash))) {
        return null;
    }
    if (!user.password_hash.startsWith("pbkdf2_sha256$")) {
        await query(
            "UPDATE dashboard_users SET password_hash = $1, updated_at = now() WHERE lower(email) = lower($2)",
            [await hashPassword(password), user.email]
        );
    }

    return {
        email: user.email,
        role: user.role,
        expiresAt: Date.now() + SESSION_TTL_MS,
    };
}

export async function setSession(cookies: CookieJar, session: Session): Promise<void> {
    const payload = encode(JSON.stringify(session));
    cookies.set(SESSION_COOKIE, `${payload}.${await sign(payload)}`, {
        httpOnly: true,
        sameSite: "lax",
        secure: import.meta.env.PROD,
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
    });
}

export async function getSession(cookies: CookieJar): Promise<Session | null> {
    const value = cookies.get(SESSION_COOKIE)?.value;
    if (!value) {
        return null;
    }

    try {
        const [payload, signature] = value.split(".");
        if (!payload || !signature || signature !== (await sign(payload))) {
            return null;
        }
        const session = JSON.parse(decode(payload)) as Session;
        if (!session.email || !session.expiresAt || session.expiresAt < Date.now()) {
            return null;
        }
        const users = await query<{ role: Role }>(
            "SELECT role FROM dashboard_users WHERE lower(email) = lower($1) LIMIT 1",
            [session.email]
        );
        if (!users[0]) {
            return null;
        }
        return { ...session, role: users[0].role };
    } catch (error) {
        captureServerException("auth.session", error, { event: "session.read.failed" });
        return null;
    }
}

export function clearSession(cookies: CookieJar): void {
    cookies.delete(SESSION_COOKIE, { path: "/" });
}

export function canGenerate(role: Role): boolean {
    return role === "admin" || role === "operator";
}
