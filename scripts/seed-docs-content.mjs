#!/usr/bin/env node
/**
 * seed-docs-content.mjs — ONE-TIME migration (idempotent, refuses to clobber).
 *
 * Moves the existing hand-authored flat agent references into the Starlight
 * content tree as the new canonical single source. After this runs, the content
 * pages under docs-site/src/content/docs/{cli,sdk,mcp}/ are authoritative and the
 * root flat files (cli/llms-cli.txt, sdk/llms-sdk.txt, llms-mcp.txt) are
 * regenerated from them by build-agent-flat-docs.mjs.
 *
 * v1 lands a coarse "one reference page per bundle" structure (byte-faithful to
 * the current flat files); splitting each into a finer navigable page tree is
 * iterative authoring that does not change the generator.
 *
 * Usage: node scripts/seed-docs-content.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs-site", "src", "content", "docs");

const BUNDLES = [
  { section: "cli", flat: "cli/llms-cli.txt", title: "CLI reference", desc: "Comprehensive run402 CLI reference (the agent-facing llms-cli.txt, rendered)." },
  { section: "sdk", flat: "sdk/llms-sdk.txt", title: "SDK reference", desc: "Comprehensive @run402/sdk reference (the agent-facing llms-sdk.txt, rendered)." },
  { section: "mcp", flat: "llms-mcp.txt", title: "MCP reference", desc: "Comprehensive run402-mcp tool reference (the agent-facing llms-mcp.txt, rendered)." },
];

let wrote = 0;
for (const b of BUNDLES) {
  const dest = join(DOCS, b.section, "reference.md");
  if (existsSync(dest)) {
    console.log(`skip (exists) ${b.section}/reference.md`);
    continue;
  }
  const body = readFileSync(join(ROOT, b.flat), "utf-8");
  const frontmatter = [
    "---",
    `title: ${b.title}`,
    `description: ${b.desc}`,
    "order: 1",
    "---",
    "",
    "",
  ].join("\n");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, frontmatter + body);
  console.log(`seeded ${b.section}/reference.md (${body.split("\n").length} lines)`);
  wrote++;
}
console.log(wrote ? `seeded ${wrote} bundle page(s)` : "nothing to seed (all present)");
