import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async () => {
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
            "https://api.github.com/repos/jorgeadev/the-architects-blueprint/actions/workflows/create-blog-post.yml/dispatches",
            {
                method: "POST",
                headers: {
                    Accept: "application/vnd.github.v3+json",
                    Authorization: `token ${ghToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    ref: "develop",
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
