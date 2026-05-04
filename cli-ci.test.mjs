import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-ci-cli-"));
const repoDir = join(tempDir, "repo");
const configDir = join(tempDir, "config");
const API = "https://test-api.run402.com";

process.env.RUN402_CONFIG_DIR = configDir;
process.env.RUN402_API_BASE = API;

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();

let calls = [];
let stdout = [];
let stderr = [];
let run;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseBody(raw) {
  if (!raw || typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function mockFetch(input, init) {
  const url = typeof input === "string"
    ? input
    : input instanceof Request
      ? input.url
      : String(input);
  const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
  const headers = Object.fromEntries(new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)));
  const body = parseBody(init?.body);
  calls.push({ url, method, headers, body });

  if (url === "https://api.github.com/repos/tal/myapp") {
    return Promise.resolve(json({ id: 892341, full_name: "tal/myapp" }));
  }
  if (url === "https://api.github.com/repos/tal/missing") {
    return Promise.resolve(json({ message: "Not Found" }, 404));
  }
  if (url === `${API}/ci/v1/bindings` && method === "POST") {
    if (body.project_id === "prj_dup") {
      return Promise.resolve(json({
        code: "duplicate",
        message: "duplicate CI binding",
        details: { subject_match: body.subject_match },
      }, 409));
    }
    return Promise.resolve(json({
      id: "cib_123",
      project_id: body.project_id,
      issuer: "https://token.actions.githubusercontent.com",
      subject_match: body.subject_match,
      allowed_actions: body.allowed_actions,
      allowed_events: body.allowed_events,
      github_repository_id: body.github_repository_id,
      created_by: TEST_ADDRESS,
      nonce: body.nonce,
      created_sig: null,
      created_at: "2026-05-03T00:00:00Z",
      expires_at: body.expires_at,
      revoked_at: null,
      last_used_at: null,
      use_count: 0,
    }, 201));
  }
  if (url === `${API}/ci/v1/bindings?project=prj_ci` && method === "GET") {
    return Promise.resolve(json({ bindings: [{ id: "cib_123", project_id: "prj_ci" }] }));
  }
  if (url === `${API}/ci/v1/bindings/cib_123/revoke` && method === "POST") {
    return Promise.resolve(json({ id: "cib_123", project_id: "prj_ci", revoked_at: "2026-05-03T01:00:00Z" }));
  }
  return Promise.resolve(new Response("Not Found", { status: 404 }));
}

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

function writeAllowance() {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "allowance.json"), JSON.stringify({
    address: TEST_ADDRESS,
    privateKey: TEST_PRIVATE_KEY,
  }));
}

before(async () => {
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:tal/myapp.git"], { cwd: repoDir });
  process.chdir(repoDir);
  writeAllowance();
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  ({ run } = await import("./cli/lib/ci.mjs"));
});

after(() => {
  process.chdir(originalCwd);
  captureStop();
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  captureStop();
  rmSync(join(repoDir, ".github"), { recursive: true, force: true });
  writeAllowance();
});

describe("run402 ci", () => {
  it("links GitHub Actions by inferring repo and branch and writes a pinned CLI workflow", async () => {
    captureStart();
    await run("link", ["github", "--project", "prj_ci", "--manifest", "run402.deploy.json"]);
    captureStop();

    const create = calls.find((c) => c.url === `${API}/ci/v1/bindings`);
    assert.ok(create, "should create a CI binding");
    assert.ok(create.headers["sign-in-with-x"], "binding create should use local SIWX auth");
    assert.equal(create.body.project_id, "prj_ci");
    assert.equal(create.body.provider, "github-actions");
    assert.equal(create.body.subject_match, "repo:tal/myapp:ref:refs/heads/main");
    assert.deepEqual(create.body.allowed_events, ["push", "workflow_dispatch"]);
    assert.deepEqual(create.body.allowed_actions, ["deploy"]);
    assert.equal(create.body.github_repository_id, "892341");
    assert.match(create.body.nonce, /^[0-9a-f]{32}$/);

    const workflowPath = join(repoDir, ".github/workflows/run402-deploy.yml");
    assert.equal(existsSync(workflowPath), true);
    const workflow = readFileSync(workflowPath, "utf8");
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /branches: \["main"\]/);
    assert.match(workflow, /npx --yes run402@1\.54\.4 deploy apply --manifest 'run402\.deploy\.json' --project 'prj_ci'/);

    const output = JSON.parse(stdout.join("\n"));
    assert.equal(output.status, "ok");
    assert.equal(output.binding_id, "cib_123");
    assert.equal(output.github_repository_id_status, "verified");
    assert.equal(output.delegation_chain_id, "eip155:84532");
    assert.match(output.bootstrap_caveat, /Commit/);
    assert.ok(output.revocation_residuals.length > 0);
  });

  it("uses environment subjects without exposing raw subject flags", async () => {
    captureStart();
    await run("link", [
      "github",
      "--project", "prj_ci",
      "--repo", "tal/myapp",
      "--environment", "production",
      "--repository-id", "892341",
      "--force",
    ]);
    captureStop();

    const create = calls.find((c) => c.url === `${API}/ci/v1/bindings`);
    assert.equal(create.body.subject_match, "repo:tal/myapp:environment:production");
    const workflow = readFileSync(join(repoDir, ".github/workflows/run402-deploy.yml"), "utf8");
    assert.match(workflow, /environment: "production"/);

    captureStart();
    let threw = null;
    try {
      await run("link", ["github", "--project", "prj_ci", "--subject", "repo:tal/myapp:*"]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(JSON.parse(stderr.join("\n")).code, "UNSUPPORTED_CI_FLAG");
  });

  it("fails with repository-id instructions when GitHub lookup is unavailable", async () => {
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:tal/missing.git"], { cwd: repoDir });
    captureStart();
    let threw = null;
    try {
      await run("link", ["github", "--project", "prj_ci"]);
    } catch (err) {
      threw = err;
    } finally {
      execFileSync("git", ["remote", "set-url", "origin", "git@github.com:tal/myapp.git"], { cwd: repoDir });
      captureStop();
    }

    assert.equal(threw?.message, "process.exit(1)");
    const error = JSON.parse(stderr.join("\n"));
    assert.equal(error.code, "GITHUB_REPOSITORY_ID_REQUIRED");
    assert.match(error.hint, /--repository-id/);
    assert.equal(calls.some((c) => c.url === `${API}/ci/v1/bindings`), false);
  });

  it("refuses to overwrite workflow without --force", async () => {
    const workflowPath = join(repoDir, ".github/workflows/run402-deploy.yml");
    mkdirSync(join(repoDir, ".github/workflows"), { recursive: true });
    writeFileSync(workflowPath, "name: existing\n");

    captureStart();
    let threw = null;
    try {
      await run("link", ["github", "--project", "prj_ci", "--repository-id", "892341"]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }

    assert.equal(threw?.message, "process.exit(1)");
    assert.equal(JSON.parse(stderr.join("\n")).code, "WORKFLOW_EXISTS");
    assert.equal(readFileSync(workflowPath, "utf8"), "name: existing\n");
    assert.equal(calls.some((c) => c.url === `${API}/ci/v1/bindings`), false);
  });

  it("lists and revokes bindings", async () => {
    captureStart();
    await run("list", ["--project", "prj_ci"]);
    captureStop();
    const listed = JSON.parse(stdout.join("\n"));
    assert.equal(listed.status, "ok");
    assert.equal(listed.bindings[0].id, "cib_123");

    captureStart();
    await run("revoke", ["cib_123"]);
    captureStop();
    const revoked = JSON.parse(stdout.join("\n"));
    assert.equal(revoked.status, "ok");
    assert.equal(revoked.binding.id, "cib_123");
    assert.ok(revoked.revocation_residuals.length > 0);
  });

  it("preserves structured SDK error envelopes from binding creation", async () => {
    captureStart();
    let threw = null;
    try {
      await run("link", [
        "github",
        "--project", "prj_dup",
        "--repo", "tal/myapp",
        "--repository-id", "892341",
        "--force",
      ]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }

    assert.equal(threw?.message, "process.exit(1)");
    const error = JSON.parse(stderr.join("\n"));
    assert.equal(error.status, "error");
    assert.equal(error.code, "duplicate");
    assert.equal(error.message, "duplicate CI binding");
    assert.equal(error.details.subject_match, "repo:tal/myapp:ref:refs/heads/main");
  });
});
