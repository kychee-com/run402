import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSkill(relPath: string) {
  const raw = readFileSync(join(__dirname, relPath), "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(fmMatch, `${relPath} must have YAML frontmatter delimited by ---`);
  return { frontmatter: parseYaml(fmMatch[1]), body: fmMatch[2] };
}

const root = loadSkill("SKILL.md");
const openclaw = loadSkill("openclaw/SKILL.md");

// ── Root SKILL.md (MCP-based, ships with run402-mcp) ────────────

describe("SKILL.md (root, MCP-based)", () => {
  describe("frontmatter", () => {
    it("name = run402", () => assert.equal(root.frontmatter.name, "run402"));

    it("has non-empty description", () => {
      assert.ok(
        typeof root.frontmatter.description === "string" &&
          root.frontmatter.description.length > 0,
      );
    });

    it("openclaw metadata exists", () => {
      assert.ok(root.frontmatter.metadata?.openclaw);
    });

    it("emoji is 🐘", () => {
      assert.equal(root.frontmatter.metadata.openclaw.emoji, "🐘");
    });

    it("homepage is HTTPS", () => {
      assert.ok(
        root.frontmatter.metadata.openclaw.homepage.startsWith("https://"),
      );
    });

    it("requires npx", () => {
      assert.deepEqual(
        root.frontmatter.metadata.openclaw.requires.bins,
        ["npx"],
      );
    });

    it("installs run402-mcp (the MCP server, not the CLI)", () => {
      const install = root.frontmatter.metadata.openclaw.install;
      assert.ok(Array.isArray(install));
      assert.equal(install.length, 1);
      assert.equal(install[0].kind, "node");
      assert.equal(
        install[0].package,
        "run402-mcp",
        "root SKILL.md is the MCP-based skill — install must be the run402-mcp package",
      );
      assert.ok(install[0].bins.includes("run402-mcp"));
    });

    it("primaryEnv is RUN402_API_BASE", () => {
      assert.equal(
        root.frontmatter.metadata.openclaw.primaryEnv,
        "RUN402_API_BASE",
      );
    });
  });

  describe("body — MCP tool references", () => {
    // The skill teaches the platform via MCP tool names. Pin the tools
    // every reader should encounter for the modern v1.48 happy path.
    const TOOLS = [
      "provision_postgres_project",
      "run_sql",
      "rest_query",
      "apply_expose",
      "get_expose",
      "deploy_site_dir",
      "blob_put",
      "deploy_function",
      "set_tier",
    ];

    for (const tool of TOOLS) {
      it(`references tool: ${tool}`, () => {
        assert.ok(
          root.body.includes(tool),
          `body must mention ${tool}`,
        );
      });
    }
  });

  describe("body — anti-patterns (deprecated surfaces must not return)", () => {
    const banned: Array<{ pattern: RegExp; reason: string }> = [
      { pattern: /\bsetup_rls\b/, reason: "setup_rls was removed; use apply_expose" },
      { pattern: /\bget_deployment\b/, reason: "get_deployment was removed; use deploy/deploy_events/deploy_list" },
      { pattern: /"inherit"\s*:\s*true/, reason: "the inherit:true deploy flag was removed in v1.32" },
    ];
    for (const { pattern, reason } of banned) {
      it(`does not contain: ${pattern.source}`, () => {
        assert.ok(!pattern.test(root.body), reason);
      });
    }
  });

  describe("body — required sections", () => {
    const sections = [
      "Quickstart",
      "The patterns",
      "Paste-and-go assets",
      "Dark-by-default tables + the expose manifest",
      "Tools by category",
      "Standard Workflow",
      "Payment Handling",
      "Tips & Guardrails",
      "Agent Allowance Setup",
      "Troubleshooting",
      "Tools Reference",
    ];
    for (const section of sections) {
      it(`has section: ${section}`, () => {
        assert.ok(root.body.includes(section));
      });
    }
  });

  describe("markdown integrity", () => {
    it("has no unclosed fenced code blocks", () => {
      const fences = root.body.match(/^```/gm) || [];
      assert.equal(fences.length % 2, 0);
    });
    it("starts with a heading", () => {
      assert.ok(root.body.trimStart().split("\n")[0].startsWith("#"));
    });
  });
});

// ── openclaw/SKILL.md (CLI-based, ships in the OpenClaw skill dir) ─

describe("openclaw/SKILL.md (CLI-based)", () => {
  describe("frontmatter", () => {
    it("name = run402", () => assert.equal(openclaw.frontmatter.name, "run402"));
    it("has non-empty description", () => {
      assert.ok(
        typeof openclaw.frontmatter.description === "string" &&
          openclaw.frontmatter.description.length > 0,
      );
    });
    it("if install present, installs the CLI (not the MCP)", () => {
      const install = openclaw.frontmatter.metadata?.openclaw?.install;
      if (!install) return; // install is optional for an OpenClaw skill bundle
      assert.equal(
        install[0].package,
        "run402",
        "openclaw skill is CLI-based — install must be the run402 CLI package",
      );
    });
  });

  describe("body — CLI verb references", () => {
    const verbs = [
      "run402 init",
      "run402 projects provision",
      "run402 projects sql",
      "run402 projects apply-expose",
      "run402 sites deploy-dir",
      "run402 ci link github",
      "run402 ci list",
      "run402 ci revoke",
      "run402 blob put",
      "run402 tier set",
    ];
    for (const verb of verbs) {
      it(`references CLI verb: ${verb}`, () => {
        assert.ok(openclaw.body.includes(verb), `body must mention "${verb}"`);
      });
    }
  });

  describe("body — anti-patterns (deprecated surfaces must not return)", () => {
    const banned: Array<{ pattern: RegExp; reason: string }> = [
      { pattern: /\bsetup_rls\b/, reason: "setup_rls was removed; use apply-expose" },
      { pattern: /\bprojects rls\b/, reason: "`projects rls` was removed; use `projects apply-expose`" },
      { pattern: /\bsites\s+status\b/, reason: "`sites status` was removed; use `deploy events` / `deploy list`" },
      { pattern: /"inherit"\s*:\s*true/, reason: "the inherit:true deploy flag was removed in v1.32" },
    ];
    for (const { pattern, reason } of banned) {
      it(`does not contain: ${pattern.source}`, () => {
        assert.ok(!pattern.test(openclaw.body), reason);
      });
    }
  });

  describe("markdown integrity", () => {
    it("has no unclosed fenced code blocks", () => {
      const fences = openclaw.body.match(/^```/gm) || [];
      assert.equal(fences.length % 2, 0);
    });
    it("starts with a heading", () => {
      assert.ok(openclaw.body.trimStart().split("\n")[0].startsWith("#"));
    });
  });
});

// ── Slug validation ────────────────────────────────────────────

describe("skill slug", () => {
  it("root: matches ^[a-z0-9][a-z0-9-]*$", () => {
    assert.match(root.frontmatter.name, /^[a-z0-9][a-z0-9-]*$/);
  });
  it("openclaw: matches ^[a-z0-9][a-z0-9-]*$", () => {
    assert.match(openclaw.frontmatter.name, /^[a-z0-9][a-z0-9-]*$/);
  });
});
