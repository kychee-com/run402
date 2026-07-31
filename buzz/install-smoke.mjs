#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentSkillDistribution,
  inspectTarGz,
  writeDistribution,
} from "../scripts/build-agent-skills-index.mjs";

const buzzSource = dirname(fileURLToPath(import.meta.url));
const publishRoot = mkdtempSync(join(tmpdir(), "run402-skill-origin-"));
const workspaces = [];
const requests = [];
const distribution = buildAgentSkillDistribution();
writeDistribution(publishRoot, distribution);
let corruptBuzzDigest = false;
const buzzArtifact = distribution.release.artifacts.find(({ name }) => name === "run402-buzz");
const ARCHIVED_FILES = inspectTarGz(readFileSync(join(publishRoot, buzzArtifact.path)))
  .map((entry) => entry.path)
  .sort();

const CONTENT_TYPES = new Map([
  [".well-known/agent-skills/index.json", "application/json; charset=utf-8"],
  ...distribution.release.artifacts.map(({ path, content_type }) => [path, content_type]),
]);

function exec(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function installedFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return installedFiles(root, path);
    return [path.slice(root.length + 1)];
  });
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const path = requestUrl.pathname.replace(/^\//, "");
  requests.push(path);
  if (path === ".well-known/agent-skills/index.json") {
    const port = server.address().port;
    const localIndex = JSON.parse(distribution.indexBytes.toString("utf8"));
    for (const skill of localIndex.skills) {
      const artifactPath = new URL(skill.url).pathname;
      skill.url = `http://127.0.0.1:${port}${artifactPath}`;
      if (corruptBuzzDigest && skill.name === "run402-buzz") skill.digest = `sha256:${"0".repeat(64)}`;
    }
    const body = `${JSON.stringify(localIndex, null, 2)}\n`;
    response.writeHead(200, {
      "content-type": CONTENT_TYPES.get(path),
      "content-length": Buffer.byteLength(body),
      "cache-control": "public, max-age=300, must-revalidate",
    });
    response.end(body);
    return;
  }
  const absolute = resolve(publishRoot, path);
  if (!absolute.startsWith(`${normalize(publishRoot)}/`) || !CONTENT_TYPES.has(path) || !existsSync(absolute)) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const bytes = readFileSync(absolute);
  response.writeHead(200, {
    "content-type": CONTENT_TYPES.get(path),
    "content-length": bytes.length,
    "cache-control": "public, max-age=31536000, immutable",
  });
  response.end(bytes);
});

async function installFirstParty(baseUrl, targets, expectedPaths) {
  const workspace = mkdtempSync(join(tmpdir(), "run402-buzz-installer-"));
  workspaces.push(workspace);
  writeFileSync(join(workspace, "package.json"), "{}\n");
  const result = await exec("npx", [
    "--yes",
    "skills@latest",
    "add",
    baseUrl,
    "-s",
    "run402-buzz",
    "-a",
    ...targets,
    "-y",
  ], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, DO_NOT_TRACK: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const relativePath of expectedPaths) {
    const installed = join(workspace, relativePath);
    assert.ok(existsSync(installed), `${targets.join("+")} omitted ${relativePath}`);
    for (const dependency of [
      "SKILL.md",
      "scripts/setup.mjs",
      "scripts/buzz-publish-proof.mjs",
      "scripts/strict-json.mjs",
      "references/identity-and-security.md",
      "references/community-control-plane.md",
      "references/installation.md",
      "references/receipts.md",
      "fixtures/buzz-v0.4.26-managed-agent-kind1.json",
      "fixtures/buzz-v0.4.26-desktop-owner-negative.json",
      "fixtures/buzz-v0.5.2-community-authority.json",
      "fixtures/identity-link-v1-golden.json",
    ]) assert.ok(existsSync(join(installed, dependency)), `installer omitted ${dependency}`);
    assert.equal(existsSync(join(installed, "README.md")), false, "runtime archive must omit repository-only README");
    assert.equal(existsSync(join(installed, "setup.test.mjs")), false, "runtime archive must omit tests");
    assert.deepEqual(installedFiles(realpathSync(installed)).sort(), ARCHIVED_FILES);
  }
  assert.equal(existsSync(join(workspace, ".run402")), false);
  assert.equal(existsSync(join(workspace, "run402.json")), false);
  return { workspace, result };
}

async function installFallbackFixture() {
  const workspace = mkdtempSync(join(tmpdir(), "run402-buzz-fallback-"));
  workspaces.push(workspace);
  writeFileSync(join(workspace, "package.json"), "{}\n");
  const result = await exec("npx", [
    "--yes",
    "skills@latest",
    "add",
    buzzSource,
    "-a",
    "codex",
    "-y",
  ], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, DO_NOT_TRACK: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(existsSync(join(workspace, ".agents", "skills", "run402-buzz", "SKILL.md")));
  assert.equal(existsSync(join(workspace, ".run402")), false);
  return workspace;
}

async function rejectIntegrityFailure(baseUrl) {
  const workspace = mkdtempSync(join(tmpdir(), "run402-buzz-integrity-"));
  workspaces.push(workspace);
  writeFileSync(join(workspace, "package.json"), "{}\n");
  corruptBuzzDigest = true;
  const result = await exec("npx", [
    "--yes",
    "skills@latest",
    "add",
    baseUrl,
    "-s",
    "run402-buzz",
    "-a",
    "codex",
    "-y",
  ], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, DO_NOT_TRACK: "1" },
  });
  corruptBuzzDigest = false;
  assert.notEqual(result.status, 0, "digest mismatch must fail closed");
  assert.equal(existsSync(join(workspace, ".agents", "skills", "run402-buzz")), false);
  assert.equal(existsSync(join(workspace, ".run402")), false);
}

try {
  assert.ok(ARCHIVED_FILES.includes("SKILL.md"));

  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    { targets: ["claude-code"], paths: [".claude/skills/run402-buzz"] },
    { targets: ["codex"], paths: [".agents/skills/run402-buzz"] },
    { targets: ["goose"], paths: [".goose/skills/run402-buzz"] },
    { targets: ["universal"], paths: [".agents/skills/run402-buzz"] },
    { targets: ["claude-code", "codex"], paths: [".agents/skills/run402-buzz", ".claude/skills/run402-buzz"] },
  ];
  for (const testCase of cases) {
    await installFirstParty(baseUrl, testCase.targets, testCase.paths);
  }
  await rejectIntegrityFailure(baseUrl);
  await installFallbackFixture();

  assert.ok(requests.includes(".well-known/agent-skills/index.json"));
  assert.ok(requests.some((path) => path.endsWith("/run402-buzz.tgz")));
  assert.equal(requests.some((path) => /github|skills\.sh|raw\.githubusercontent/.test(path)), false);
  console.log(JSON.stringify({
    status: "pass",
    installer: "skills@latest",
    source_class: "run402_first_party",
    target_matrix: cases.map(({ targets }) => targets),
    fallback_fixture: "github_source_fallback",
    integrity_fallback: "forbidden",
    mutation_state: "not_started",
  }));
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
  rmSync(publishRoot, { recursive: true, force: true });
}
