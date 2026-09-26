import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { query } from "./db";
import { AppError, ValidationError } from "./observability";

export const USER_ROLES = ["admin", "operator", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export type DashboardUser = {
    id: string;
    email: string;
    role: UserRole;
    createdAt: string;
    updatedAt: string;
};

type UserRow = {
    id: string;
    email: string;
    role: UserRole;
    created_at: Date;
    updated_at: Date;
};

const pbkdf2Async = promisify(pbkdf2);
const PASSWORD_ITERATIONS = 210_000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";

function toDashboardUser(user: UserRow): DashboardUser {
    return {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: user.created_at.toISOString(),
        updatedAt: user.updated_at.toISOString(),
    };
}

export function isUserRole(value: unknown): value is UserRole {
    return typeof value === "string" && USER_ROLES.includes(value as UserRole);
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await pbkdf2Async(
        password,
        salt,
        PASSWORD_ITERATIONS,
        PASSWORD_KEY_LENGTH,
        PASSWORD_DIGEST
    );
    return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
    if (!encodedHash.startsWith("pbkdf2_sha256$")) {
        const legacyHash = createHash("sha256").update(password, "utf8").digest("base64url");
        return legacyHash === encodedHash;
    }

    const [, iterationValue, saltValue, hashValue] = encodedHash.split("$");
    const iterations = Number(iterationValue);
    if (!iterations || !saltValue || !hashValue) {
        return false;
    }

    const expected = Buffer.from(hashValue, "base64url");
    const actual = await pbkdf2Async(
        password,
        Buffer.from(saltValue, "base64url"),
        iterations,
        expected.length,
        PASSWORD_DIGEST
    );
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function listDashboardUsers(): Promise<DashboardUser[]> {
    const users = await query<UserRow>(
        `SELECT id::text, email, role, created_at, updated_at
         FROM dashboard_users
         ORDER BY created_at DESC, email ASC`
    );
    return users.map(toDashboardUser);
}

export async function createDashboardUser(input: {
    email: string;
    password: string;
    role: UserRole;
}): Promise<DashboardUser> {
    const email = input.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
        throw new ValidationError("Enter a valid email address.");
    }
    if (input.password.length < 12) {
        throw new ValidationError("Password must contain at least 12 characters.");
    }
    if (input.password.length > 256) {
        throw new ValidationError("Password cannot exceed 256 characters.");
    }
    if (!isUserRole(input.role)) {
        throw new ValidationError("Select a valid role.");
    }

    const users = await query<UserRow>(
        `INSERT INTO dashboard_users (email, password_hash, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING
         RETURNING id::text, email, role, created_at, updated_at`,
        [email, await hashPassword(input.password), input.role]
    );
    if (!users[0]) {
        throw new AppError("A user with this email already exists.", {
            code: "USER_EXISTS",
            status: 409,
        });
    }
    return toDashboardUser(users[0]);
}
