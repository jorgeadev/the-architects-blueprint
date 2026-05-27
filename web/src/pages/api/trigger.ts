import type { APIRoute } from "astro";
import { spawn } from "child_process";
import * as path from "path";

export const prerender = false;

export const POST: APIRoute = async () => {
    // In local dev: run the script directly on this machine (fire-and-forget)
    if (!import.meta.env.PROD) {
        try {
            const rootDir = path.resolve(process.cwd(), "..");
            spawn("pnpm", ["generate:post"], {
                cwd: rootDir,
                detached: true,
                stdio: ["ignore", "inherit", "inherit"],
                shell: true,
            }).unref();

            return new Response(
                JSON.stringify({ success: true, message: "Running locally! Check your terminal." }),
                { status: 200, headers: { "Content-Type": "application/json" } }
            );
        } catch (e) {
            const errDesc = e instanceof Error ? e.message : String(e);
            return new Response(JSON.stringify({ error: errDesc }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    }

    try {
        const ghToken = import.meta.env.GITHUB_PAT || process.env.GITHUB_PAT;

        if (!ghToken) {
            return new Response(
                JSON.stringify({ error: "Missing GITHUB_PAT in environment secrets" }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                }
            );
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
                }),
            }
        );

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`GitHub API responded with ${response.status}: ${errBody}`);
        }

        return new Response(
            JSON.stringify({ success: true, message: "Workflow triggered successfully!" }),
            {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }
        );
    } catch (e) {
        const errDesc = e instanceof Error ? e.message : String(e);
        console.error("Trigger Failed:", errDesc);

        return new Response(JSON.stringify({ error: errDesc }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
};
