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
  // The CLI reference is SLICED (agent-docs-slices): the page whose frontmatter
  // says `slice: index` becomes the short `llms-cli.txt` (first-deploy contract
  // + a table of fetchable slices), every other page becomes its own
  // `cli/llms-cli-<slice>.txt`, and the whole book stays available as
  // `cli/llms-cli-full.txt`. A fetch that truncates at ~60 KB (the size at which
  // several agent runtimes cut a document off) must still return a complete
  // contract, so the index and every slice carry a byte budget.
  {
    id: "cli",
    section: "cli",
    out: "cli/llms-cli.txt",
    flatHeader: "# Run402 CLI -- Agent Reference",
    slices: {
      full: "cli/llms-cli-full.txt",
      outFor: (slice) => `cli/llms-cli-${slice}.txt`,
      urlFor: (slice) => `https://docs.run402.com/llms-cli-${slice}.txt`,
      indexUrl: "https://docs.run402.com/llms-cli.txt",
      fullUrl: "https://docs.run402.com/llms-cli-full.txt",
      indexByteBudget: 48 * 1024,
      sliceByteBudget: 56 * 1024,
    },
  },
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

export function assertByteBudget(label, text, budget) {
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes > budget) {
    throw new Error(
      `[build-agent-flat-docs] ${label} is ${bytes} bytes; the slice budget is ${budget}. Split the page into another slice (frontmatter \`slice:\`) rather than growing it.`,
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

/** A frontmatter scalar may be JSON-quoted (values with a colon must be). */
function unquote(value) {
  if (/^".*"$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Split YAML frontmatter from a markdown body. Returns { data, body }. */
function splitFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: raw };
  const body = raw.slice(m[0].length);
  const data = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (mm) data[mm[1]] = unquote(mm[2].trim());
  }
  return { data, body };
}

/** Normalize to LF, strip trailing whitespace-only tail, single trailing newline. */
function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
}

/** Load and order the source pages of one bundle. */
function loadPages(bundle) {
  const pages = listMarkdown(join(CONTENT_ROOT, bundle.section)).map((path) => {
    const { data, body } = splitFrontmatter(readFileSync(path, "utf-8"));
    return {
      path,
      order: Number.isFinite(Number(data.order)) ? Number(data.order) : 1e9,
      slice: data.slice ?? null,
      title: data.title ?? null,
      summary: data.summary ?? null,
      body: body.replace(/\r\n/g, "\n").trim(),
    };
  });
  if (pages.length === 0) {
    throw new Error(`[build-agent-flat-docs] bundle '${bundle.id}': no source pages under ${relative(ROOT, join(CONTENT_ROOT, bundle.section))}`);
  }
  // Deterministic order: explicit `order`, then path.
  pages.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  return pages;
}

/** Build the flat-file bytes for one bundle from its source pages. */
function renderBundle(bundle) {
  // Trim each page body (leading/trailing blank lines are not significant) and
  // join with a single blank line; normalize() adds the lone trailing newline.
  // The agent-file title H1 is generator-owned (bundle.flatHeader) so the rendered
  // portal pages carry only the Starlight frontmatter title — no duplicate body H1.
  const parts = loadPages(bundle).map((p) => p.body);
  const joined = (bundle.flatHeader ? [bundle.flatHeader, ...parts] : parts).join("\n\n");
  return normalize(joined);
}

/**
 * The slice table appended to the index. Sizes are derived from the rendered
 * slice bytes, so the table is byte-stable for a given source tree (the regen
 * gate depends on that) and an agent can budget a fetch before making it.
 */
export function renderSliceTable(slices, cfg) {
  const lines = [
    "## Fetchable reference slices",
    "",
    "This file is the index: everything above is the whole first-deploy contract. The rest of the CLI reference is split into slices so a single fetch never truncates; fetch only the slice you need (`curl -sL <url>`). Every slice is self-contained and links back here.",
    "",
    "| Slice | Fetch | Covers | Size |",
    "|---|---|---|---|",
  ];
  for (const s of slices) {
    const kb = Math.max(1, Math.round(s.bytes / 1024));
    lines.push(`| ${s.title} | ${cfg.urlFor(s.slice)} | ${s.summary ?? ""} | ~${kb} KB |`);
  }
  lines.push(
    "",
    `The whole reference as one document (large; only when you can hold it): ${cfg.fullUrl}`,
  );
  return lines.join("\n");
}

/**
 * Render a sliced bundle. Returns [{ out, text, label }] for the index, every
 * slice, and the full concatenation, in that order.
 */
export function renderSlicedBundle(bundle) {
  const cfg = bundle.slices;
  const pages = loadPages(bundle);
  const index = pages.find((p) => p.slice === "index");
  if (!index) throw new Error(`[build-agent-flat-docs] bundle '${bundle.id}': no page declares \`slice: index\``);
  const others = pages.filter((p) => p !== index);
  const seen = new Set();
  for (const p of others) {
    if (!p.slice || !/^[a-z][a-z0-9-]*$/.test(p.slice) || p.slice === "full") {
      throw new Error(`[build-agent-flat-docs] ${relative(ROOT, p.path)}: every page of a sliced bundle needs a kebab-case \`slice:\` (not 'full')`);
    }
    if (seen.has(p.slice)) throw new Error(`[build-agent-flat-docs] duplicate slice '${p.slice}' (${relative(ROOT, p.path)})`);
    seen.add(p.slice);
    if (!p.title) throw new Error(`[build-agent-flat-docs] ${relative(ROOT, p.path)}: slice pages need a \`title:\``);
  }
  const outputs = [];
  const rendered = others.map((p) => {
    const header = [
      `${bundle.flatHeader} — ${p.title}`,
      "",
      `> Slice \`${p.slice}\` of the Run402 CLI reference. Index (start here): ${cfg.indexUrl} · Whole reference: ${cfg.fullUrl}`,
    ].join("\n");
    const text = normalize([header, p.body].join("\n\n"));
    return { ...p, text, bytes: Buffer.byteLength(text, "utf-8") };
  });
  const indexText = normalize([bundle.flatHeader, index.body, renderSliceTable(rendered, cfg)].join("\n\n"));
  outputs.push({ out: bundle.out, text: indexText, label: `${bundle.out} (index)`, budget: cfg.indexByteBudget });
  for (const r of rendered) {
    outputs.push({ out: cfg.outFor(r.slice), text: r.text, label: cfg.outFor(r.slice), budget: cfg.sliceByteBudget });
  }
  const full = normalize([bundle.flatHeader, ...pages.map((p) => p.body)].join("\n\n"));
  outputs.push({ out: cfg.full, text: full, label: cfg.full, budget: null, isFull: true });
  return outputs;
}

/**
 * Every flat file this generator owns, as { asset, path } (asset = the served
 * basename). The docs deploy manifest and the workflows consume this list so a
 * new slice is served the moment it exists.
 */
export function listAgentFlatFiles() {
  const out = [];
  for (const bundle of BUNDLES) {
    if (bundle.id === "front-door") continue; // llms.txt is served from the apex, not the docs project
    if (bundle.slices) {
      for (const o of renderSlicedBundle(bundle)) out.push({ asset: o.out.split("/").pop(), path: o.out });
    } else {
      out.push({ asset: bundle.out.split("/").pop(), path: bundle.out });
    }
  }
  return out;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const check = process.argv.includes("--check");
let stale = [];

function writeOrCheck(outRel, next) {
  const outPath = join(ROOT, outRel);
  let current = "";
  try {
    current = readFileSync(outPath, "utf-8");
  } catch {
    /* missing → treated as stale */
  }
  if (check) {
    if (current !== next) stale.push(outRel);
  } else if (current !== next) {
    writeFileSync(outPath, next);
    console.log(`regenerated ${outRel}`);
  } else {
    console.log(`unchanged   ${outRel}`);
  }
}

for (const bundle of isMain ? BUNDLES : []) {
  if (bundle.slices) {
    for (const o of renderSlicedBundle(bundle)) {
      if (o.budget) assertByteBudget(o.label, o.text, o.budget);
      if (o.isFull) assertCliSectionOrder(o.text);
      writeOrCheck(o.out, o.text);
    }
    continue;
  }
  const next = renderBundle(bundle);
  assertLineBudget(bundle, next);
  writeOrCheck(bundle.out, next);
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
