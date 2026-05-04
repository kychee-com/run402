/**
 * Focused tests for `run402 deploy apply` under GitHub Actions OIDC.
 *
 * These run through the real CLI module so we prove the command does not need
 * a local allowance file when CI credentials are available.
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-deploy-ci-"));
const API = "https://test-api.run402.com";
const OIDC_URL = "https://actions.example.test/oidc";

process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;

const originalEnv = {
  GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
  ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  RUN402_PROJECT_ID: process.env.RUN402_PROJECT_ID,
};
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

let calls = [];
let stdout = [];
let stderr = [];
let runDeployV2;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseBody(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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

  if (url.startsWith(OIDC_URL)) {
    return Promise.resolve(json({ value: "github-oidc-jwt" }));
  }
  if (url === `${API}/ci/v1/token-exchange` && method === "POST") {
    return Promise.resolve(json({
      access_token: "run402-ci-session",
      token_type: "Bearer",
      expires_in: 300,
    }));
  }
  if (url === `${API}/deploy/v2/plans` && method === "POST") {
    return Promise.resolve(json({
      plan_id: "plan_ci_test",
      operation_id: "op_ci_test",
      base_release_id: null,
      manifest_digest: "abc123",
      missing_content: [],
      diff: { resources: { site: { changed: true } } },
    }));
  }
  if (url === `${API}/deploy/v2/plans/plan_ci_test/commit` && method === "POST") {
    return Promise.resolve(json({
      operation_id: "op_ci_test",
      status: "ready",
      release_id: "rel_ci_test",
      urls: { site: "https://ci.example.test" },
    }));
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

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

before(async () => {
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  ({ runDeployV2 } = await import("./cli/lib/deploy-v2.mjs"));
});

after(() => {
  captureStop();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  restoreEnv();
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  captureStop();
  restoreEnv();
});

describe("deploy apply GitHub Actions OIDC", () => {
  it("uses OIDC credentials, sends no local keys, and does not require allowance", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = OIDC_URL;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "github-request-token";
    process.env.RUN402_PROJECT_ID = "prj_ci_env";

    captureStart();
    await runDeployV2("apply", [
      "--spec",
      JSON.stringify({ site: { replace: { "index.html": { data: "hello" } } } }),
      "--quiet",
    ]);
    captureStop();

    const oidc = calls.find((c) => c.url.startsWith(OIDC_URL));
    assert.ok(oidc, "should request a GitHub OIDC token");
    assert.equal(oidc.headers.authorization, "Bearer github-request-token");
    assert.match(oidc.url, /audience=https%3A%2F%2Fapi\.run402\.com/);

    const exchange = calls.find((c) => c.url === `${API}/ci/v1/token-exchange`);
    assert.ok(exchange, "should exchange the GitHub JWT with Run402");
    assert.equal(exchange.headers.authorization, undefined, "token exchange must be unauthenticated");
    assert.equal(exchange.body.project_id, "prj_ci_env");
    assert.equal(exchange.body.subject_token, "github-oidc-jwt");

    const plan = calls.find((c) => c.url === `${API}/deploy/v2/plans`);
    assert.ok(plan, "should plan the deploy");
    assert.equal(plan.headers.authorization, "Bearer run402-ci-session");
    assert.equal(plan.headers.apikey, undefined);
    assert.equal(plan.body.spec.project, "prj_ci_env");

    const parsedStdout = JSON.parse(stdout.join("\n"));
    assert.equal(parsedStdout.status, "ok");
    assert.equal(parsedStdout.release_id, "rel_ci_test");
  });

  it("keeps local deploy allowance preflight outside GitHub Actions", async () => {
    captureStart();
    let threw = null;
    try {
      await runDeployV2("apply", [
        "--spec",
        JSON.stringify({
          project_id: "prj_local",
          site: { replace: { "index.html": { data: "hello" } } },
        }),
        "--quiet",
      ]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }

    assert.equal(threw?.message, "process.exit(1)");
    const parsedStderr = JSON.parse(stderr.join("\n"));
    assert.equal(parsedStderr.code, "NO_ALLOWANCE");
    assert.equal(calls.some((c) => c.url === `${API}/ci/v1/token-exchange`), false);
    assert.equal(calls.some((c) => c.url === `${API}/deploy/v2/plans`), false);
  });

  it("adds actionable guidance for common CI deploy errors", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = OIDC_URL;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "github-request-token";

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url === `${API}/deploy/v2/plans`) {
        return Promise.resolve(json({
          code: "repository_id_mismatch",
          message: "repository id mismatch",
        }, 403));
      }
      return mockFetch(input, init);
    };

    captureStart();
    let threw = null;
    try {
      await runDeployV2("apply", [
        "--spec",
        JSON.stringify({
          project_id: "prj_ci_manifest",
          site: { replace: { "index.html": { data: "hello" } } },
        }),
        "--quiet",
      ]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
      globalThis.fetch = previousFetch;
    }

    assert.equal(threw?.message, "process.exit(1)");
    const parsedStderr = JSON.parse(stderr.join("\n"));
    assert.equal(parsedStderr.code, "repository_id_mismatch");
    assert.match(parsedStderr.hint, /repository id/i);
    assert.ok(Array.isArray(parsedStderr.next_actions));
    assert.ok(parsedStderr.next_actions.length > 0);
  });
});
