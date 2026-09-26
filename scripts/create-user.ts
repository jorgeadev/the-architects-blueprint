import { pbkdf2Sync, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { installProcessErrorHandlers, scriptLog } from "./observability";

installProcessErrorHandlers("identity.create-user");

type Role = "admin" | "operator" | "viewer";

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
    const value = argument(name);
    if (!value) {
        throw new Error(`Missing --${name}`);
    }
    return value;
}

function passwordHash(password: string): string {
    const salt = randomBytes(16);
    const iterations = 210_000;
    const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
    return `pbkdf2_sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function main(): Promise<void> {
    const email = required("email").trim().toLowerCase();
    const password = required("password");
    const role = required("role") as Role;
    if (!["admin", "operator", "viewer"].includes(role)) {
        throw new Error("Role must be admin, operator, or viewer");
    }
    if (password.length < 12) {
        throw new Error("Password must contain at least 12 characters");
    }
    const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error("Missing DIRECT_DATABASE_URL or DATABASE_URL");
    }

    const pool = new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false } });
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS dashboard_users (
                id BIGSERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await pool.query(
            `INSERT INTO dashboard_users (email, password_hash, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET
               password_hash = EXCLUDED.password_hash,
               role = EXCLUDED.role,
               updated_at = now()`,
            [email, passwordHash(password), role]
        );
        scriptLog("info", "identity.create-user", "database.user_upserted", { email, role });
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    scriptLog("error", "identity.create-user", "database.user_creation_failed", {
        error:
            error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : { value: error },
    });
    process.exitCode = 1;
});
