import type { APIRoute } from "astro";
import { spawn } from "child_process";
import * as path from "path";
import { canGenerate, getSession } from "../../lib/auth";
import {
    AppError,
    AuthenticationError,
    AuthorizationError,
    captureServerException,
    getRuntimeEnv,
    jsonSuccess,
    withApiObservability,
} from "../../lib/observability";

export const prerender = false;

export const POST: APIRoute = withApiObservability("generation.post", async ({ cookies }) => {
    const session = await getSession(cookies);
    if (!session) {
        throw new AuthenticationError("Sign in to generate posts.");
    }
    if (!canGenerate(session.role)) {
        throw new AuthorizationError("Only administrators and operators can generate posts.");
    }

    // In local dev: run the script directly on this machine (fire-and-forget)
    if (!import.meta.env.PROD) {
        const rootDir = path.resolve(process.cwd(), "..");
        const child = spawn("pnpm", ["generate:post"], {
            cwd: rootDir,
            detached: true,
            stdio: ["ignore", "inherit", "inherit"],
            shell: true,
        });
        child.on("error", (error) =>
            captureServerException("generation.post", error, { mode: "local" })
        );
        child.unref();
        return jsonSuccess({ success: true, message: "Running locally! Check your terminal." });
    }

    const ghToken = getRuntimeEnv().GITHUB_PAT;

    if (!ghToken) {
        throw new AppError("Generation service is not configured.", {
            code: "GENERATION_NOT_CONFIGURED",
        });
    }

    const response = await fetch(
        "https://api.github.com/repos/jorgeadev/the-architects-blueprint/actions/workflows/daily-pipeline.yml/dispatches",
        {
            method: "POST",
            headers: {
                Accept: "application/vnd.github.v3+json",
                Authorization: `token ${ghToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                ref: "main",
                inputs: { task: "post" },
            }),
        }
    );

    if (!response.ok) {
        throw new AppError("The generation workflow could not be started.", {
            code: "GENERATION_PROVIDER_ERROR",
            details: { provider: "github", status: response.status },
        });
    }

    return jsonSuccess({ success: true, message: "Workflow triggered successfully!" });
});
