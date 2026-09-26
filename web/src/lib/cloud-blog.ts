import { marked } from "marked";
import { query } from "./db";

export type CloudPost = {
    id: string;
    data: {
        title: string;
        shortTitle?: string;
        date?: Date;
        image?: string;
        wordCount: number;
    };
    body: string;
    contentUrl: string;
};

type DatabasePost = {
    slug: string;
    title: string;
    short_title: string | null;
    published_date: string;
    image_url: string | null;
    content_url: string | null;
    excerpt: string | null;
    word_count: number;
};

function fromDatabase(post: DatabasePost): CloudPost {
    if (!post.content_url) {throw new Error(`Post ${post.slug} has no Markdown URL in Neon`);}
    return {
        id: post.slug,
        data: {
            title: post.title,
            shortTitle: post.short_title ?? undefined,
            date: new Date(post.published_date),
            image: post.image_url ? post.image_url : undefined,
            wordCount: post.word_count,
        },
        body: post.excerpt ?? "",
        contentUrl: post.content_url,
    };
}

export async function getCloudPosts(): Promise<CloudPost[]> {
    const posts = await query<DatabasePost>(
        `SELECT p.slug,
                p.title,
                p.short_title,
                p.published_date::text AS published_date,
                COALESCE(i.remote_url, p.image_path) AS image_url,
                p.post_url AS content_url,
                p.word_count,
                p.excerpt
         FROM posts p
         LEFT JOIN LATERAL (
             SELECT remote_url
             FROM images
             WHERE post_id = p.id
             ORDER BY created_at DESC
             LIMIT 1
         ) i ON true
         WHERE p.post_url IS NOT NULL
         ORDER BY p.published_date DESC, p.slug DESC`
    );
    return posts
        .map(fromDatabase)
        .sort(
            (left, right) => (right.data.date?.getTime() ?? 0) - (left.data.date?.getTime() ?? 0)
        );
}

export async function getCloudPost(slug: string): Promise<CloudPost | null> {
    const post = (await getCloudPosts()).find((candidate) => candidate.id === slug);
    if (!post) {return null;}

    const response = await fetch(post.contentUrl, { headers: { Accept: "text/markdown" } });
    if (!response.ok) {throw new Error(`Cloud article returned ${response.status}`);}
    const markdown = await response.text();
    const body = markdown.replace(/^---[\s\S]*?---\s*/, "").trim();
    return { ...post, body };
}

export async function renderCloudMarkdown(markdown: string): Promise<string> {
    return await marked.parse(markdown);
}
