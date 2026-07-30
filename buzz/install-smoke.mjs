#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "run402-buzz-installer-"));
try {
  const result = spawnSync("npx", [
    "-y", "skills", "add", source, "-a", "codex", "-y",
  ], { cwd: workspace, encoding: "utf8", shell: false, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const installed = join(workspace, ".agents", "skills", "run402-buzz");
  for (const dependency of [
    "SKILL.md",
    "README.md",
    "scripts/setup.mjs",
    "scripts/buzz-publish-proof.mjs",
    "scripts/strict-json.mjs",
    "references/identity-and-security.md",
    "references/receipts.md",
    "fixtures/buzz-v0.4.26-managed-agent-kind1.json",
    "fixtures/buzz-v0.4.26-desktop-owner-negative.json",
  ]) assert.ok(existsSync(join(installed, dependency)), `installer omitted ${dependency}`);
  const help = spawnSync(process.execPath, [join(installed, "scripts", "setup.mjs"), "--help"], {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--wallet/);
  assert.match(help.stdout, /--pubkey/);
  const installedTests = spawnSync(process.execPath, [
    "--test",
    join(installed, "setup.test.mjs"),
    join(installed, "helper.test.mjs"),
  ], { cwd: workspace, encoding: "utf8", shell: false, maxBuffer: 1024 * 1024 });
  assert.equal(installedTests.status, 0, installedTests.stderr || installedTests.stdout);
  const receipts = readFileSync(join(installed, "references", "receipts.md"), "utf8");
  assert.match(receipts, /Profile selection: `explicit_argument`/);
  assert.match(receipts, /Deployment: `none`/);
  assert.match(receipts, /Would you like me to try it\?/);
  console.log(JSON.stringify({ status: "pass", source, installed, skill: "run402-buzz" }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
