import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(__dirname, "SKILL.md"), "utf-8");

// Split frontmatter from body
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
assert.ok(fmMatch, "SKILL.md must have YAML frontmatter delimited by ---");

const frontmatter = parseYaml(fmMatch[1]);
const body = fmMatch[2];

// ── Frontmatter ────────────────────────────────────────────────

describe("frontmatter", () => {
  it("has required name field", () => {
    assert.equal(frontmatter.name, "run402");
  });

  it("has required description field", () => {
    assert.ok(
      typeof frontmatter.description === "string" &&
        frontmatter.description.length > 0,
      "description must be a non-empty string",
    );
  });

  it("has openclaw metadata", () => {
    assert.ok(frontmatter.metadata?.openclaw, "metadata.openclaw must exist");
  });

  it("has valid emoji", () => {
    assert.equal(frontmatter.metadata.openclaw.emoji, "🐘");
  });

  it("has homepage URL", () => {
    assert.ok(
      frontmatter.metadata.openclaw.homepage.startsWith("https://"),
      "homepage must be an HTTPS URL",
    );
  });

  it("requires npx binary", () => {
    assert.deepEqual(frontmatter.metadata.openclaw.requires.bins, ["npx"]);
  });

  it("installs the run402 CLI package", () => {
    const install = frontmatter.metadata.openclaw.install;
    assert.ok(Array.isArray(install), "install must be an array");
    assert.equal(install.length, 1);
    assert.equal(install[0].kind, "node");
    assert.equal(
      install[0].package,
      "run402",
      "this skill is CLI-based — install must be the `run402` npm package",
    );
    assert.ok(
      install[0].bins.includes("run402"),
      "bins must include the run402 binary",
    );
  });

  it("has primaryEnv set to RUN402_API_BASE", () => {
    assert.equal(frontmatter.metadata.openclaw.primaryEnv, "RUN402_API_BASE");
  });
});

// ── Slug validation ────────────────────────────────────────────

describe("skill slug", () => {
  it("matches ^[a-z0-9][a-z0-9-]*$", () => {
    assert.match(frontmatter.name, /^[a-z0-9][a-z0-9-]*$/);
  });
});

// ── Body — CLI verb references ─────────────────────────────────
//
// The skill teaches the platform exclusively via `run402 …` commands.
// These are the verbs we expect every reader to encounter — the modern
// happy-path surfaces (provision, sql, expose manifest, deploy-dir, blob put,
// tier set). If any of these go missing, an agent loses a primary entry
// point.

const CLI_VERBS = [
  "run402 init",
  "run402 projects provision",
  "run402 projects sql",
  "run402 projects apply-expose",
  "run402 sites deploy-dir",
  "run402 blob put",
  "run402 tier set",
];

describe("body CLI verb references", () => {
  for (const verb of CLI_VERBS) {
    it(`references CLI verb: ${verb}`, () => {
      assert.ok(body.includes(verb), `body must mention "${verb}"`);
    });
  }
});

// ── Body — anti-patterns ───────────────────────────────────────
//
// The skill is intentionally CLI-only. Catch regressions where deprecated
// surfaces or non-CLI modalities sneak back in. We ban:
//   - the legacy `setup_rls` / `projects rls` flow (replaced by apply-expose)
//   - the removed `inherit: true` deploy flag
//   - MCP tool-call JSON pasted into the body (the run402-mcp package is
//     a sibling, not what this skill teaches)

const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsetup_rls\b/, reason: "setup_rls is replaced by apply-expose; do not document it" },
  { pattern: /\bprojects rls\b/, reason: "`projects rls` is replaced by `projects apply-expose`" },
  { pattern: /"inherit"\s*:\s*true/, reason: "the `inherit: true` deploy flag was removed in v1.32" },
];

describe("body anti-patterns", () => {
  for (const { pattern, reason } of BANNED_PATTERNS) {
    it(`does not contain: ${pattern.source}`, () => {
      assert.ok(!pattern.test(body), `${reason}`);
    });
  }
});

// ── Body — required sections ───────────────────────────────────

const REQUIRED_SECTIONS = [
  "30-second start",
  "Authorization — the expose manifest",
  "Storage — paste-and-go assets",
  "Functions",
  "Standard Workflow",
  "Payment Handling",
  "Tips & Guardrails",
  "Agent Allowance Setup",
  "Troubleshooting",
  "Tools Reference",
];

describe("body required sections", () => {
  for (const section of REQUIRED_SECTIONS) {
    it(`has section: ${section}`, () => {
      assert.ok(body.includes(section), `body must contain "${section}" section`);
    });
  }
});

// ── Markdown integrity ─────────────────────────────────────────

describe("markdown integrity", () => {
  it("has no unclosed fenced code blocks", () => {
    const fences = body.match(/^```/gm) || [];
    assert.equal(
      fences.length % 2,
      0,
      `found ${fences.length} fence markers — expected an even number`,
    );
  });

  it("starts with a heading", () => {
    const firstLine = body.trimStart().split("\n")[0];
    assert.ok(firstLine.startsWith("#"), "body should start with a markdown heading");
  });
});
