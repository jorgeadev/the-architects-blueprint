import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blogCollection = defineCollection({
    loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
    schema: z.object({
        title: z.string(),
        date: z.date().optional(),
        image: z.string().optional(),
    }),
});

export const collections = {
    blog: blogCollection,
};
