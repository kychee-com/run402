#!/usr/bin/env node
/**
 * Build .well-known/agent-skills/index.json — the Agent Skills Discovery
 * (RFC v0.2.0) index for the run402 skill.
 *
 * The public repo is authoritative for the skill DIGEST: the sha256 is
 * computed over THIS repo's SKILL.md — the same bytes published to
 * docs.run402.com. The apex (run402.com) serves this file verbatim, so the
 * digest it advertises always matches the bytes served at `url`. Drift is
 * additionally guarded by sync.test.ts.
 *
 * name + description come from SKILL.md's own YAML frontmatter (single source
 * of truth — no hand-maintained copy to drift).
 *
 * Usage:
 *   node scripts/build-agent-skills-index.mjs          # write the index
 *   node scripts/build-agent-skills-index.mjs --check  # verify it is current (CI)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = join(ROOT, "SKILL.md");
const INDEX_PATH = join(ROOT, ".well-known", "agent-skills", "index.json");

// SKILL.md is canonically served here once the docs site is live (Option C).
const SKILL_URL = "https://docs.run402.com/SKILL.md";

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("SKILL.md has no YAML frontmatter");
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+?)\s*$/m)?.[1];
  const description = fm.match(/^description:\s*(.+?)\s*$/m)?.[1];
  if (!name) throw new Error("SKILL.md frontmatter missing `name`");
  if (!description) throw new Error("SKILL.md frontmatter missing `description`");
  return { name, description };
}

function buildIndex() {
  const skill = readFileSync(SKILL_PATH, "utf-8");
  const { name, description } = parseFrontmatter(skill);
  const digest = "sha256:" + createHash("sha256").update(skill, "utf8").digest("hex");
  const index = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [{ name, type: "skill-md", description, url: SKILL_URL, digest }],
  };
  return JSON.stringify(index, null, 2) + "\n";
}

const content = buildIndex();

if (process.argv.includes("--check")) {
  let existing = "";
  try {
    existing = readFileSync(INDEX_PATH, "utf-8");
  } catch {
    /* missing → treated as stale below */
  }
  if (existing !== content) {
    console.error(
      "agent-skills index is stale — run: node scripts/build-agent-skills-index.mjs",
    );
    process.exit(1);
  }
  console.log("agent-skills index is up to date");
} else {
  mkdirSync(dirname(INDEX_PATH), { recursive: true });
  writeFileSync(INDEX_PATH, content);
  console.log(`wrote ${INDEX_PATH}`);
}
