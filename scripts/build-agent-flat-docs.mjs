#!/usr/bin/env node
/**
 * build-agent-flat-docs.mjs — the SINGLE-SOURCE generator.
 *
 * The human docs portal content under `docs-site/src/content/docs/**` is the
 * canonical source. This script regenerates the flat agent-facing references
 * (`cli/llms-cli.txt`, `sdk/llms-sdk.txt`, `llms-mcp.txt`) from that same
 * content, so one edit updates both the human HTML surface (Starlight) and the
 * agent flat-file surface. The four flat files keep serving at their canonical
 * `docs.run402.com/<doc>` URLs and stay committed (so `raw.githubusercontent.com`
 * git-tag pins resolve).
 *
 * Determinism is a hard requirement (the SKILL.md/index digest contract and the
 * regen-clean CI gate both depend on byte-stable output): pages are ordered by
 * frontmatter `order` then path, frontmatter is stripped, line endings are
 * normalized to `\n`, exactly one trailing newline, no timestamps/build ids.
 *
 * SKILL.md is intentionally NOT in scope here — it is an agent-skills artifact
 * whose YAML frontmatter (`name`/`description`) is part of the discovery digest;
 * it remains authored at the repo root and is covered by build-agent-skills-index.mjs.
 *
 * Usage:
 *   node scripts/build-agent-flat-docs.mjs          # regenerate the flat files
 *   node scripts/build-agent-flat-docs.mjs --check   # CI: fail if regeneration would change them
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_ROOT = join(ROOT, "docs-site", "src", "content", "docs");

/** Each bundle maps a content section to one generated flat file. */
const BUNDLES = [
  // The FRONT DOOR (first-deploy-front-door spec): the first thing an agent
  // reads. One command, one file, two links — and a line budget so it stays
  // that way. Served at run402.com/llms.txt and docs.run402.com/llms.txt.
  { id: "front-door", section: "start", out: "llms.txt", flatHeader: "# Run402 — your first deploy", lineBudget: 180 },
  { id: "cli", section: "cli", out: "cli/llms-cli.txt", flatHeader: "# Run402 CLI -- Agent Reference" },
  { id: "sdk", section: "sdk", out: "sdk/llms-sdk.txt", flatHeader: "# @run402/sdk — comprehensive reference" },
  { id: "mcp", section: "mcp", out: "llms-mcp.txt", flatHeader: "# Run402 MCP Server — comprehensive tool reference" },
];

/**
 * Expert sections a first deploy never needs. In `llms-cli.txt` every one
 * of them MUST come after the command reference (first-deploy-front-door
 * spec, "The full CLI reference puts first-deploy material before expert
 * material"); the generator refuses to emit a file where one precedes it.
 */
const CLI_COMMAND_REFERENCE_HEADING = "## Command Reference";
const CLI_EXPERT_HEADING_PATTERNS = [
  /^## .*Buzz/im,
  /^## .*Nostr/im,
  /^## .*Portable Project Archives/im,
  /^## .*Run402 Core/im,
  /^## R402_\*/im,
];

export function assertCliSectionOrder(text) {
  const refIndex = text.indexOf(`\n${CLI_COMMAND_REFERENCE_HEADING}`);
  if (refIndex < 0) throw new Error(`[build-agent-flat-docs] llms-cli.txt has no '${CLI_COMMAND_REFERENCE_HEADING}' section`);
  const before = text.slice(0, refIndex);
  const offending = CLI_EXPERT_HEADING_PATTERNS.map((re) => before.match(re)?.[0]).filter(Boolean);
  if (offending.length > 0) {
    throw new Error(
      `[build-agent-flat-docs] llms-cli.txt: expert section(s) precede the command reference — move them after it: ${offending.join(" | ")}`,
    );
  }
}

export function assertLineBudget(bundle, text) {
  if (!bundle.lineBudget) return;
  const lines = text.replace(/\n$/, "").split("\n").length;
  if (lines > bundle.lineBudget) {
    throw new Error(
      `[build-agent-flat-docs] ${bundle.out} is ${lines} lines; the front-door budget is ${bundle.lineBudget}. Move detail into the references and link to it.`,
    );
  }
}

/** Recursively list *.md / *.mdx files under a directory (sorted by path). */
function listMarkdown(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // section not present yet
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listMarkdown(full));
    else if (/\.mdx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Split YAML frontmatter from a markdown body. Returns { data, body }. */
function splitFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: raw };
  const body = raw.slice(m[0].length);
  const data = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (mm) data[mm[1]] = mm[2].trim();
  }
  return { data, body };
}

/** Normalize to LF, strip trailing whitespace-only tail, single trailing newline. */
function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
}

/** Build the flat-file bytes for one bundle from its source pages. */
function renderBundle(bundle) {
  const pages = listMarkdown(join(CONTENT_ROOT, bundle.section)).map((path) => {
    const { data, body } = splitFrontmatter(readFileSync(path, "utf-8"));
    return {
      path,
      order: Number.isFinite(Number(data.order)) ? Number(data.order) : 1e9,
      body,
    };
  });
  if (pages.length === 0) {
    throw new Error(`[build-agent-flat-docs] bundle '${bundle.id}': no source pages under ${relative(ROOT, join(CONTENT_ROOT, bundle.section))}`);
  }
  // Deterministic order: explicit `order`, then path.
  pages.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  // Trim each page body (leading/trailing blank lines are not significant) and
  // join with a single blank line; normalize() adds the lone trailing newline.
  // The agent-file title H1 is generator-owned (bundle.flatHeader) so the rendered
  // portal pages carry only the Starlight frontmatter title — no duplicate body H1.
  const parts = pages.map((p) => p.body.replace(/\r\n/g, "\n").trim());
  const joined = (bundle.flatHeader ? [bundle.flatHeader, ...parts] : parts).join("\n\n");
  return normalize(joined);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const check = process.argv.includes("--check");
let stale = [];

for (const bundle of isMain ? BUNDLES : []) {
  const next = renderBundle(bundle);
  assertLineBudget(bundle, next);
  if (bundle.id === "cli") assertCliSectionOrder(next);
  const outPath = join(ROOT, bundle.out);
  let current = "";
  try {
    current = readFileSync(outPath, "utf-8");
  } catch {
    /* missing → treated as stale */
  }
  if (check) {
    if (current !== next) stale.push(bundle.out);
  } else if (current !== next) {
    writeFileSync(outPath, next);
    console.log(`regenerated ${bundle.out}`);
  } else {
    console.log(`unchanged   ${bundle.out}`);
  }
}

if (isMain && check) {
  if (stale.length) {
    console.error(
      `agent flat docs are stale — run: node scripts/build-agent-flat-docs.mjs\n  stale: ${stale.join(", ")}`,
    );
    process.exit(1);
  }
  console.log("agent flat docs are up to date");
}
