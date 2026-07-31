import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  BUZZ_ARCHIVE_FILES,
  buildAgentSkillDistribution,
  inspectTarGz,
  writeDistribution,
} from "./build-agent-skills-index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("first-party Agent Skills artifacts", () => {
  it("builds byte-identical content-addressed artifacts", () => {
    const first = buildAgentSkillDistribution();
    const second = buildAgentSkillDistribution();
    assert.ok(first.indexBytes.equals(second.indexBytes));
    assert.deepEqual([...first.artifacts.keys()], [...second.artifacts.keys()]);
    for (const [path, bytes] of first.artifacts) {
      assert.ok(bytes.equals(second.artifacts.get(path)), path);
      const digest = createHash("sha256").update(bytes).digest("hex");
      assert.match(path, new RegExp(`/${digest}/`));
    }
  });

  it("advertises exact apex bytes for run402 and run402-buzz", () => {
    const distribution = buildAgentSkillDistribution();
    const index = JSON.parse(distribution.indexBytes.toString("utf8"));
    assert.equal(index.$schema, "https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    assert.deepEqual(index.skills.map(({ name, type }) => ({ name, type })), [
      { name: "run402", type: "skill-md" },
      { name: "run402-buzz", type: "archive" },
    ]);
    for (const entry of index.skills) {
      const url = new URL(entry.url);
      assert.equal(url.origin, "https://run402.com");
      const bytes = distribution.artifacts.get(url.pathname.slice(1));
      assert.ok(bytes, entry.url);
      assert.equal(entry.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    }
    const generic = index.skills.find(({ name }) => name === "run402");
    assert.ok(distribution.artifacts.get(new URL(generic.url).pathname.slice(1)).equals(readFileSync(join(ROOT, "SKILL.md"))));
  });

  it("archives exactly the regular-file runtime allowlist with source parity", () => {
    const distribution = buildAgentSkillDistribution();
    const buzz = distribution.release.artifacts.find(({ name }) => name === "run402-buzz");
    const entries = inspectTarGz(distribution.artifacts.get(buzz.path));
    assert.deepEqual(entries.map(({ path }) => path), [...BUZZ_ARCHIVE_FILES].sort());
    for (const entry of entries) {
      assert.equal(entry.type, "0", entry.path);
      assert.ok(entry.bytes.equals(readFileSync(join(ROOT, "buzz", entry.path))), entry.path);
      assert.equal(lstatSync(join(ROOT, "buzz", entry.path)).isFile(), true);
      assert.equal(lstatSync(join(ROOT, "buzz", entry.path)).isSymbolicLink(), false);
      assert.equal(entry.path.startsWith("/"), false);
      assert.equal(entry.path.split("/").includes(".."), false);
    }
    const skill = entries.find(({ path }) => path === "SKILL.md").bytes.toString("utf8");
    assert.match(skill, /^name: run402-buzz$/m);
    assert.doesNotMatch(skill, /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/);
  });

  it("writes a self-contained publication tree without deleting retained objects", () => {
    const output = mkdtempSync(join(tmpdir(), "run402-agent-skills-"));
    try {
      const retained = join(output, "skills", "run402-buzz", "old-digest", "run402-buzz.tgz");
      writeDistribution(output, buildAgentSkillDistribution());
      const release = JSON.parse(readFileSync(join(output, "agent-skills-release.json"), "utf8"));
      for (const artifact of release.artifacts) {
        const bytes = readFileSync(join(output, artifact.path));
        assert.equal(artifact.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      }
      // A second write is additive: deploy tooling owns immutable retention.
      mkdirSync(dirname(retained), { recursive: true });
      writeFileSync(retained, "retained");
      writeDistribution(output, buildAgentSkillDistribution());
      assert.equal(readFileSync(retained, "utf8"), "retained");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
