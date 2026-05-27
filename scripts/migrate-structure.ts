/**
 * One-time migration: moves flat blog/.md and images/.jpg files
 * into a year/month/day/ nested folder structure and patches the
 * image frontmatter paths in each .md file.
 *
 * Before: web/src/content/blog/2026-04-11-the-title.md
 *         web/public/images/2026-04-11-the-title.jpg
 *
 * After:  web/src/content/blog/2026/04/11/the-title.md
 *         web/public/images/2026/04/11/the-title.jpg
 */

import * as fs from "fs";
import * as path from "path";

const rootDir = process.cwd();
const blogDir = path.join(rootDir, "web", "src", "content", "blog");
const imagesDir = path.join(rootDir, "web", "public", "images");

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/;

function migrate() {
    let movedMd = 0;
    let movedImg = 0;
    let patched = 0;

    // ── 1. Migrate .md files ────────────────────────────────────────────────
    const mdFiles = fs.readdirSync(blogDir).filter((f) => f.endsWith(".md"));

    for (const fileName of mdFiles) {
        const match = fileName.match(DATE_PREFIX);
        if (!match) {
            console.log(`Skipping (no date prefix): ${fileName}`);
            continue;
        }

        const [, year, month, day, rest] = match;
        const newFileName = rest; // strip the date prefix
        const targetDir = path.join(blogDir, year, month, day);
        fs.mkdirSync(targetDir, { recursive: true });

        const oldPath = path.join(blogDir, fileName);
        const newPath = path.join(targetDir, newFileName);

        // Patch image: frontmatter path before moving
        let content = fs.readFileSync(oldPath, "utf8");
        const oldImgPattern = new RegExp(
            `(image:\\s*")/images/${year}-${month}-${day}-${rest.replace(/\.md$/, "")}\\.jpg(")`
        );
        const newImgValue = `/images/${year}/${month}/${day}/${rest.replace(/\.md$/, "")}.jpg`;

        if (oldImgPattern.test(content)) {
            content = content.replace(oldImgPattern, `$1${newImgValue}$2`);
            patched++;
        }

        fs.writeFileSync(newPath, content, "utf8");
        fs.unlinkSync(oldPath);
        console.log(`Moved: ${fileName} → ${year}/${month}/${day}/${newFileName}`);
        movedMd++;
    }

    // ── 2. Migrate .jpg files ───────────────────────────────────────────────
    const imgFiles = fs
        .readdirSync(imagesDir)
        .filter(
            (f) =>
                f.endsWith(".jpg") ||
                f.endsWith(".jpeg") ||
                f.endsWith(".png") ||
                f.endsWith(".webp")
        );

    for (const fileName of imgFiles) {
        const match = fileName.match(DATE_PREFIX);
        if (!match) {
            console.log(`Skipping image (no date prefix): ${fileName}`);
            continue;
        }

        const [, year, month, day, rest] = match;
        const targetDir = path.join(imagesDir, year, month, day);
        fs.mkdirSync(targetDir, { recursive: true });

        const oldPath = path.join(imagesDir, fileName);
        const newPath = path.join(targetDir, rest);

        fs.renameSync(oldPath, newPath);
        console.log(`Moved image: ${fileName} → ${year}/${month}/${day}/${rest}`);
        movedImg++;
    }

    console.log("\nMigration complete.");
    console.log(`  .md files moved : ${movedMd}`);
    console.log(`  .jpg files moved: ${movedImg}`);
    console.log(`  frontmatter patched: ${patched}`);
}

migrate();
