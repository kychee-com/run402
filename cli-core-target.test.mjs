/**
 * Core target CLI smoke tests.
 *
 * Proves the coding-agent DX:
 *   run402 init --api-base=http://core:4020
 *   run402 projects provision --name my-app
 *   run402 deploy apply --manifest app.json
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CORE = "http://core.local:4020";

let tempDir;
let stdoutLines;
let stderrLines;
let calls;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalConfigDir = process.env.RUN402_CONFIG_DIR;
const originalApiBase = process.env.RUN402_API_BASE;
const originalAllowancePath = process.env.RUN402_ALLOWANCE_PATH;
const originalWallet = process.env.RUN402_WALLET;
const originalProfile = process.env.RUN402_PROFILE;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function mockFetch(input, init) {
  let url;
  let method;
  let rawBody;
  if (typeof input === "string") {
    url = input;
    method = (init?.method || "GET").toUpperCase();
    rawBody = init?.body;
  } else if (input instanceof Request) {
    url = input.url;
    method = (init?.method || input.method || "GET").toUpperCase();
    rawBody = init?.body !== undefined ? init.body : await input.clone().text().catch(() => undefined);
  } else {
    url = String(input);
    method = (init?.method || "GET").toUpperCase();
    rawBody = init?.body;
  }
  const parsed = new URL(url);
  let body = null;
  if (rawBody && typeof rawBody === "string") {
    try { body = JSON.parse(rawBody); } catch { body = rawBody; }
  }
  calls.push({ url, method, path: parsed.pathname, body, headers: init?.headers ?? {} });

  assert.equal(parsed.origin, CORE, `unexpected non-Core call: ${url}`);

  if (parsed.pathname === "/health" && method === "GET") {
    return json({
      status: "ok",
      mode: "core",
      runtime_contract_version: "test",
      supported_features: 1,
      unsupported_features: 0,
    });
  }

  if (parsed.pathname === "/projects/v1" && method === "POST") {
    return json({
      project_id: "prj_core_test",
      anon_key: "r402_anon_test",
      service_key: "r402_service_test",
      schema_slot: "project_core_test",
      endpoints: {
        rest_url: `${CORE}/rest/v1`,
        static_base_url: `${CORE}/projects/v1/prj_core_test/static`,
        storage_base_url: `${CORE}/projects/v1/prj_core_test/storage`,
      },
      active_release_id: null,
    }, 201);
  }

  if (parsed.pathname === "/apply/v1/plans" && method === "POST") {
    return json({
      plan_id: "plan_core_test",
      operation_id: null,
      base_release_id: null,
      manifest_digest: "abc123",
    });
  }

  if (parsed.pathname === "/projects/v1/prj_core_test/content" && method === "POST") {
    return json({
      staged: true,
      sha256: body.sha256,
      size_bytes: body.size,
      content_type: body.content_type,
    }, 201);
  }

  if (parsed.pathname === "/apply/v1/plans/plan_core_test/commit" && method === "POST") {
    return json({
      plan_id: "plan_core_test",
      project_id: "prj_core_test",
      release_id: "rel_core_test",
      release_digest: "sha256:core",
      status: "committed",
    });
  }

  if (parsed.pathname === "/projects/v1/prj_core_test" && method === "GET") {
    return json({
      project_id: "prj_core_test",
      endpoints: {
        rest_url: `${CORE}/rest/v1`,
        static_base_url: `${CORE}/projects/v1/prj_core_test/static`,
        storage_base_url: `${CORE}/projects/v1/prj_core_test/storage`,
      },
    });
  }

  return json({ error: "not_found", path: parsed.pathname }, 404);
}

function captureStart() {
  stdoutLines = [];
  stderrLines = [];
  console.log = (...args) => {
    stdoutLines.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
  };
  console.error = (...args) => {
    stderrLines.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
  };
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

function stdoutJson() {
  const text = stdoutLines.join("\n");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-core-target-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  delete process.env.RUN402_API_BASE;
  delete process.env.RUN402_ALLOWANCE_PATH;
  delete process.env.RUN402_WALLET;
  delete process.env.RUN402_PROFILE;
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  calls = [];
  captureStart();
});

afterEach(() => {
  captureStop();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  if (originalConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = originalConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  if (originalApiBase !== undefined) process.env.RUN402_API_BASE = originalApiBase;
  else delete process.env.RUN402_API_BASE;
  if (originalAllowancePath !== undefined) process.env.RUN402_ALLOWANCE_PATH = originalAllowancePath;
  else delete process.env.RUN402_ALLOWANCE_PATH;
  if (originalWallet !== undefined) process.env.RUN402_WALLET = originalWallet;
  else delete process.env.RUN402_WALLET;
  if (originalProfile !== undefined) process.env.RUN402_PROFILE = originalProfile;
  else delete process.env.RUN402_PROFILE;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("CLI Core target", () => {
  it("initializes, provisions, and applies to Core without Cloud allowance setup", async () => {
    const { run: runInit } = await import("./cli/lib/init.mjs");
    await runInit(["--api-base", CORE]);
    let parsed = stdoutJson();
    assert.equal(parsed.api_base, CORE);
    assert.equal(parsed.target.kind, "core");
    assert.equal(parsed.payment_required, false);
    assert.equal(existsSync(join(tempDir, "allowance.json")), false);

    const { run: runProjects } = await import("./cli/lib/projects.mjs");
    captureStart();
    await runProjects("provision", ["--name", "my-app"]);
    parsed = stdoutJson();
    assert.equal(parsed.project_id, "prj_core_test");
    assert.equal(parsed.anon_key, "r402_anon_test");
    assert.equal(parsed.service_key, "r402_service_test");
    assert.equal(existsSync(join(tempDir, "allowance.json")), false);

    const manifestPath = join(tempDir, "app.json");
    writeFileSync(manifestPath, JSON.stringify({
      site: { replace: { "index.html": { data: "<h1>Hello Core</h1>" } } },
    }));

    const { runDeployV2 } = await import("./cli/lib/deploy-v2.mjs");
    captureStart();
    await runDeployV2("apply", ["--manifest", manifestPath, "--quiet"]);
    parsed = stdoutJson();
    assert.equal(parsed.release_id, "rel_core_test");

    const projectCreate = calls.find((call) => call.path === "/projects/v1" && call.method === "POST");
    assert.deepEqual(projectCreate.body, { tier: "prototype", name: "my-app" });

    const plan = calls.find((call) => call.path === "/apply/v1/plans" && call.method === "POST");
    assert.equal(plan.body.spec.project_id, "prj_core_test");
    assert.ok(calls.every((call) => call.url.startsWith(CORE)), "all API calls should target Core");
  });

  it("keeps generated Astro SSR bundles out of the auth source scan", async () => {
    const apiPath = join(tempDir, "api.js");
    const ssrPath = join(tempDir, "ssr.js");
    writeFileSync(apiPath, "export default async () => new Response('ok');");
    writeFileSync(ssrPath, "const staleTrainingData = getSession();");

    const { collectManifestSourceFiles } = await import("./cli/lib/deploy-v2.mjs");
    const files = collectManifestSourceFiles({
      functions: {
        replace: {
          api: {
            runtime: "node22",
            source: { path: "api.js" },
          },
          ssr: {
            runtime: "node22",
            source: { path: "ssr.js" },
            class: "ssr",
            capabilities: ["astro.ssr.v1"],
          },
        },
      },
    }, tempDir);

    assert.deepEqual(files, [apiPath]);
  });
});
