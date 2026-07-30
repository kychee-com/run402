import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ROOT, "..");
const SKILL = readFileSync(join(ROOT, "SKILL.md"), "utf8");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

function files(directory = ROOT) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [path];
    if (entry.isDirectory() && [".git", ".claude", ".codex", "node_modules", "dist"].includes(entry.name)) return [];
    return entry.isDirectory() ? files(path) : [path];
  });
}

describe("run402-buzz distributable package", () => {
  it("has valid external-name frontmatter and bounded discovery triggers", () => {
    const frontmatter = SKILL.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter);
    assert.match(frontmatter[1], /^name: run402-buzz$/m);
    assert.match(frontmatter[1], /install, initialize, set up, or connect Run402/);
    assert.match(frontmatter[1], /later asks.*build, deploy, update, verify, or operate/);
  });

  it("documents the direct, noninteractive Codex install without redundant selectors", () => {
    assert.match(
      README,
      /npx skills add https:\/\/github\.com\/kychee-com\/run402\/tree\/main\/buzz -a codex -y/,
    );
    assert.doesNotMatch(README, /skills@latest|--skill run402-buzz|--copy|--agent codex|--yes/);
  });

  it("contains only bounded regular Markdown, JSON, and JavaScript files", () => {
    const all = files();
    assert.ok(all.length >= 8);
    for (const file of all) {
      const stat = lstatSync(file);
      assert.ok(stat.isFile(), `${file} must be a regular file`);
      assert.ok(stat.size <= 128 * 1024, `${file} exceeds package size bound`);
      assert.ok([".md", ".json", ".mjs"].includes(extname(file)), `${file} has an unsupported type`);
    }
  });

  it("keeps every local Markdown reference inside the installed package", () => {
    for (const match of SKILL.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = resolve(ROOT, match[1]);
      assert.equal(relative(ROOT, target).startsWith(".."), false, match[1]);
      assert.ok(existsSync(target), match[1]);
    }
    assert.doesNotMatch(SKILL, /integrations\/run402-for-buzz|\.\.\//);
    assert.match(SKILL, /node <skill-directory>\/scripts\/setup\.mjs/);
    assert.match(SKILL, /--wallet <profile>/);
    for (const dependency of [
      "scripts/setup.mjs",
      "scripts/buzz-publish-proof.mjs",
      "scripts/strict-json.mjs",
      "references/identity-and-security.md",
      "references/receipts.md",
    ]) assert.ok(existsSync(join(ROOT, dependency)), dependency);
  });

  it("has one canonical Buzz skill and cannot collide with the generic root skill", () => {
    assert.equal(existsSync(join(REPO, "integrations/run402-for-buzz/.agents/skills/run402/SKILL.md")), false);
    const rootSkill = readFileSync(join(REPO, "SKILL.md"), "utf8");
    assert.match(rootSkill, /^name: run402$/m);
    assert.match(SKILL, /^name: run402-buzz$/m);
    assert.notEqual(rootSkill.match(/^name: (.+)$/m)?.[1], SKILL.match(/^name: (.+)$/m)?.[1]);
    const buzzSkills = files(REPO)
      .filter((file) => file.endsWith("SKILL.md"))
      .filter((file) => lstatSync(file).isFile())
      .filter((file) => /^name: run402-buzz$/m.test(readFileSync(file, "utf8")));
    assert.deepEqual(buzzSkills.map((file) => normalize(file)), [normalize(join(ROOT, "SKILL.md"))]);
  });

  it("keeps setup inert until requested and app work behind affirmative approval", () => {
    const disclosure = SKILL.indexOf("## Public-link disclosure");
    const setup = SKILL.indexOf("## Set up Run402");
    const ready = SKILL.indexOf("## Offer one contextual test");
    const approved = SKILL.indexOf("## Build and deploy only after approval");
    assert.ok(disclosure < setup && setup < ready && ready < approved);
    assert.match(SKILL, /Installing, copying, updating, or discovering this skill performs no setup/);
    assert.match(SKILL, /Do not build anything until the user affirmatively agrees/);
    assert.match(SKILL, /plan\/rehearsal path before apply/);
    assert.match(SKILL, /Independently request the live endpoint/);
    assert.match(SKILL, /run402 wallets new <profile>/);
    assert.match(SKILL, /selection_source: explicit_argument/);
    assert.match(SKILL, /do not rely on ambient selection/);
  });

  it("contains no embedded secret values or secret-export instructions", () => {
    const content = files()
      .filter((file) => !file.endsWith(".test.mjs"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    assert.doesNotMatch(content, /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/i);
    assert.doesNotMatch(content, /(?:private[_ -]?key|mnemonic|seed)\s*[:=]\s*["'][^"']{8,}["']/i);
    assert.match(SKILL, /Never request, read, locate, export, transform, derive, print, log, or post/);
  });

  it("has balanced Markdown fences", () => {
    assert.equal((SKILL.match(/^```/gm) ?? []).length % 2, 0);
  });
});
