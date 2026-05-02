/**
 * cli-e2e.test.mjs — End-to-end happy path test for ALL CLI commands.
 *
 * Mocks all network calls (API + viem RPC), tests every command sequentially.
 * Run:  node --test cli-e2e.test.mjs
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Test state ──────────────────────────────────────────────────────────────
// Set env vars BEFORE any CLI modules are imported (they read at load time)
const tempDir = mkdtempSync(join(tmpdir(), "run402-e2e-"));
const API = "https://test-api.run402.com";
process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
let output = [];
let stdoutLines = [];
let stderrLines = [];

// Known test project returned by provision/deploy
const TEST_PROJECT = {
  project_id: "prj_test123",
  anon_key: "anon_test_key",
  service_key: "svc_test_key",
  schema_slot: "p0001",
};

// ─── Mock fetch router ──────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function noContent() {
  return new Response(null, { status: 204 });
}

// USDC balance as ABI-encoded uint256 (250000 = 0.25 USDC)
const USDC_BALANCE_HEX = "0x" + "0".repeat(58) + "03d090";
// pathUSD balance as ABI-encoded uint256 (1000000 = 1.00 pathUSD)
const PATHUSD_BALANCE_HEX = "0x" + "0".repeat(59) + "f4240";
const TEMPO_RPC_URL = "https://rpc.moderato.tempo.xyz/";
let rpcCallCount = 0;
let tempoRpcCallCount = 0;

function mockFetch(input, init) {
  // Handle Request objects (x402 library may pass these)
  let url, method, rawBody;
  if (typeof input === "string") {
    url = input;
    method = (init?.method || "GET").toUpperCase();
    rawBody = init?.body;
  } else if (input instanceof Request) {
    url = input.url;
    method = (init?.method || input.method || "GET").toUpperCase();
    rawBody = init?.body !== undefined ? init.body : undefined;
  } else {
    url = String(input);
    method = (init?.method || "GET").toUpperCase();
    rawBody = init?.body;
  }
  let body = null;
  if (rawBody && typeof rawBody === "string") {
    try { body = JSON.parse(rawBody); } catch { body = rawBody; }
  } else if (rawBody) {
    body = rawBody;
  }

  // ── Tempo Moderato RPC (pathUSD balance, faucet) ──
  if (url === TEMPO_RPC_URL && body?.jsonrpc === "2.0") {
    tempoRpcCallCount++;
    if (body.method === "tempo_fundAddress") {
      return Promise.resolve(json({ jsonrpc: "2.0", result: ["0xtx1", "0xtx2", "0xtx3", "0xtx4"], id: body.id }));
    }
    if (body.method === "eth_call") {
      // Return 0 for first call (before faucet), positive for subsequent
      const balance = tempoRpcCallCount <= 1 ? "0x0" : PATHUSD_BALANCE_HEX;
      return Promise.resolve(json({ jsonrpc: "2.0", result: balance, id: body.id }));
    }
    if (body.method === "eth_chainId") {
      return Promise.resolve(json({ jsonrpc: "2.0", result: "0xa5bf", id: body.id }));
    }
    if (Array.isArray(body)) {
      const results = body.map(req => {
        if (req.method === "eth_call") return { jsonrpc: "2.0", result: PATHUSD_BALANCE_HEX, id: req.id };
        if (req.method === "eth_chainId") return { jsonrpc: "2.0", result: "0xa5bf", id: req.id };
        return { jsonrpc: "2.0", result: "0x0", id: req.id };
      });
      return Promise.resolve(json(results));
    }
    return Promise.resolve(json({ jsonrpc: "2.0", result: "0x0", id: body.id }));
  }

  // ── Viem JSON-RPC calls (eth_call for USDC balance, eth_chainId, etc.) ──
  if (body?.jsonrpc === "2.0") {
    rpcCallCount++;
    if (body.method === "eth_call") {
      // Return 0 for first call (before faucet), positive for subsequent (after faucet)
      const balance = rpcCallCount <= 1 ? "0x0" : USDC_BALANCE_HEX;
      return Promise.resolve(json({ jsonrpc: "2.0", result: balance, id: body.id }));
    }
    if (body.method === "eth_chainId") {
      return Promise.resolve(json({ jsonrpc: "2.0", result: "0x14a34", id: body.id }));
    }
    // Batch requests
    if (Array.isArray(body)) {
      const results = body.map(req => {
        if (req.method === "eth_call") return { jsonrpc: "2.0", result: USDC_BALANCE_HEX, id: req.id };
        if (req.method === "eth_chainId") return { jsonrpc: "2.0", result: "0x14a34", id: req.id };
        return { jsonrpc: "2.0", result: "0x0", id: req.id };
      });
      return Promise.resolve(json(results));
    }
    return Promise.resolve(json({ jsonrpc: "2.0", result: "0x0", id: body.id }));
  }

  // ── Run402 API calls ───────────────────────────────────────────────────
  // Strip API base — handle both test and hardcoded URLs
  let path = url;
  if (url.startsWith(API)) path = url.slice(API.length);
  else if (url.startsWith("https://api.run402.com")) path = url.slice("https://api.run402.com".length);
  else if (!url.startsWith("/")) {
    // Non-API URL (e.g. RPC endpoint with non-JSON body) — return empty
    return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  // Strip query string for route matching
  const pathNoQuery = path.split("?")[0];

  // Faucet — wire shape: snake_case + amount in micros (SDK normalizes).
  if (path === "/faucet/v1" && method === "POST") {
    return Promise.resolve(json({ transaction_hash: "0xabc123", amount_usd_micros: 250000, token: "USDC", network: "base-sepolia" }));
  }

  // Tiers
  if (path === "/tiers/v1" && method === "GET") {
    return Promise.resolve(json({ tiers: [
      { name: "prototype", price_usd_micros: 100000, lease_days: 7 },
      { name: "hobby", price_usd_micros: 5000000, lease_days: 30 },
      { name: "team", price_usd_micros: 20000000, lease_days: 30 },
    ]}));
  }
  if (path === "/tiers/v1/status" && method === "GET") {
    return Promise.resolve(json({ tier: "prototype", status: "active", lease_expires_at: "2026-03-22T00:00:00.000Z" }));
  }
  if (path.match(/^\/wallets\/v1\/[^/]+\/projects$/) && method === "GET") {
    return Promise.resolve(json({ wallet: "0xtest", projects: [{ id: "prj_test123", name: "test", tier: "prototype", status: "active", lease_expires_at: "2026-03-22T00:00:00.000Z" }] }));
  }
  // x402 discovery GET before paid POST
  if (path.startsWith("/tiers/v1/") && path !== "/tiers/v1/status" && method === "GET") {
    return Promise.resolve(json({ price: "$0.10", network: "base-sepolia" }));
  }
  if (path === "/generate-image/v1" && method === "GET") {
    return Promise.resolve(json({ price: "$0.03", network: "base-sepolia" }));
  }
  if (path.startsWith("/tiers/v1/") && method === "POST") {
    const tier = path.split("/").pop();
    return Promise.resolve(json({
      wallet: "0xtest", action: "subscribe", tier,
      previous_tier: null, lease_started_at: "2026-03-15T00:00:00.000Z",
      lease_expires_at: "2026-03-22T00:00:00.000Z", allowance_remaining_usd_micros: 0,
    }));
  }

  // Projects
  if (path === "/projects/v1" && method === "POST") {
    return Promise.resolve(json(TEST_PROJECT));
  }
  if (path.match(/^\/projects\/v1\/[^/]+$/) && method === "DELETE") {
    return Promise.resolve(noContent());
  }

  // SQL
  if (path.match(/\/sql$/) && method === "POST") {
    return Promise.resolve(json({ status: "ok", rows: [{ id: 1, name: "test" }], rowCount: 1 }));
  }

  // Schema
  if (path.match(/\/schema$/) && method === "GET") {
    return Promise.resolve(json({ tables: [{ name: "items", columns: [{ name: "id", type: "integer" }] }] }));
  }

  // Usage
  if (path.match(/\/usage$/) && method === "GET") {
    return Promise.resolve(json({ api_calls: 42, limit: 500000, storage_bytes: 1024, storage_limit: 262144000 }));
  }

  // REST
  if (path.startsWith("/rest/v1/")) {
    return Promise.resolve(json([{ id: 1, title: "Test item", done: false }]));
  }

  // Functions
  if (path.match(/\/functions$/) && method === "POST") {
    return Promise.resolve(json({ name: "hello", url: `${API}/functions/v1/hello`, runtime: "node22", status: "deployed" }, 201));
  }
  if (path.match(/\/functions$/) && method === "GET") {
    return Promise.resolve(json([{ name: "hello", url: `${API}/functions/v1/hello`, runtime: "node22" }]));
  }
  if (path.match(/\/functions\/[^/]+$/) && method === "DELETE") {
    return Promise.resolve(json({ status: "ok" }));
  }
  if (pathNoQuery.match(/\/logs$/) && method === "GET") {
    return Promise.resolve(json({ logs: [{ timestamp: "2026-03-15T12:00:00Z", message: "hello world" }] }));
  }
  if (path.startsWith("/functions/v1/") && method === "POST") {
    return Promise.resolve(json({ hello: "world" }));
  }

  // Secrets
  if (path.match(/\/secrets$/) && method === "POST") {
    return Promise.resolve(json({ status: "ok", key: body?.key || "TEST_KEY" }));
  }
  if (path.match(/\/secrets$/) && method === "GET") {
    return Promise.resolve(json({ secrets: [{ key: "TEST_KEY", value_hash: "a1b2c3d4", created_at: "2026-01-01", updated_at: "2026-01-01" }] }));
  }
  if (path.match(/\/secrets\/[^/]+$/) && method === "DELETE") {
    return Promise.resolve(json({ status: "ok" }));
  }

  // Storage
  if (path.match(/\/storage\/v1\/object\/list\//) && method === "GET") {
    return Promise.resolve(json([{ name: "readme.txt", size: 13, last_modified: "2026-03-15T12:00:00Z" }]));
  }
  if (path.match(/\/storage\/v1\/object\//) && method === "POST") {
    return Promise.resolve(json({ key: "assets/readme.txt", size: 13 }));
  }
  if (path.match(/\/storage\/v1\/object\//) && method === "GET") {
    return Promise.resolve(new Response("Hello, world!", { status: 200, headers: { "Content-Type": "text/plain" } }));
  }
  if (path.match(/\/storage\/v1\/object\//) && method === "DELETE") {
    return Promise.resolve(json({ status: "ok" }));
  }

  // Blob (direct-to-S3)
  if (pathNoQuery === "/storage/v1/blobs" && method === "GET") {
    return Promise.resolve(json({ blobs: [{ key: "defaults/file.txt", size: 13, last_modified: "2026-03-15T12:00:00Z" }] }));
  }

  // Deploy v2 — unified plan/commit. All deploy paths (CLI `deploy`, `sites
  // deploy`, `sites deploy-dir`, MCP `bundle_deploy`/`deploy_site*`) route
  // through r.deploy.apply against these endpoints.
  // The fake gateway reports every content ref as already-present (empty
  // missing_content) so the SDK skips S3 PUTs and goes straight to commit.
  if (path === "/deploy/v2/plans" && method === "POST") {
    return Promise.resolve(json({
      plan_id: "plan_v2_test",
      operation_id: "op_v2_test",
      base_release_id: null,
      manifest_digest: "deadbeef".repeat(8),
      missing_content: [],
      diff: { resources: { site: { unchanged: true } } },
    }));
  }
  if (path.match(/^\/deploy\/v2\/plans\/[^/]+\/commit$/) && method === "POST") {
    return Promise.resolve(json({
      operation_id: "op_v2_test",
      status: "ready",
      release_id: "rel_v2_test",
      urls: {
        site: "https://dpl_test456.sites.run402.com",
        deployment_id: "dpl_test456",
      },
    }));
  }
  if (path.match(/^\/deploy\/v2\/operations\/[^/]+$/) && method === "GET") {
    return Promise.resolve(json({
      operation_id: "op_v2_test",
      project_id: TEST_PROJECT.project_id,
      plan_id: "plan_v2_test",
      status: "ready",
      base_release_id: null,
      target_release_id: "rel_v2_test",
      release_id: "rel_v2_test",
      urls: {
        site: "https://dpl_test456.sites.run402.com",
        deployment_id: "dpl_test456",
      },
      payment_required: null,
      error: null,
      activate_attempts: 0,
      last_activate_attempt_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
  }

  // Subdomains
  if (path === "/subdomains/v1" && method === "POST") {
    return Promise.resolve(json({ name: "my-app", url: "https://my-app.run402.com", deployment_id: "dpl_test456" }, 201));
  }
  if (path === "/subdomains/v1" && method === "GET") {
    // Wire shape: gateway responds `{ subdomains: [...] }`; SDK unwraps.
    return Promise.resolve(json({ subdomains: [{ name: "my-app", url: "https://my-app.run402.com", deployment_id: "dpl_test456", deployment_url: "https://dpl_test456.run402.com" }] }));
  }
  if (path.match(/^\/subdomains\/v1\//) && method === "DELETE") {
    return Promise.resolve(json({ status: "ok" }));
  }

  // Domains
  if (path.match(/^\/domains\/v1\//) && method === "DELETE") {
    return Promise.resolve(noContent());
  }

  // Apps
  if (path === "/apps/v1" && method === "GET") {
    return Promise.resolve(json([{ version_id: "ver_abc", name: "demo-app", description: "A demo", tags: ["demo"] }]));
  }
  if (path.match(/^\/apps\/v1\//) && method === "GET") {
    return Promise.resolve(json({
      version_id: "ver_abc", name: "demo-app", description: "A demo",
      required_secrets: [], fork_allowed: true, visibility: "public",
    }));
  }
  if (path.match(/\/publish$/) && method === "POST") {
    return Promise.resolve(json({ version_id: "ver_pub1", visibility: "public", fork_allowed: true }));
  }
  if (path.match(/\/versions$/) && method === "GET") {
    return Promise.resolve(json([{ version_id: "ver_pub1", created_at: "2026-03-15T12:00:00Z" }]));
  }
  if (path.match(/\/versions\//) && method === "PATCH") {
    return Promise.resolve(json({ version_id: "ver_pub1", description: "Updated" }));
  }
  if (path.match(/\/versions\//) && method === "DELETE") {
    return Promise.resolve(json({ status: "ok" }));
  }
  if (path === "/fork/v1" && method === "POST") {
    return Promise.resolve(json({
      ...TEST_PROJECT, project_id: "prj_forked",
      site_url: "https://forked.sites.run402.com",
    }));
  }

  // Billing
  if (path.match(/^\/billing\/v1\/accounts\/[^/]+$/) && method === "GET") {
    return Promise.resolve(json({ available_usd_micros: 150000, held_usd_micros: 0 }));
  }
  if (path.match(/\/history/) && method === "GET") {
    return Promise.resolve(json({ transactions: [{ id: "tx1", amount: -100000, description: "Tier subscription" }] }));
  }
  if (path === "/billing/v1/checkouts" && method === "POST") {
    return Promise.resolve(json({ checkout_url: "https://checkout.stripe.com/test", topup_id: "top_123" }));
  }

  // Image
  if (path === "/generate-image/v1" && method === "POST") {
    return Promise.resolve(json({ image: "iVBORw0KGgo=", content_type: "image/png", aspect: "square" }));
  }

  // Message
  if (path === "/message/v1" && method === "POST") {
    return Promise.resolve(json({ status: "ok", delivered: true }));
  }

  // Service status (public, unauthenticated)
  if (path === "/status" && method === "GET") {
    return Promise.resolve(json({
      schema_version: "run402-status-v1",
      service: "Run402",
      current_status: "operational",
      operator: { legal_name: "Kychee LLC" },
      availability: {
        last_24h: { uptime_pct: 100 },
        last_7d: { uptime_pct: 99.99 },
        last_30d: { uptime_pct: 99.95 },
      },
      capabilities: { database_api: "operational" },
      links: { health: "https://api.run402.com/health" },
    }));
  }
  if (path === "/health" && method === "GET") {
    return Promise.resolve(json({
      status: "healthy",
      checks: { postgres: "ok", postgrest: "ok", s3: "ok", cloudfront: "ok" },
      version: "1.0.4",
    }));
  }

  // Agent contact
  if (path === "/agent/v1/contact" && method === "POST") {
    return Promise.resolve(json({
      wallet: "0xtest", name: body?.name || "test-agent",
      email: body?.email || null, webhook: body?.webhook || null,
      updated_at: "2026-03-15T12:00:00Z",
    }));
  }

  originalError(`[MOCK] Unhandled: ${method} ${path} (${url})`);
  return Promise.resolve(new Response("Not Found", { status: 404 }));
}

// ─── Console capture helpers ─────────────────────────────────────────────────

function captureStart() {
  output = [];
  stdoutLines = [];
  stderrLines = [];
  console.log = (...args) => {
    const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    output.push(line);
    stdoutLines.push(line);
  };
  console.error = (...args) => {
    const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    output.push(line);
    stderrLines.push(line);
  };
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

function captured() {
  return output.join("\n");
}

function capturedStdout() {
  return stdoutLines.join("\n");
}

function capturedStderr() {
  return stderrLines.join("\n");
}

// ─── Setup & teardown ────────────────────────────────────────────────────────

before(async () => {
  globalThis.fetch = mockFetch;
  // Override process.exit to throw
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
});

after(async () => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  captureStop();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CLI SDK error reporting", () => {
  async function reportAndParse(err) {
    const { reportSdkError } = await import("./cli/lib/sdk-errors.mjs");
    let threw = null;
    captureStart();
    try {
      reportSdkError(err);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)");
    const line = capturedStderr().split("\n").find((s) => s.trim().startsWith("{"));
    assert.ok(line, `expected JSON stderr, got: ${capturedStderr()}`);
    return JSON.parse(line);
  }

  it("forwards canonical gateway fields while preserving CLI status sentinel", async () => {
    const parsed = await reportAndParse({
      name: "Unauthorized",
      message: "Project is frozen. while setting tier (HTTP 403)",
      status: 403,
      body: {
        status: "degraded",
        error: "frozen",
        message: "Project is frozen.",
        code: "PROJECT_FROZEN",
        category: "lifecycle",
        retryable: false,
        safe_to_retry: true,
        mutation_state: "none",
        trace_id: "trc_cli",
        details: { project_id: "prj_1" },
        next_actions: [{ action: "renew_tier" }],
        hint: "Renew the project tier",
        retry_after_seconds: 30,
        admin_required: true,
      },
    });

    assert.equal(parsed.status, "error");
    assert.equal(parsed.http, 403);
    assert.equal(parsed.message, "Project is frozen.");
    assert.equal(parsed.code, "PROJECT_FROZEN");
    assert.equal(parsed.category, "lifecycle");
    assert.equal(parsed.retryable, false);
    assert.equal(parsed.safe_to_retry, true);
    assert.equal(parsed.mutation_state, "none");
    assert.equal(parsed.trace_id, "trc_cli");
    assert.deepEqual(parsed.details, { project_id: "prj_1" });
    assert.deepEqual(parsed.next_actions, [{ action: "renew_tier" }]);
    assert.equal(parsed.hint, "Renew the project tier");
    assert.equal(parsed.retry_after_seconds, 30);
    assert.equal(parsed.admin_required, true);
  });

  it("emits structured JSON for status-null deploy errors", async () => {
    const parsed = await reportAndParse({
      name: "Run402DeployError",
      message: "Migration failed.",
      status: null,
      body: null,
      code: "MIGRATION_FAILED",
      phase: "migrate",
      resource: "database.migrations.001_init",
      retryable: false,
      safeToRetry: true,
      mutationState: "rolled_back",
      traceId: "trc_dep_cli",
      details: { statement_offset: 184 },
      nextActions: [{ action: "edit_migration" }],
      operationId: "op_1",
      planId: "plan_1",
      fix: { action: "edit_request", path: "database.migrations.001_init" },
      logs: ["ERROR at offset 184"],
      rolledBack: true,
    });

    assert.equal(parsed.status, "error");
    assert.equal(parsed.message, "Migration failed.");
    assert.equal(parsed.code, "MIGRATION_FAILED");
    assert.equal(parsed.phase, "migrate");
    assert.equal(parsed.resource, "database.migrations.001_init");
    assert.equal(parsed.retryable, false);
    assert.equal(parsed.safe_to_retry, true);
    assert.equal(parsed.mutation_state, "rolled_back");
    assert.equal(parsed.trace_id, "trc_dep_cli");
    assert.deepEqual(parsed.details, { statement_offset: 184 });
    assert.deepEqual(parsed.next_actions, [{ action: "edit_migration" }]);
    assert.equal(parsed.operation_id, "op_1");
    assert.equal(parsed.plan_id, "plan_1");
    assert.deepEqual(parsed.fix, { action: "edit_request", path: "database.migrations.001_init" });
    assert.deepEqual(parsed.logs, ["ERROR at offset 184"]);
    assert.equal(parsed.rolled_back, true);
  });

  it("keeps non-JSON body_preview behavior", async () => {
    const parsed = await reportAndParse({
      name: "ApiError",
      message: "API error while provisioning (HTTP 502)",
      status: 502,
      body: "<html><body>502 Bad Gateway</body></html>",
    });

    assert.equal(parsed.status, "error");
    assert.equal(parsed.http, 502);
    assert.ok(parsed.body_preview.includes("502 Bad Gateway"));
    assert.ok(parsed.body_preview.length <= 500);
  });
});

describe("CLI e2e happy path", () => {

  // ── Allowance ───────────────────────────────────────────────────────────

  it("allowance create", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("create", []);
    captureStop();
    assert.ok(captured().includes("ok"), "should output ok status");
    assert.ok(existsSync(join(tempDir, "allowance.json")), "allowance.json should exist");
  });

  it("allowance status", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("status", []);
    captureStop();
    assert.ok(captured().includes("ok"), "should show ok status");
  });

  it("allowance fund", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("fund", []);
    captureStop();
    // Fund polls for balance — mock returns positive immediately
    assert.ok(captured().includes("base-sepolia"), "should show balance or faucet result");
  });

  it("allowance export", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("export", []);
    captureStop();
    assert.ok(captured().includes("0x"), "should print allowance address");
  });

  it("allowance balance", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("balance", []);
    captureStop();
    assert.ok(captured().includes("base-sepolia_usd_micros"), "should show balance");
  });

  it("allowance checkout", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("checkout", ["--amount", "5000000"]);
    captureStop();
    assert.ok(captured().includes("checkout_url"), "should return checkout URL");
  });

  it("allowance history", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("history", ["--limit", "5"]);
    captureStop();
    assert.ok(captured().includes("transactions"), "should show transactions");
  });

  // ── Tier ────────────────────────────────────────────────────────────────

  it("tier status", async () => {
    const { run } = await import("./cli/lib/tier.mjs");
    captureStart();
    await run("status", []);
    captureStop();
    assert.ok(captured().includes("prototype"), "should show current tier");
  });

  it("tier set", async () => {
    const { run } = await import("./cli/lib/tier.mjs");
    captureStart();
    await run("set", ["prototype"]);
    captureStop();
    assert.ok(captured().includes("subscribe"), "should show action");
  });

  // GH-110: help text must reflect actual prototype pricing ($0.10/7d), not "free/testnet"
  it("tier --help shows prototype as $0.10/7d (GH-110)", async () => {
    const { run } = await import("./cli/lib/tier.mjs");
    let threw = null;
    captureStart();
    try {
      await run("--help", []);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(0)", "tier --help should exit 0");
    const out = capturedStdout();
    assert.ok(
      !/free\/testnet/i.test(out),
      `tier --help must not advertise prototype as 'free/testnet' — server charges $0.10. Got: ${out}`,
    );
    assert.ok(
      /\$0\.10\/7d/.test(out),
      `tier --help must describe prototype as '$0.10/7d' to match server pricing. Got: ${out}`,
    );
  });

  it("tier status surfaces HTML gateway errors without SyntaxError (GH-83)", async () => {
    const { run } = await import("./cli/lib/tier.mjs");
    // Swap in a fetch that returns a 502 HTML gateway error on /tiers/v1/status.
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (/\/tiers\/v1\/status$/.test(url) && method === "GET") {
        return Promise.resolve(new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }));
      }
      return prevFetch(input, init);
    };
    let threw = null;
    captureStart();
    try {
      await run("status", []);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const out = captured();
    // process.exit stub throws, so we expect a non-zero exit.
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message), `should exit non-zero, got: ${threw && threw.message}`);
    // Output must NOT contain the raw SyntaxError / tokeniser complaint.
    assert.ok(!/SyntaxError/i.test(out), `must not leak SyntaxError, got: ${out}`);
    assert.ok(!/Unexpected token/i.test(out), `must not leak JSON parser message, got: ${out}`);
    // Output must be a single JSON line with structured fields.
    const line = out.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line, got: ${out}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.http, 502);
  });

  // ── Projects ────────────────────────────────────────────────────────────

  it("projects quote", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("quote", []);
    captureStop();
    assert.ok(captured().includes("tiers"), "should show tier pricing");
  });

  it("projects provision", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("provision", ["--tier", "prototype"]);
    captureStop();
    assert.ok(captured().includes("prj_test123"), "should return project_id");
    // Verify project saved locally (unified object-based keystore format)
    const store = JSON.parse(readFileSync(join(tempDir, "projects.json"), "utf-8"));
    assert.ok(store.projects && store.projects["prj_test123"], "project should be saved locally");
  });

  it("projects list", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("list", []);
    captureStop();
    assert.ok(captured().includes("prj_test123"), "should list the provisioned project");
  });

  it("projects sql", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("sql", ["prj_test123", "SELECT * FROM items"]);
    captureStop();
    assert.ok(captured().includes("test"), "should return query results");
  });

  it("projects sql --file", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    const sqlPath = join(tempDir, "query.sql");
    wf(sqlPath, "SELECT * FROM items");
    captureStart();
    await run("sql", ["prj_test123", "--file", sqlPath]);
    captureStop();
    assert.ok(captured().includes("test"), "should return query results from file");
  });

  it("projects sql exits non-zero on blocked SQL (GH-34)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    // Swap in a fetch that returns a 400 with a blocked-SQL error body.
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (/\/sql$/.test(url) && method === "POST") {
        return Promise.resolve(json({ error: "Blocked SQL pattern: \\bCREATE\\s+EXTENSION\\b" }, 400));
      }
      return prevFetch(input, init);
    };
    let threw = null;
    captureStart();
    try {
      await run("sql", ["prj_test123", "CREATE EXTENSION pgcrypto;"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message), `should exit non-zero, got: ${threw && threw.message}`);
    const out = captured();
    const line = out.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line, got: ${out}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.http, 400);
    assert.ok(/Blocked SQL pattern/.test(parsed.error), `error message should be propagated, got: ${parsed.error}`);
  });

  it("projects rest", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("rest", ["prj_test123", "items", "limit=10"]);
    captureStop();
    assert.ok(captured().includes("Test item"), "should return REST data");
  });

  it("projects rest exits non-zero on API error (GH-34)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      if (url.includes("/rest/v1/")) {
        return Promise.resolve(json({ message: "relation does not exist", code: "42P01" }, 404));
      }
      return prevFetch(input, init);
    };
    let threw = null;
    captureStart();
    try {
      await run("rest", ["prj_test123", "nonexistent", "limit=1"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message), `should exit non-zero, got: ${threw && threw.message}`);
    const out = captured();
    const line = out.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line, got: ${out}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.http, 404);
    assert.ok(/relation does not exist/.test(parsed.message), `error message should be propagated, got: ${parsed.message}`);
  });

  it("projects schema", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("schema", ["prj_test123"]);
    captureStop();
    assert.ok(captured().includes("tables"), "should show schema");
  });

  it("projects usage", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("usage", ["prj_test123"]);
    captureStop();
    assert.ok(captured().includes("api_calls"), "should show usage");
  });

  // GH-84: provision must not crash on non-JSON gateway error
  it("projects provision surfaces HTML 502 without SyntaxError (GH-84)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (url.endsWith("/projects/v1") && method === "POST") {
        const html = "<html><head></head><body>502 Bad Gateway</body></html>";
        return Promise.resolve(new Response(html, {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }));
      }
      return prevFetch(input, init);
    };
    let threw = null;
    captureStart();
    try {
      await run("provision", ["--tier", "prototype"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    const out = captured();
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message),
      `should exit non-zero, got: ${threw && threw.message}`);
    assert.ok(!/SyntaxError/i.test(out), `must not leak SyntaxError, got: ${out}`);
    assert.ok(!/Unexpected token/i.test(out), `must not leak JSON parser message, got: ${out}`);
    const stderr = capturedStderr();
    const line = stderr.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line on stderr, got: ${stderr}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.http, 502);
    assert.ok(typeof parsed.body_preview === "string" && parsed.body_preview.length > 0,
      `body_preview should be non-empty, got: ${JSON.stringify(parsed)}`);
    assert.ok(parsed.body_preview.includes("502 Bad Gateway"),
      `body_preview should include the HTML body, got: ${parsed.body_preview}`);
  });

  // GH-102: subcommands default to active project
  // The "projects provision" test above saves prj_test123 to the keystore
  // and sets it as the active project, so these tests can omit the id.

  it("projects info defaults to active project (GH-102)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const { setActiveProjectId } = await import("./cli/lib/config.mjs");
    setActiveProjectId("prj_test123");
    captureStart();
    await run("info", []);
    captureStop();
    const stdout = capturedStdout();
    assert.ok(stdout.includes("prj_test123"),
      `should use active project in info output; got: ${stdout}`);
    assert.ok(!/not found/i.test(stdout),
      `should not complain about missing project; got: ${stdout}`);
    assert.ok(!/undefined/.test(stdout),
      `should not include "undefined"; got: ${stdout}`);
  });

  it("projects keys defaults to active project (GH-102)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const { setActiveProjectId } = await import("./cli/lib/config.mjs");
    setActiveProjectId("prj_test123");
    captureStart();
    await run("keys", []);
    captureStop();
    const stdout = capturedStdout();
    assert.ok(stdout.includes("prj_test123"),
      `should use active project in keys output; got: ${stdout}`);
    assert.ok(stdout.includes("anon_test_key"),
      `should print anon key from active project; got: ${stdout}`);
  });

  it("projects usage defaults to active project (GH-102)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const { setActiveProjectId } = await import("./cli/lib/config.mjs");
    setActiveProjectId("prj_test123");
    let seenUrl = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      if (url.includes("/usage")) seenUrl = url;
      return prevFetch(input, init);
    };
    captureStart();
    try {
      await run("usage", []);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(seenUrl && seenUrl.includes("/projects/v1/admin/prj_test123/usage"),
      `usage should hit the active project URL; got: ${seenUrl}`);
    assert.ok(captured().includes("api_calls"), "should show usage for active project");
  });

  it("projects schema defaults to active project (GH-102)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const { setActiveProjectId } = await import("./cli/lib/config.mjs");
    setActiveProjectId("prj_test123");
    let seenUrl = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      if (url.includes("/schema")) seenUrl = url;
      return prevFetch(input, init);
    };
    captureStart();
    try {
      await run("schema", []);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(seenUrl && seenUrl.includes("/projects/v1/admin/prj_test123/schema"),
      `schema should hit the active project URL; got: ${seenUrl}`);
    assert.ok(captured().includes("tables"), "should show schema for active project");
  });

  it("projects sql \"SELECT 1\" treats query as query, defaults to active (GH-102)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const { setActiveProjectId } = await import("./cli/lib/config.mjs");
    setActiveProjectId("prj_test123");
    let seenUrl = null;
    let seenBody = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (/\/sql$/.test(url) && method === "POST") {
        seenUrl = url;
        const body = init?.body ?? null;
        seenBody = typeof body === "string" ? body : String(body);
      }
      return prevFetch(input, init);
    };
    captureStart();
    try {
      await run("sql", ["SELECT 1"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(seenUrl && seenUrl.includes("/projects/v1/admin/prj_test123/sql"),
      `sql should hit the active project URL; got: ${seenUrl}`);
    assert.ok(seenBody && seenBody.includes("SELECT 1"),
      `request body should contain the SQL query "SELECT 1"; got: ${seenBody}`);
    assert.ok(captured().includes("test"), "should return query results");
  });

  it("projects rest defaults to active project (GH-102)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    const { setActiveProjectId } = await import("./cli/lib/config.mjs");
    setActiveProjectId("prj_test123");
    let seenUrl = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      if (url.includes("/rest/v1/")) seenUrl = url;
      return prevFetch(input, init);
    };
    captureStart();
    try {
      await run("rest", ["items", "limit=10"]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(seenUrl && seenUrl.includes("/rest/v1/items?limit=10"),
      `rest should use positional args as table + querystring; got: ${seenUrl}`);
    assert.ok(captured().includes("Test item"), "should return REST data");
  });

  // ── Deploy ──────────────────────────────────────────────────────────────

  it("deploy", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    // Write a manifest file
    const manifestPath = join(tempDir, "manifest.json");
    const { writeFileSync: wf } = await import("node:fs");
    wf(manifestPath, JSON.stringify({
      files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
    }));
    captureStart();
    await run(["--manifest", manifestPath, "--project", "prj_test123"]);
    captureStop();
    assert.ok(captured().includes("prj_test123"), "should return project info");
  });

  it("deploy with path fields in manifest", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const { writeFileSync: wf, mkdirSync } = await import("node:fs");
    // Create a dist/ subdirectory with files
    const distDir = join(tempDir, "dist");
    mkdirSync(distDir, { recursive: true });
    wf(join(distDir, "index.html"), "<h1>Built</h1>");
    wf(join(distDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // Manifest uses path fields resolved relative to manifest location
    const manifestPath = join(tempDir, "path-manifest.json");
    wf(manifestPath, JSON.stringify({
      files: [
        { file: "index.html", path: "dist/index.html" },
        { file: "logo.png", path: "dist/logo.png" },
      ],
    }));
    captureStart();
    await run(["--manifest", manifestPath, "--project", "prj_test123"]);
    captureStop();
    assert.ok(captured().includes("prj_test123"), "should deploy with resolved paths");
  });

  it("deploy with missing files[].path returns structured JSON error (GH-44)", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    const manifestPath = join(tempDir, "gh44-missing-file-manifest.json");
    const missingName = "definitely-missing-file.html";
    wf(manifestPath, JSON.stringify({
      functions: [{
        name: "partial-file-good-fn",
        code: "export default async () => new Response('ok')",
      }],
      files: [
        { file: "index.html", path: `./${missingName}` },
      ],
    }));
    let threw = null;
    captureStart();
    try {
      await run(["--manifest", manifestPath, "--project", "prj_test123"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
    }
    // Must exit non-zero.
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message),
      `should exit non-zero, got: ${threw && threw.message}`);
    // Must NOT leak a raw Node stack trace.
    const stderr = capturedStderr();
    assert.ok(!/node:fs:\d+/.test(stderr),
      `must not leak raw node:fs stack, got: ${stderr}`);
    assert.ok(!/\bat readFileSync\b/.test(stderr),
      `must not leak raw readFileSync stack frame, got: ${stderr}`);
    assert.ok(!/\bat resolveFilePathsInManifest\b/.test(stderr),
      `must not leak internal resolve fn stack frame, got: ${stderr}`);
    // Must emit a single JSON line on stderr with structured fields.
    const line = stderr.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line on stderr, got: ${stderr}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.ok(parsed.message && parsed.message.includes(missingName),
      `message should mention missing filename, got: ${parsed.message}`);
    assert.equal(parsed.details?.field, "files[0].path",
      `details.field should identify the offending manifest field, got: ${parsed.details?.field}`);
    assert.ok(parsed.details?.path && parsed.details.path.endsWith(missingName),
      `details.path should be the absolute missing path, got: ${parsed.details?.path}`);
    assert.ok(parsed.hint && /relative to the manifest/i.test(parsed.hint),
      `hint should explain relative-path resolution, got: ${parsed.hint}`);
    // No raw `stack` field should be leaked.
    assert.equal(parsed.stack, undefined, "must not leak a stack field");
    // stdout should stay empty (errors go to stderr, not stdout).
    assert.equal(capturedStdout().trim(), "",
      `stdout should stay empty on error, got: ${capturedStdout()}`);
  });

  it("deploy with missing migrations_file returns structured JSON error (GH-44)", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    const manifestPath = join(tempDir, "gh44-missing-migrations-manifest.json");
    const missingName = "does-not-exist.sql";
    wf(manifestPath, JSON.stringify({
      migrations_file: `./${missingName}`,
    }));
    let threw = null;
    captureStart();
    try {
      await run(["--manifest", manifestPath, "--project", "prj_test123"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
    }
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message),
      `should exit non-zero, got: ${threw && threw.message}`);
    const stderr = capturedStderr();
    assert.ok(!/node:fs:\d+/.test(stderr),
      `must not leak raw node:fs stack, got: ${stderr}`);
    const line = stderr.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line on stderr, got: ${stderr}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.ok(parsed.message && parsed.message.includes(missingName),
      `message should mention missing SQL filename, got: ${parsed.message}`);
    assert.equal(parsed.details?.field, "migrations_file",
      `details.field should be migrations_file, got: ${parsed.details?.field}`);
    assert.ok(parsed.details?.path && parsed.details.path.endsWith(missingName),
      `details.path should be the absolute missing path, got: ${parsed.details?.path}`);
    assert.ok(parsed.hint && /relative to the manifest/i.test(parsed.hint),
      `hint should explain relative-path resolution, got: ${parsed.hint}`);
  });

  it("deploy with missing --manifest path returns structured JSON error (GH-44)", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const missingPath = join(tempDir, "definitely-not-a-real-manifest.json");
    let threw = null;
    captureStart();
    try {
      await run(["--manifest", missingPath, "--project", "prj_test123"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
    }
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message),
      `should exit non-zero, got: ${threw && threw.message}`);
    const stderr = capturedStderr();
    assert.ok(!/node:fs:\d+/.test(stderr),
      `must not leak raw node:fs stack, got: ${stderr}`);
    assert.ok(!/\bat readFileSync\b/.test(stderr),
      `must not leak raw readFileSync stack frame, got: ${stderr}`);
    const line = stderr.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line on stderr, got: ${stderr}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.details?.field, "manifest",
      `details.field should be manifest, got: ${parsed.details?.field}`);
    assert.ok(parsed.details?.path && parsed.details.path.endsWith("definitely-not-a-real-manifest.json"),
      `details.path should be the absolute missing manifest path, got: ${parsed.details?.path}`);
    assert.ok(parsed.hint, `hint should be present, got: ${parsed.hint}`);
  });

  it("deploy falls back to active project when manifest omits project_id (GH-41)", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const { setActiveProjectId } = await import("./cli/lib/config.mjs");
    const { writeFileSync: wf } = await import("node:fs");

    setActiveProjectId("prj_test123");

    const manifestPath = join(tempDir, "no-project-id-manifest.json");
    wf(manifestPath, JSON.stringify({
      files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
    }));

    // Capture the v2 plan request body so we can assert project_id was filled in.
    let sentSpec = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (url.endsWith("/deploy/v2/plans") && method === "POST") {
        let rawBody = init?.body;
        if (rawBody === undefined && input instanceof Request) {
          rawBody = await input.clone().text();
        }
        try { sentSpec = JSON.parse(rawBody)?.spec; } catch { sentSpec = null; }
      }
      return prevFetch(input, init);
    };

    captureStart();
    try {
      await run(["--manifest", manifestPath]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(sentSpec, "deploy should have called /deploy/v2/plans");
    assert.equal(sentSpec.project, "prj_test123", "spec.project should match active project");
    assert.ok(captured().includes("prj_test123"), "should return project info");
  });

  it("deploy errors cleanly when no active project and no --project and no manifest.project_id (GH-41)", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const { loadKeyStore, saveKeyStore } = await import("./cli/lib/config.mjs");
    const { writeFileSync: wf } = await import("node:fs");

    // Clear the active project in the keystore
    const store = loadKeyStore();
    delete store.active_project_id;
    saveKeyStore(store);

    const manifestPath = join(tempDir, "no-active-no-project-manifest.json");
    wf(manifestPath, JSON.stringify({
      files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
    }));

    let threw = null;
    captureStart();
    try {
      await run(["--manifest", manifestPath]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      // Restore the active project for any following tests that expect it set.
      const { setActiveProjectId } = await import("./cli/lib/config.mjs");
      setActiveProjectId("prj_test123");
    }
    const out = captured();
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message),
      `should exit non-zero, got: ${threw && threw.message}`);
    assert.ok(!/Project null not found/.test(out),
      `must not leak 'Project null not found', got: ${out}`);
    assert.ok(/no project specified|no active project/i.test(out),
      `should surface a clear no-active-project error, got: ${out}`);
  });

  it("deploy errors when manifest.project_id conflicts with --project (GH-42)", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    const manifestPath = join(tempDir, "conflict-manifest.json");
    wf(manifestPath, JSON.stringify({
      project_id: "prj_manifest",
      files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
    }));
    // Track whether the deploy plan endpoint was hit. The conflict check must
    // fire BEFORE any HTTP — silently deploying to the wrong project would be
    // exactly the bug this guards against.
    let deployCalled = false;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (url.endsWith("/deploy/v2/plans") && method === "POST") {
        deployCalled = true;
      }
      return prevFetch(input, init);
    };
    let threw = null;
    captureStart();
    try {
      await run(["--manifest", manifestPath, "--project", "prj_flag"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message), `should exit non-zero, got: ${threw && threw.message}`);
    assert.equal(deployCalled, false, "must not POST to /deploy/v2/plans on project_id conflict");
    const out = capturedStderr();
    const line = out.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line on stderr, got: ${out}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    const blob = JSON.stringify(parsed);
    assert.ok(blob.includes("prj_manifest"), `error payload must mention manifest project_id, got: ${blob}`);
    assert.ok(blob.includes("prj_flag"), `error payload must mention --project flag value, got: ${blob}`);
    assert.ok(typeof parsed.hint === "string" && parsed.hint.length > 0, `error must include a hint, got: ${blob}`);
  });

  it("deploy accepts --project matching manifest.project_id (GH-42)", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    const manifestPath = join(tempDir, "match-manifest.json");
    wf(manifestPath, JSON.stringify({
      project_id: "prj_test123",
      files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
    }));
    captureStart();
    await run(["--manifest", manifestPath, "--project", "prj_test123"]);
    captureStop();
    assert.ok(captured().includes("prj_test123"), "should deploy when manifest and flag agree");
  });

  // ── Functions ───────────────────────────────────────────────────────────

  it("functions deploy", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    const codePath = join(tempDir, "handler.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    wf(codePath, 'export default async (req) => new Response("ok")');
    captureStart();
    await run("deploy", ["prj_test123", "hello", "--file", codePath]);
    captureStop();
    assert.ok(captured().includes("hello"), "should deploy function");
  });

  it("functions list", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("list", ["prj_test123"]);
    captureStop();
    assert.ok(captured().includes("hello"), "should list functions");
  });

  it("functions invoke", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("invoke", ["prj_test123", "hello"]);
    captureStop();
    assert.ok(captured().includes("world"), "should return function response");
  });

  it("functions logs", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("logs", ["prj_test123", "hello"]);
    captureStop();
    assert.ok(captured().includes("hello world"), "should show logs");
  });

  // ── Secrets ─────────────────────────────────────────────────────────────

  it("secrets set", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    captureStart();
    await run("set", ["prj_test123", "TEST_KEY", "secret_value"]);
    captureStop();
    assert.ok(captured().includes("ok"), "should set secret");
  });

  it("secrets set --file", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    const valPath = join(tempDir, "secret.txt");
    wf(valPath, "file_secret_value");
    captureStart();
    await run("set", ["prj_test123", "FILE_KEY", "--file", valPath]);
    captureStop();
    assert.ok(captured().includes("ok"), "should set secret from file");
  });

  it("secrets list", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    captureStart();
    await run("list", ["prj_test123"]);
    captureStop();
    assert.ok(captured().includes("TEST_KEY"), "should list secrets");
  });

  // ── Blob (GH-40: fall back to active project from 'projects use') ───────

  it("blob ls falls back to active project (GH-40)", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
    const { setActiveProjectId } = await import("./cli/core-dist/keystore.js");
    // Prerequisite: the "projects provision" test above has saved prj_test123
    // to the keystore. Make it the active project.
    setActiveProjectId("prj_test123");
    // Explicitly clear the env var escape hatch so only the active project
    // fallback can satisfy the command.
    const prevEnv = process.env.RUN402_PROJECT;
    delete process.env.RUN402_PROJECT;
    let threw = null;
    captureStart();
    try {
      await run("ls", []);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      if (prevEnv !== undefined) process.env.RUN402_PROJECT = prevEnv;
    }
    assert.equal(threw, null, `should not throw, got: ${threw?.message}\nout: ${captured()}`);
    assert.ok(captured().includes("defaults/file.txt"), `should list blobs; got: ${captured()}`);
  });

  it("blob ls errors cleanly when no project and no active project (GH-40)", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
    const { setActiveProjectId, loadKeyStore, saveKeyStore } = await import("./cli/core-dist/keystore.js");
    // Clear active project + RUN402_PROJECT env var.
    const store = loadKeyStore();
    delete store.active_project_id;
    saveKeyStore(store);
    const prevEnv = process.env.RUN402_PROJECT;
    delete process.env.RUN402_PROJECT;
    let threw = null;
    captureStart();
    try {
      await run("ls", []);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      if (prevEnv !== undefined) process.env.RUN402_PROJECT = prevEnv;
      // Restore the active project so subsequent tests still work.
      setActiveProjectId("prj_test123");
    }
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message),
      `should exit 1 when no project is available, got: ${threw?.message}`);
    assert.ok(captured().includes("no active project") || captured().includes("no project specified"),
      `error should mention missing active project; got: ${captured()}`);
  });

  // ── Sites ───────────────────────────────────────────────────────────────

  it("sites deploy", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    const manifestPath = join(tempDir, "site-manifest.json");
    const { writeFileSync: wf } = await import("node:fs");
    wf(manifestPath, JSON.stringify({
      files: [{ file: "index.html", data: "<h1>Site</h1>" }],
    }));
    captureStart();
    await run("deploy", ["--manifest", manifestPath]);
    captureStop();
    assert.ok(captured().includes("dpl_test456"), "should return deployment id");
  });

  it("sites deploy-dir", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    const siteDir = join(tempDir, "site-from-dir");
    const { writeFileSync: wf, mkdirSync: md } = await import("node:fs");
    md(siteDir, { recursive: true });
    wf(join(siteDir, "index.html"), "<h1>From dir</h1>");
    wf(join(siteDir, "about.html"), "<h1>About</h1>");
    wf(join(siteDir, "contact.html"), "<h1>Contact</h1>");
    wf(join(siteDir, "style.css"), "body { color: blue; }");
    wf(join(siteDir, "script.js"), "console.log('hi')");
    captureStart();
    await run("deploy-dir", [siteDir, "--project", "prj_test123"]);
    captureStop();
    assert.ok(capturedStdout().includes("dpl_test456"), "should return deployment id from dir on stdout");
    assert.ok(capturedStdout().includes("\"status\": \"ok\""), "should emit JSON envelope with status ok on stdout");

    // Progress events are emitted as JSON-line on stderr by default.
    const stderr = capturedStderr();
    const jsonLines = stderr.split("\n").filter(Boolean).filter((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    });
    assert.ok(jsonLines.length > 0, `expected JSON event lines on stderr; got: ${stderr}`);
    const phases = jsonLines.map((l) => JSON.parse(l).phase);
    assert.ok(phases.includes("plan"), `expected a plan event; got phases: ${phases.join(",")}`);
    assert.ok(phases.includes("commit"), `expected a commit event; got phases: ${phases.join(",")}`);
  });

  it("sites deploy-dir --quiet suppresses stderr events", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    const siteDir = join(tempDir, "site-from-dir-quiet");
    const { writeFileSync: wf, mkdirSync: md } = await import("node:fs");
    md(siteDir, { recursive: true });
    wf(join(siteDir, "index.html"), "<h1>Quiet</h1>");
    captureStart();
    await run("deploy-dir", [siteDir, "--project", "prj_test123", "--quiet", "--confirm-prune"]);
    captureStop();
    assert.ok(capturedStdout().includes("\"status\": \"ok\""), "stdout still has the result envelope");
    // No JSON event lines on stderr.
    const stderr = capturedStderr();
    const eventLines = stderr.split("\n").filter(Boolean).filter((l) => {
      try { return typeof JSON.parse(l).phase === "string"; } catch { return false; }
    });
    assert.equal(eventLines.length, 0, `--quiet should suppress event lines; got: ${stderr}`);
  });

  it("sites deploy-dir fails on missing directory", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    const missing = join(tempDir, "does-not-exist-" + Date.now());
    let threw = null;
    captureStart();
    try {
      await run("deploy-dir", [missing, "--project", "prj_test123"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
    }
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message),
      `should exit 1 when dir is missing, got: ${threw?.message}`);
  });

  it("sites deploy-dir refuses small dir without --confirm-prune", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    const siteDir = join(tempDir, "site-tiny-no-confirm");
    const { writeFileSync: wf, mkdirSync: md } = await import("node:fs");
    md(siteDir, { recursive: true });
    wf(join(siteDir, "index.html"), "<h1>oneshot</h1>");
    let threw = null;
    captureStart();
    try {
      await run("deploy-dir", [siteDir, "--project", "prj_test123"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
    }
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message),
      `should exit 1 when small dir lacks --confirm-prune, got: ${threw?.message}`);
    const stderr = capturedStderr();
    assert.ok(stderr.includes("PRUNE_CONFIRMATION_REQUIRED"),
      `stderr should mention PRUNE_CONFIRMATION_REQUIRED, got: ${stderr}`);
    assert.ok(stderr.includes("--confirm-prune"),
      `stderr should hint at --confirm-prune, got: ${stderr}`);
    // Must not have made any plan/commit network calls.
    assert.ok(!stderr.includes("\"phase\":\"commit\""),
      `should not have committed; stderr: ${stderr}`);
  });

  it("sites deploy-dir small dir proceeds with --confirm-prune", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    const siteDir = join(tempDir, "site-tiny-confirm");
    const { writeFileSync: wf, mkdirSync: md } = await import("node:fs");
    md(siteDir, { recursive: true });
    wf(join(siteDir, "index.html"), "<h1>oneshot</h1>");
    captureStart();
    await run("deploy-dir", [siteDir, "--project", "prj_test123", "--confirm-prune"]);
    captureStop();
    assert.ok(capturedStdout().includes("dpl_test456"),
      `should commit when --confirm-prune is set; stdout: ${capturedStdout()}`);
    assert.ok(capturedStdout().includes("\"status\": \"ok\""),
      `should emit ok envelope; stdout: ${capturedStdout()}`);
  });

  it("sites deploy-dir --dry-run plans without committing", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    const siteDir = join(tempDir, "site-dry-run");
    const { writeFileSync: wf, mkdirSync: md } = await import("node:fs");
    md(siteDir, { recursive: true });
    wf(join(siteDir, "index.html"), "<h1>dry</h1>");
    captureStart();
    await run("deploy-dir", [siteDir, "--project", "prj_test123", "--dry-run"]);
    captureStop();
    const stdout = capturedStdout();
    assert.ok(stdout.includes("\"status\": \"ok\""),
      `dry-run should emit status ok; stdout: ${stdout}`);
    assert.ok(stdout.includes("\"dry_run\": true"),
      `dry-run envelope should include dry_run: true; stdout: ${stdout}`);
    assert.ok(stdout.includes("\"plan_id\""),
      `dry-run envelope should include plan_id; stdout: ${stdout}`);
    // Must not have committed (no deployment_id from the commit handler).
    assert.ok(!stdout.includes("dpl_test456"),
      `dry-run should not commit; stdout: ${stdout}`);
    const stderr = capturedStderr();
    assert.ok(!stderr.includes("\"phase\":\"commit\""),
      `dry-run should not emit commit events; stderr: ${stderr}`);
  });

  // ── Subdomains ──────────────────────────────────────────────────────────

  it("subdomains claim", async () => {
    const { run } = await import("./cli/lib/subdomains.mjs");
    captureStart();
    await run("claim", ["dpl_test456", "my-app", "--project", "prj_test123"]);
    captureStop();
    assert.ok(captured().includes("my-app"), "should claim subdomain");
  });

  it("subdomains list", async () => {
    const { run } = await import("./cli/lib/subdomains.mjs");
    captureStart();
    await run("list", ["prj_test123"]);
    captureStop();
    assert.ok(captured().includes("my-app"), "should list subdomains");
  });

  // ── Apps ────────────────────────────────────────────────────────────────

  it("apps browse", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("browse", []);
    captureStop();
    assert.ok(captured().includes("demo-app"), "should list apps");
  });

  it("apps publish", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("publish", ["prj_test123", "--description", "Test app", "--visibility", "public"]);
    captureStop();
    assert.ok(captured().includes("ver_pub1"), "should return version id");
  });

  it("apps versions", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("versions", ["prj_test123"]);
    captureStop();
    assert.ok(captured().includes("ver_pub1"), "should list versions");
  });

  it("apps inspect", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("inspect", ["ver_abc"]);
    captureStop();
    assert.ok(captured().includes("demo-app"), "should show app details");
  });

  it("apps update", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("update", ["prj_test123", "ver_pub1", "--description", "Updated"]);
    captureStop();
    assert.ok(captured().includes("Updated") || captured().includes("ver_pub1"), "should update version");
  });

  it("apps fork", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("fork", ["ver_abc", "my-fork"]);
    captureStop();
    assert.ok(captured().includes("prj_forked"), "should fork app");
  });

  // ── Image ───────────────────────────────────────────────────────────────

  it("image generate", async () => {
    const { run } = await import("./cli/lib/image.mjs");
    captureStart();
    await run("generate", ["a cat in a hat"]);
    captureStop();
    const out = captured();
    assert.ok(out.includes("image") || out.includes("iVBOR") || out.includes("ok"), "should return image data");
  });

  // ── Message ─────────────────────────────────────────────────────────────

  it("message send", async () => {
    const { run } = await import("./cli/lib/message.mjs");
    captureStart();
    await run("send", ["Hello", "from", "e2e", "test"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delivered"), "should send message");
  });

  // ── Agent ───────────────────────────────────────────────────────────────

  it("agent contact", async () => {
    const { run } = await import("./cli/lib/agent.mjs");
    captureStart();
    await run("contact", ["--name", "test-agent", "--email", "test@example.com"]);
    captureStop();
    assert.ok(captured().includes("test-agent"), "should set agent contact");
  });

  // ── Auth (GH-90) ────────────────────────────────────────────────────────
  //
  // `auth set-password` hits /auth/v1/user/password, which is gated by the
  // apikeyAuth middleware. The CLI MUST send `apikey: <anon_key>` so the
  // middleware lets the request through, and `Authorization: Bearer <token>`
  // must remain the user's access_token (NOT the anon_key) so the server
  // knows which authenticated user to mutate.
  //
  // This was the gap left by commit 90e1e9b which fixed the same class of
  // bug for magic-link / verify / settings / providers but missed
  // set-password. See run402-public#90.

  it("auth set-password sends apikey and keeps user access_token as Bearer (GH-90)", async () => {
    const { run } = await import("./cli/lib/auth.mjs");
    let capturedUrl = null;
    let capturedMethod = null;
    let capturedHeaders = null;
    let capturedBody = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (url.endsWith("/auth/v1/user/password") && method === "PUT") {
        capturedUrl = url;
        capturedMethod = method;
        // Headers and body may be on init (direct fetch) or on the Request
        // object (when a wrapper like @x402/fetch normalizes the args).
        if (init?.headers) {
          capturedHeaders = init.headers;
        } else if (input instanceof Request) {
          capturedHeaders = Object.fromEntries(input.headers.entries());
        } else {
          capturedHeaders = {};
        }
        let rawBody = init?.body;
        if (rawBody === undefined && input instanceof Request) {
          rawBody = await input.clone().text();
        }
        try { capturedBody = rawBody ? JSON.parse(rawBody) : null; } catch { capturedBody = rawBody; }
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return prevFetch(input, init);
    };
    captureStart();
    try {
      await run("set-password", [
        "--project", "prj_test123",
        "--token", "user-jwt-access-token",
        "--new", "Secr3t!Pass",
      ]);
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(capturedUrl, "PUT /auth/v1/user/password should have been called");
    assert.equal(capturedMethod, "PUT", "must be a PUT request");
    // apikey identifies the project to apikeyAuth middleware
    assert.equal(
      capturedHeaders.apikey ?? capturedHeaders.Apikey,
      "anon_test_key",
      `apikey header must equal the project's anon_key; got headers: ${JSON.stringify(capturedHeaders)}`,
    );
    // Bearer must remain the user's access_token — NOT the anon_key.
    assert.equal(
      capturedHeaders.Authorization ?? capturedHeaders.authorization,
      "Bearer user-jwt-access-token",
      `Authorization header must be Bearer <user access_token>, not the anon_key; got headers: ${JSON.stringify(capturedHeaders)}`,
    );
    assert.equal(capturedBody?.new_password, "Secr3t!Pass", "body should carry new_password");
    assert.ok(captured().includes("ok"), "should print ok status");
  });

  // ── Cleanup commands (deletions) ────────────────────────────────────────

  it("secrets delete", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    captureStart();
    await run("delete", ["prj_test123", "TEST_KEY"]);
    captureStop();
    assert.ok(captured().includes("ok"), "should delete secret");
  });

  it("functions delete", async () => {
    const { run } = await import("./cli/lib/functions.mjs");
    captureStart();
    await run("delete", ["prj_test123", "hello"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delete"), "should delete function");
  });

  it("subdomains delete", async () => {
    const { run } = await import("./cli/lib/subdomains.mjs");
    captureStart();
    await run("delete", ["my-app", "--confirm", "--project", "prj_test123"]);
    captureStop();
    assert.ok(captured().includes("ok"), "should delete subdomain");
  });

  it("apps delete", async () => {
    const { run } = await import("./cli/lib/apps.mjs");
    captureStart();
    await run("delete", ["prj_test123", "ver_pub1"]);
    captureStop();
    assert.ok(captured().includes("ok"), "should delete version");
  });

  it("projects delete", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("delete", ["prj_test123", "--confirm"]);
    captureStop();
    assert.ok(captured().includes("deleted") || captured().includes("ok"), "should delete project");
  });

  // ── Init (runs after allowance exists) ──────────────────────────────────

  it("init (allowance already exists)", async () => {
    const { run } = await import("./cli/lib/init.mjs");
    captureStart();
    await run();
    captureStop();
    const out = captured();
    assert.ok(out.includes("Config"), "should show config dir");
    assert.ok(out.includes("Allowance"), "should show allowance");
    assert.ok(out.includes("Balance") || out.includes("USDC"), "should show balance");
    assert.ok(out.includes("Tier") || out.includes("prototype"), "should show tier");
    // GH-32: the Projects line must say "saved", not the misleading "active"
    assert.ok(/Projects\s+\d+\s+saved/.test(out), `should say "N saved" not "N active", got: ${out}`);
    assert.ok(!/Projects\s+\d+\s+active/.test(out), `must not use the misleading "N active" wording, got: ${out}`);
  });

  it("init --json emits JSON on stdout and human lines on stderr (GH-32)", async () => {
    const { run } = await import("./cli/lib/init.mjs");
    captureStart();
    await run(["--json"]);
    captureStop();
    const stdout = capturedStdout();
    const stderr = capturedStderr();
    // stdout must be a single JSON object; no human-readable padded lines.
    assert.ok(stdout.trim().length > 0, "stdout must not be empty");
    assert.ok(!/Config\s{2,}/.test(stdout), `stdout must not contain human lines, got: ${stdout}`);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail(`stdout must be parseable JSON, got: ${stdout}`);
    }
    assert.ok(typeof parsed === "object" && parsed !== null, "stdout must be a JSON object");
    assert.ok(typeof parsed.config_dir === "string", "should include config_dir");
    assert.ok(typeof parsed.allowance === "object" && parsed.allowance?.address, "should include allowance.address");
    assert.ok(parsed.rail === "x402" || parsed.rail === "mpp", `should include rail, got: ${parsed.rail}`);
    assert.ok(typeof parsed.network === "string", "should include network");
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, "balance"), "should include balance field");
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, "tier"), "should include tier field");
    assert.equal(typeof parsed.projects_saved, "number", "should include projects_saved (number)");
    assert.ok(typeof parsed.next_step === "string", "should include next_step");
    // Human-readable lines should still be emitted somewhere so agent can log them,
    // but they must go to stderr in JSON mode.
    assert.ok(stderr.includes("Config"), `stderr should contain human lines, got: ${stderr}`);
  });

  it("status has billing, wallet_balance_usd_micros, and project_id fields (GH-32)", async () => {
    const { run } = await import("./cli/lib/status.mjs");
    captureStart();
    await run();
    captureStop();
    const out = captured();
    const data = JSON.parse(out);
    assert.ok(data.allowance, "should include allowance");
    assert.ok(data.allowance.address, "should include allowance address");
    assert.ok(Array.isArray(data.projects), "should include projects array");
    // GH-32 sub-issue 2: rename balance → billing, add wallet_balance_usd_micros
    assert.ok(!Object.prototype.hasOwnProperty.call(data, "balance"),
      `status should not expose ambiguous "balance" field; got: ${JSON.stringify(data)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(data, "billing"),
      `status should expose "billing" field; got: ${JSON.stringify(data)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(data, "wallet_balance_usd_micros"),
      `status should expose "wallet_balance_usd_micros"; got: ${JSON.stringify(data)}`);
    const wb = data.wallet_balance_usd_micros;
    assert.ok(wb === null || typeof wb === "number",
      `wallet_balance_usd_micros must be number or null; got: ${JSON.stringify(wb)}`);
    // GH-32 sub-issue 4: projects entries must use project_id
    for (const p of data.projects) {
      assert.ok(typeof p.project_id === "string" && p.project_id.length > 0,
        `each project should have a project_id; got: ${JSON.stringify(p)}`);
      assert.ok(!Object.prototype.hasOwnProperty.call(p, "id"),
        `status projects[*] should not use "id" field; got: ${JSON.stringify(p)}`);
    }
  });

  it("service status", async () => {
    const { run } = await import("./cli/lib/service.mjs");
    captureStart();
    await run("status", []);
    captureStop();
    const data = JSON.parse(captured());
    assert.equal(data.schema_version, "run402-status-v1");
    assert.equal(data.current_status, "operational");
  });

  it("service health", async () => {
    const { run } = await import("./cli/lib/service.mjs");
    captureStart();
    await run("health", []);
    captureStop();
    const data = JSON.parse(captured());
    assert.equal(data.status, "healthy");
    assert.ok(data.checks.postgres === "ok");
  });

  it("service health exits non-zero and uses stderr on 503 (GH-85)", async () => {
    const { run } = await import("./cli/lib/service.mjs");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (/\/health$/.test(url) && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({
          status: "degraded",
          checks: { postgres: "ok", postgrest: "fail", s3: "ok", cloudfront: "ok" },
          version: "1.0.4",
        }), { status: 503, headers: { "Content-Type": "application/json" } }));
      }
      return prevFetch(input, init);
    };
    let threw = null;
    captureStart();
    try {
      await run("health", []);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message),
      `should exit non-zero, got: ${threw && threw.message}`);
    const stderr = capturedStderr();
    assert.ok(stderr.includes('"http":503'),
      `stderr should include "http":503, got: ${stderr}`);
    const stdout = capturedStdout();
    assert.equal(stdout, "",
      `stdout should be empty on error, got: ${stdout}`);
    const line = stderr.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line on stderr, got: ${stderr}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.http, 503);
    assert.ok(!/"error":\s*"non_2xx"/.test(stderr),
      `must not use old 'non_2xx' envelope, got: ${stderr}`);
  });

  it("service health exits 0 on 200 and writes body to stdout (GH-85)", async () => {
    const { run } = await import("./cli/lib/service.mjs");
    let threw = null;
    captureStart();
    try {
      await run("health", []);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
    }
    assert.equal(threw, null,
      `should not throw (exit 0 expected), got: ${threw && threw.message}`);
    const stdout = capturedStdout();
    assert.ok(stdout.includes('"status": "healthy"'),
      `stdout should include body on 200, got: ${stdout}`);
    const stderr = capturedStderr();
    assert.equal(stderr, "",
      `stderr should be empty on 200, got: ${stderr}`);
  });

  it("service (no subcommand prints help and exits 0)", async () => {
    const { run } = await import("./cli/lib/service.mjs");
    captureStart();
    let threw = null;
    try { await run(undefined, []); } catch (e) { threw = e; }
    captureStop();
    assert.equal(threw?.message, "process.exit(0)");
    assert.ok(captured().includes("run402 service"));
  });

  it("service foo (unknown subcommand exits 1)", async () => {
    const { run } = await import("./cli/lib/service.mjs");
    captureStart();
    let threw = null;
    try { await run("foo", []); } catch (e) { threw = e; }
    captureStop();
    assert.equal(threw?.message, "process.exit(1)");
    assert.ok(captured().includes("Unknown subcommand"));
  });

  // ── MPP rail ─────────────────────────────────────────────────────────────

  it("init mpp (switch to MPP rail)", async () => {
    tempoRpcCallCount = 0; // reset for fresh faucet flow
    const { run } = await import("./cli/lib/init.mjs");
    captureStart();
    await run(["mpp", "--switch-rail"]);
    captureStop();
    const out = captured();
    assert.ok(out.includes("Tempo"), "should show Tempo network");
    assert.ok(out.includes("pathUSD"), "should show pathUSD");
    assert.ok(out.includes("mpp"), "should show mpp rail");
    // Verify rail saved
    const allowance = JSON.parse(readFileSync(join(tempDir, "allowance.json"), "utf-8"));
    assert.equal(allowance.rail, "mpp", "rail should be mpp");
  });

  // GH-81: after MPP faucet succeeds, `--json` summary must reflect funded=true
  // and the polled balance. Previously `summary.allowance` was captured before
  // the faucet branch ran, so the JSON reported `funded: false` and
  // `usd_micros: 0` even when the human-readable lines said "funded".
  it("init mpp --json reports funded=true after faucet settles (GH-81)", async () => {
    tempoRpcCallCount = 0; // first eth_call returns 0 → triggers faucet path
    const { run } = await import("./cli/lib/init.mjs");
    captureStart();
    await run(["mpp", "--json", "--switch-rail"]);
    captureStop();
    const stdout = capturedStdout();
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.rail, "mpp", `rail must be mpp; got: ${parsed.rail}`);
    assert.equal(parsed.allowance.funded, true,
      `summary.allowance.funded must be true after successful faucet; got: ${JSON.stringify(parsed.allowance)}`);
    assert.equal(parsed.balance.symbol, "pathUSD");
    assert.ok(parsed.balance.usd_micros > 0,
      `summary.balance.usd_micros must reflect polled balance (>0); got: ${parsed.balance.usd_micros}`);
  });

  it("allowance status (MPP rail)", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("status", []);
    captureStop();
    assert.ok(captured().includes("mpp"), "should show mpp rail");
  });

  it("allowance balance (MPP rail)", async () => {
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("balance", []);
    captureStop();
    const out = captured();
    assert.ok(out.includes("tempo-moderato_pathusd_micros"), "should show Tempo balance");
    assert.ok(out.includes("mpp"), "should show mpp rail");
  });

  it("allowance fund (MPP rail)", async () => {
    tempoRpcCallCount = 0; // reset so first call returns 0, faucet tops up
    const { run } = await import("./cli/lib/allowance.mjs");
    captureStart();
    await run("fund", []);
    captureStop();
    const out = captured();
    assert.ok(out.includes("tempo-moderato_pathusd_micros"), "should show Tempo fund result");
    assert.ok(out.includes("mpp"), "should show mpp rail");
  });

  it("init (switch back to x402)", async () => {
    const { run } = await import("./cli/lib/init.mjs");
    captureStart();
    await run(["--switch-rail"]);
    captureStop();
    const out = captured();
    assert.ok(out.includes("Base Sepolia"), "should show Base Sepolia network");
    assert.ok(out.includes("x402"), "should show x402 rail");
    // Verify rail switched back
    const allowance = JSON.parse(readFileSync(join(tempDir, "allowance.json"), "utf-8"));
    assert.equal(allowance.rail, "x402", "rail should be x402");
  });

  // ── Subcommand --help / -h (GH #48–67) ────────────────────────────────────
  //
  // Every `cli/lib/<cmd>.mjs` exports `run(sub, args)`. When the user runs
  // `run402 <cmd> <sub> --help`, `sub` is the subcommand name and `--help`
  // lives inside `args`. Without an args-level --help check, the inner
  // handler either validates required flags (producing confusing errors),
  // treats `--help` as a positional argument, or — worst — makes a live API
  // call that provisions a project, sends a message, or hits a 404.
  //
  // Each test spies on fetch and asserts:
  //   1. The command exits 0 (process.exit stub throws "process.exit(0)")
  //   2. The module HELP banner is printed to stdout
  //   3. NO fetch call is made (no network I/O, no side effects)
  //
  // Coverage picks representative cases for each failure mode. The
  // side-effect paths (#49 projects provision, #54 message send) are the
  // most critical — a broken --help here SENDS A REAL MESSAGE or
  // PROVISIONS A REAL PROJECT.

  function makeHelpTest({ label, module, sub, bannerRegex, extraArgs = [] }) {
    it(label, async () => {
      const { run } = await import(module);
      // Spy on fetch — any call here is a bug, regardless of mock behaviour.
      let fetchCalled = false;
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (...args) => {
        fetchCalled = true;
        return prevFetch(...args);
      };
      let threw = null;
      captureStart();
      try {
        await run(sub, [...extraArgs, "--help"]);
      } catch (e) {
        threw = e;
      } finally {
        captureStop();
        globalThis.fetch = prevFetch;
      }
      assert.equal(threw?.message, "process.exit(0)",
        `'${sub} --help' should exit 0, got: ${threw?.message}`);
      assert.equal(fetchCalled, false,
        `'${sub} --help' must not make any fetch/API call`);
      const stdout = capturedStdout();
      assert.ok(bannerRegex.test(stdout),
        `stdout should begin with module HELP banner; got: ${stdout}`);
    });
  }

  // #48 — tier-name parsing: "Unknown tier: --help"
  makeHelpTest({
    label: "tier set --help prints help (GH-48)",
    module: "./cli/lib/tier.mjs",
    sub: "set",
    bannerRegex: /^run402 tier/,
  });

  // #49 — CRITICAL: provisions a real project if --help isn't short-circuited
  makeHelpTest({
    label: "projects provision --help prints help and does not provision (GH-49)",
    module: "./cli/lib/projects.mjs",
    sub: "provision",
    bannerRegex: /^run402 projects/,
  });

  // #50 — runs live list
  makeHelpTest({
    label: "projects list --help prints help (GH-50)",
    module: "./cli/lib/projects.mjs",
    sub: "list",
    bannerRegex: /^run402 projects/,
  });

  // #51 — treats --help as project id
  makeHelpTest({
    label: "projects delete --help prints help (GH-51)",
    module: "./cli/lib/projects.mjs",
    sub: "delete",
    bannerRegex: /^run402 projects/,
  });

  // #52, #58, #59, #60 — functions subcommands treat --help as project id
  makeHelpTest({
    label: "functions deploy --help prints help (GH-52)",
    module: "./cli/lib/functions.mjs",
    sub: "deploy",
    bannerRegex: /^run402 functions/,
  });
  makeHelpTest({
    label: "functions invoke --help prints help (GH-58)",
    module: "./cli/lib/functions.mjs",
    sub: "invoke",
    bannerRegex: /^run402 functions/,
  });
  makeHelpTest({
    label: "functions logs --help prints help (GH-59)",
    module: "./cli/lib/functions.mjs",
    sub: "logs",
    bannerRegex: /^run402 functions/,
  });
  makeHelpTest({
    label: "functions delete --help prints help (GH-60)",
    module: "./cli/lib/functions.mjs",
    sub: "delete",
    bannerRegex: /^run402 functions/,
  });

  // #53 — executes live list
  makeHelpTest({
    label: "blob ls --help prints help (GH-53)",
    module: "./cli/lib/blob.mjs",
    sub: "ls",
    bannerRegex: /^run402 blob/,
  });

  // #64 — blob put: "no project specified"
  makeHelpTest({
    label: "blob put --help prints help (GH-64)",
    module: "./cli/lib/blob.mjs",
    sub: "put",
    bannerRegex: /^run402 blob/,
  });

  // #54 — CRITICAL: sends a real message if --help isn't short-circuited
  makeHelpTest({
    label: "message send --help prints help and does not send (GH-54)",
    module: "./cli/lib/message.mjs",
    sub: "send",
    bannerRegex: /^run402 message/,
  });

  // #55 — "Missing --email"
  makeHelpTest({
    label: "auth magic-link --help prints help (GH-55)",
    module: "./cli/lib/auth.mjs",
    sub: "magic-link",
    bannerRegex: /^run402 auth/,
  });

  // #65 — auth verify: "no project specified" (findProject called)
  makeHelpTest({
    label: "auth verify --help prints help (GH-65)",
    module: "./cli/lib/auth.mjs",
    sub: "verify",
    bannerRegex: /^run402 auth/,
  });

  // #66 — auth set-password: "Missing --token"
  makeHelpTest({
    label: "auth set-password --help prints help (GH-66)",
    module: "./cli/lib/auth.mjs",
    sub: "set-password",
    bannerRegex: /^run402 auth/,
  });

  // #67 — auth settings: "no project specified"
  makeHelpTest({
    label: "auth settings --help prints help (GH-67)",
    module: "./cli/lib/auth.mjs",
    sub: "settings",
    bannerRegex: /^run402 auth/,
  });

  // #56 — "Missing --name"
  makeHelpTest({
    label: "agent contact --help prints help (GH-56)",
    module: "./cli/lib/agent.mjs",
    sub: "contact",
    bannerRegex: /^run402 agent/,
  });

  // #57 — live GET /status returns 404
  makeHelpTest({
    label: "service status --help prints help and does not hit /status (GH-57)",
    module: "./cli/lib/service.mjs",
    sub: "status",
    bannerRegex: /^run402 service/,
  });

  // #61, #62 — secrets subcommands treat --help as project id
  makeHelpTest({
    label: "secrets set --help prints help (GH-61)",
    module: "./cli/lib/secrets.mjs",
    sub: "set",
    bannerRegex: /^run402 secrets/,
  });
  makeHelpTest({
    label: "secrets list --help prints help (GH-62)",
    module: "./cli/lib/secrets.mjs",
    sub: "list",
    bannerRegex: /^run402 secrets/,
  });

  // #63 — projects sql: treats --help as project id ("Project --help not found")
  makeHelpTest({
    label: "projects sql --help prints help (GH-63)",
    module: "./cli/lib/projects.mjs",
    sub: "sql",
    bannerRegex: /^run402 projects/,
  });

  // GH-103: `projects pin` must be clearly marked as admin-only in help text.
  // The server-side /projects/v1/admin/:id/pin endpoint rejects project-owner
  // auth (service_key / SIWX) with 403 admin_required. Help text that omits
  // the admin caveat leads owners into an error they cannot resolve.
  it("projects pin --help marks pin as admin-only (GH-103)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    let fetchCalled = false;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (...args) => { fetchCalled = true; return prevFetch(...args); };
    let threw = null;
    captureStart();
    try {
      await run("pin", ["--help"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw?.message, "process.exit(0)", "pin --help should exit 0");
    assert.equal(fetchCalled, false, "pin --help must not make any fetch/API call");
    const stdout = capturedStdout();
    // Find the pin line in the subcommand list and assert it mentions admin.
    const pinLine = stdout.split("\n").find(l => /^\s*pin\s/.test(l)) ?? "";
    assert.match(
      pinLine,
      /admin/i,
      `pin subcommand line should mention admin-only; got: ${pinLine}`,
    );
  });

  // Also spot-check the short flag alias -h works.
  it("projects sql -h prints help (GH-63 short flag)", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    let fetchCalled = false;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (...args) => { fetchCalled = true; return prevFetch(...args); };
    let threw = null;
    captureStart();
    try {
      await run("sql", ["-h"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw?.message, "process.exit(0)", "-h should exit 0");
    assert.equal(fetchCalled, false, "-h must not make any fetch/API call");
    assert.ok(/^run402 projects/.test(capturedStdout()), "stdout should include help banner");
  });

  // ── Email feature additions (GH-87) ─────────────────────────────────────
  // Covers: send validation (subject+html required together), --vars JSON,
  // list pagination, info alias, delete, reply. Each test stubs fetch inline
  // so it doesn't depend on the main happy-path mock having email routes.
  //
  // Earlier tests in the happy-path suite may have deleted the active
  // project from the keystore (via projects:delete). Re-seed TEST_PROJECT
  // and set it active before each email test so they're order-independent.
  async function seedTestProject() {
    const { saveProject, setActiveProjectId } = await import("./cli/lib/config.mjs");
    saveProject(TEST_PROJECT.project_id, {
      anon_key: TEST_PROJECT.anon_key,
      service_key: TEST_PROJECT.service_key,
    });
    setActiveProjectId(TEST_PROJECT.project_id);
  }

  /**
   * Build an isolated fetch mock for email tests. Optional `overrides` is a
   * map keyed by "METHOD path" that returns a Response (or null to fall
   * through). Captured requests are pushed to `calls`.
   */
  function buildEmailFetch(calls, overrides = {}) {
    const MAILBOX_ID = "mbx_test_1";
    const MAILBOX_ADDRESS = "test@mail.run402.com";
    return async (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      let body = null;
      // Body may be on init (direct fetch) or on the Request object (when a
      // wrapper like @x402/fetch normalizes args).
      let rawBody = init?.body;
      if (rawBody === undefined && input instanceof Request) {
        try { rawBody = await input.clone().text(); } catch { rawBody = undefined; }
      }
      if (rawBody && typeof rawBody === "string") {
        try { body = JSON.parse(rawBody); } catch { body = rawBody; }
      }
      let path = url;
      if (url.startsWith(API)) path = url.slice(API.length);
      const pathNoQuery = path.split("?")[0];
      const query = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : new URLSearchParams();
      calls.push({ method, path, pathNoQuery, query: Object.fromEntries(query), body, headers: init?.headers || {} });

      const key = `${method} ${pathNoQuery}`;
      if (key in overrides) {
        const v = overrides[key];
        if (typeof v === "function") return Promise.resolve(v({ method, path, pathNoQuery, query, body }));
        if (v) return Promise.resolve(v);
      }

      // Defaults
      if (method === "GET" && pathNoQuery === "/mailboxes/v1") {
        return Promise.resolve(json({ mailboxes: [{ mailbox_id: MAILBOX_ID, address: MAILBOX_ADDRESS, slug: "test" }] }));
      }
      if (method === "DELETE" && pathNoQuery === `/mailboxes/v1/${MAILBOX_ID}`) {
        return Promise.resolve(noContent());
      }
      if (method === "POST" && pathNoQuery === `/mailboxes/v1/${MAILBOX_ID}/messages`) {
        return Promise.resolve(json({ id: "msg_sent_1", to: body?.to, template: body?.template || null, subject: body?.subject || null, status: "sent" }));
      }
      if (method === "GET" && pathNoQuery === `/mailboxes/v1/${MAILBOX_ID}/messages`) {
        return Promise.resolve(json({ messages: [], next_cursor: null }));
      }
      if (method === "GET" && /^\/mailboxes\/v1\/[^/]+\/messages\/[^/]+$/.test(pathNoQuery)) {
        const msgId = pathNoQuery.split("/").pop();
        return Promise.resolve(json({ id: msgId, from: "sender@example.com", subject: "original", html: "<p>hi</p>" }));
      }

      originalError(`[EMAIL-MOCK] Unhandled: ${method} ${pathNoQuery}`);
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    };
  }

  it("email send raw mode requires both --subject and --html (GH-87)", async () => {
    await seedTestProject();
    const { run } = await import("./cli/lib/email.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildEmailFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("send", ["--to", "user@example.com", "--subject", "Hi"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw?.message, "process.exit(1)", "should exit non-zero on missing --html");
    assert.ok(/Raw mode requires both/.test(capturedStderr()), `stderr should mention the validation rule, got: ${capturedStderr()}`);
    assert.equal(calls.filter(c => c.method === "POST" && c.pathNoQuery.endsWith("/messages")).length, 0, "must not attempt to send");
  });

  it("email send --vars JSON populates template variables (GH-87)", async () => {
    await seedTestProject();
    const { run } = await import("./cli/lib/email.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildEmailFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("send", [
        "--to", "user@example.com",
        "--template", "notification",
        "--vars", '{"project_name":"MyApp","message":"Hello"}',
      ]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw, null, `should succeed, got: ${threw?.message || "(no throw)"} / ${capturedStderr()}`);
    const send = calls.find(c => c.method === "POST" && c.pathNoQuery.endsWith("/messages"));
    assert.ok(send, "must POST to messages");
    assert.equal(send.body.template, "notification");
    assert.deepEqual(send.body.variables, { project_name: "MyApp", message: "Hello" });
  });

  it("email list passes --limit and --after as query params (GH-87)", async () => {
    await seedTestProject();
    const { run } = await import("./cli/lib/email.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildEmailFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("list", ["--limit", "50", "--after", "msg_abc123"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw, null, `should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const listCall = calls.find(c => c.method === "GET" && c.pathNoQuery.endsWith("/messages"));
    assert.ok(listCall, "must GET messages");
    assert.equal(listCall.query.limit, "50");
    assert.equal(listCall.query.after, "msg_abc123");
  });

  it("email info is an alias for status (GH-87)", async () => {
    await seedTestProject();
    const { run } = await import("./cli/lib/email.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildEmailFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("info", []);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw, null, `should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const stdout = capturedStdout();
    assert.ok(stdout.includes("mbx_test_1"), `stdout should include mailbox_id, got: ${stdout}`);
    assert.ok(stdout.includes("test@mail.run402.com"), `stdout should include address, got: ${stdout}`);
  });

  it("email delete without --confirm refuses to mutate (GH-87)", async () => {
    await seedTestProject();
    const { run } = await import("./cli/lib/email.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildEmailFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("delete", []);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw?.message, "process.exit(1)", "should exit non-zero");
    assert.equal(calls.filter(c => c.method === "DELETE").length, 0, "must not issue any DELETE");
    assert.ok(/Destructive/.test(capturedStderr()), `stderr should explain the guard, got: ${capturedStderr()}`);
  });

  it("email delete --confirm issues DELETE and clears cached mailbox (GH-87)", async () => {
    await seedTestProject();
    const { run } = await import("./cli/lib/email.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildEmailFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("delete", ["--confirm"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw, null, `should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const del = calls.find(c => c.method === "DELETE" && c.pathNoQuery.startsWith("/mailboxes/v1/"));
    assert.ok(del, "must issue DELETE /mailboxes/v1/<id>");
    assert.ok(/"deleted":\s*true/.test(capturedStdout()), `stdout should confirm deletion, got: ${capturedStdout()}`);
  });

  it("email reply fetches original and sends with in_reply_to (GH-87)", async () => {
    await seedTestProject();
    const { run } = await import("./cli/lib/email.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildEmailFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("reply", ["msg_abc123", "--html", "<p>Thanks!</p>"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw, null, `should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const getCall = calls.find(c => c.method === "GET" && /\/messages\/msg_abc123$/.test(c.pathNoQuery));
    assert.ok(getCall, "must GET the original message first");
    const send = calls.find(c => c.method === "POST" && c.pathNoQuery.endsWith("/messages"));
    assert.ok(send, "must POST a new message");
    assert.equal(send.body.to, "sender@example.com", "should address the reply to original sender");
    assert.equal(send.body.subject, "Re: original", "should prefix subject with Re:");
    assert.equal(send.body.in_reply_to, "msg_abc123", "must forward in_reply_to for server threading");
    assert.equal(send.body.html, "<p>Thanks!</p>");
  });
});

// ── --confirm guard for destructive deletes (GH-212) ────────────────────────
// `projects delete`, `subdomains delete`, `domains delete` must refuse to run
// without --confirm. The `projects delete` case is most dangerous: with no
// positional, it falls back to the active project, so a typo like
// `run402 projects delete $WRONG_VAR` (where $WRONG_VAR is empty) silently
// destroys the active project unless the guard fires first.

describe("CLI destructive delete --confirm guard (GH-212)", () => {
  async function seedActiveProject() {
    const { saveProject, setActiveProjectId } = await import("./cli/lib/config.mjs");
    saveProject(TEST_PROJECT.project_id, {
      anon_key: TEST_PROJECT.anon_key,
      service_key: TEST_PROJECT.service_key,
    });
    setActiveProjectId(TEST_PROJECT.project_id);
  }

  function buildSpyFetch(calls) {
    const apiOrigin = new URL(API).origin;
    return async (input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      let path = url;
      try {
        const parsed = new URL(url);
        if (parsed.origin === apiOrigin) path = parsed.pathname + parsed.search;
      } catch {
        // non-URL input — leave path as the raw string
      }
      calls.push({ method, path, url });
      // Default success for any DELETE so the --confirm path completes.
      if (method === "DELETE") return Promise.resolve(noContent());
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    };
  }

  it("projects delete (no args, no --confirm) refuses and does not call gateway", async () => {
    await seedActiveProject();
    const { run } = await import("./cli/lib/projects.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildSpyFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("delete", []);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw?.message, "process.exit(1)", "must exit non-zero");
    assert.equal(calls.filter(c => c.method === "DELETE").length, 0, "must not issue any DELETE");
    const stderr = capturedStderr();
    assert.ok(/CONFIRMATION_REQUIRED/.test(stderr), `stderr should include CONFIRMATION_REQUIRED, got: ${stderr}`);
    assert.ok(/Destructive/.test(stderr), `stderr should explain the guard, got: ${stderr}`);
    assert.ok(/--confirm/.test(stderr), `stderr should mention --confirm, got: ${stderr}`);
  });

  it("projects delete <id> (no --confirm) refuses and does not call gateway", async () => {
    await seedActiveProject();
    const { run } = await import("./cli/lib/projects.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildSpyFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("delete", ["prj_test123"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw?.message, "process.exit(1)", "must exit non-zero");
    assert.equal(calls.filter(c => c.method === "DELETE").length, 0, "must not issue any DELETE");
    assert.ok(/CONFIRMATION_REQUIRED/.test(capturedStderr()), `stderr: ${capturedStderr()}`);
  });

  it("projects delete <id> --confirm proceeds and DELETEs the project", async () => {
    await seedActiveProject();
    const { run } = await import("./cli/lib/projects.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildSpyFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("delete", ["prj_test123", "--confirm"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw, null, `should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const del = calls.find(c => c.method === "DELETE" && c.path === "/projects/v1/prj_test123");
    assert.ok(del, `must issue DELETE /projects/v1/prj_test123, calls: ${JSON.stringify(calls)}`);
    assert.ok(/deleted/.test(capturedStdout()), `stdout should confirm deletion, got: ${capturedStdout()}`);
  });

  it("subdomains delete <name> (no --confirm) refuses and does not call gateway", async () => {
    await seedActiveProject();
    const { run } = await import("./cli/lib/subdomains.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildSpyFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("delete", ["my-app"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw?.message, "process.exit(1)", "must exit non-zero");
    assert.equal(calls.filter(c => c.method === "DELETE").length, 0, "must not issue any DELETE");
    assert.ok(/CONFIRMATION_REQUIRED/.test(capturedStderr()), `stderr: ${capturedStderr()}`);
    assert.ok(/--confirm/.test(capturedStderr()), `stderr: ${capturedStderr()}`);
  });

  it("subdomains delete <name> --confirm proceeds and DELETEs the subdomain", async () => {
    await seedActiveProject();
    const { run } = await import("./cli/lib/subdomains.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildSpyFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("delete", ["my-app", "--confirm"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw, null, `should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const del = calls.find(c => c.method === "DELETE" && c.path.startsWith("/subdomains/v1/"));
    assert.ok(del, `must issue DELETE /subdomains/v1/my-app, calls: ${JSON.stringify(calls)}`);
  });

  it("domains delete <domain> (no --confirm) refuses and does not call gateway", async () => {
    await seedActiveProject();
    const { run } = await import("./cli/lib/domains.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildSpyFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("delete", ["example.com"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw?.message, "process.exit(1)", "must exit non-zero");
    assert.equal(calls.filter(c => c.method === "DELETE").length, 0, "must not issue any DELETE");
    assert.ok(/CONFIRMATION_REQUIRED/.test(capturedStderr()), `stderr: ${capturedStderr()}`);
    assert.ok(/--confirm/.test(capturedStderr()), `stderr: ${capturedStderr()}`);
  });

  it("domains delete <domain> --confirm proceeds and DELETEs the domain", async () => {
    await seedActiveProject();
    const { run } = await import("./cli/lib/domains.mjs");
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = buildSpyFetch(calls);
    let threw = null;
    captureStart();
    try {
      await run("delete", ["example.com", "--confirm"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      globalThis.fetch = prevFetch;
    }
    assert.equal(threw, null, `should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const del = calls.find(c => c.method === "DELETE" && c.path.startsWith("/domains/v1/"));
    assert.ok(del, `must issue DELETE /domains/v1/example.com, calls: ${JSON.stringify(calls)}`);
  });
});

// ── init <rail> --switch-rail guard (GH-210) ────────────────────────────────
// `run402 init mpp` (or `init` with x402 default) must NOT silently switch the
// persisted payment rail when the existing allowance is on the other rail.
// Switching is destructive in the sense that it changes which network the
// agent's autonomous payments will land on; it must be explicit.

describe("CLI init rail-switch guard (GH-210)", () => {
  async function seedAllowance(rail) {
    const { saveAllowance } = await import("./cli/lib/config.mjs");
    saveAllowance({
      address: "0x1234567890123456789012345678901234567890",
      privateKey: "0x" + "11".repeat(32),
      created: "2026-01-01T00:00:00.000Z",
      funded: true,
      rail,
    });
  }

  async function clearAllowance() {
    const { ALLOWANCE_FILE } = await import("./cli/lib/config.mjs");
    try { rmSync(ALLOWANCE_FILE, { force: true }); } catch {}
  }

  it("init mpp (no flag) on x402 allowance refuses and leaves rail unchanged", async () => {
    await seedAllowance("x402");
    const { ALLOWANCE_FILE } = await import("./cli/lib/config.mjs");
    const before = JSON.parse(readFileSync(ALLOWANCE_FILE, "utf8"));
    const { run } = await import("./cli/lib/init.mjs");
    let threw = null;
    captureStart();
    try {
      await run(["mpp"]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)", "must exit non-zero");
    const stderr = capturedStderr();
    const line = stderr.split("\n").find((s) => s.trim().startsWith("{"));
    assert.ok(line, `expected JSON envelope on stderr, got: ${stderr}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.code, "RAIL_SWITCH_REQUIRES_CONFIRM");
    assert.ok(/--switch-rail/.test(parsed.message), `message should mention --switch-rail, got: ${parsed.message}`);
    assert.equal(parsed.details?.current_rail, "x402");
    assert.equal(parsed.details?.requested_rail, "mpp");
    const after = JSON.parse(readFileSync(ALLOWANCE_FILE, "utf8"));
    assert.equal(after.rail, before.rail, "allowance.rail must NOT change without --switch-rail");
    assert.equal(after.address, before.address, "allowance.address must not change");
  });

  it("init mpp --switch-rail on x402 allowance proceeds and updates rail", async () => {
    await seedAllowance("x402");
    const { run } = await import("./cli/lib/init.mjs");
    let threw = null;
    captureStart();
    try {
      await run(["mpp", "--switch-rail"]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw, null, `should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const { ALLOWANCE_FILE } = await import("./cli/lib/config.mjs");
    const after = JSON.parse(readFileSync(ALLOWANCE_FILE, "utf8"));
    assert.equal(after.rail, "mpp", "rail should be updated to mpp");
    const out = captured();
    assert.ok(/Switched from x402/.test(out), `should retain "Switched from x402" UX note, got: ${out}`);
  });

  it("init x402 on x402 allowance is idempotent (no flag needed)", async () => {
    await seedAllowance("x402");
    const { run } = await import("./cli/lib/init.mjs");
    let threw = null;
    captureStart();
    try {
      await run([]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw, null, `same-rail re-run should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const { ALLOWANCE_FILE } = await import("./cli/lib/config.mjs");
    const after = JSON.parse(readFileSync(ALLOWANCE_FILE, "utf8"));
    assert.equal(after.rail, "x402", "rail should remain x402");
  });

  it("init mpp on mpp allowance is idempotent (no flag needed)", async () => {
    await seedAllowance("mpp");
    const { run } = await import("./cli/lib/init.mjs");
    let threw = null;
    captureStart();
    try {
      await run(["mpp"]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw, null, `same-rail re-run should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const { ALLOWANCE_FILE } = await import("./cli/lib/config.mjs");
    const after = JSON.parse(readFileSync(ALLOWANCE_FILE, "utf8"));
    assert.equal(after.rail, "mpp", "rail should remain mpp");
  });

  it("init mpp with no existing allowance succeeds (no rail to switch from)", async () => {
    await clearAllowance();
    const { run } = await import("./cli/lib/init.mjs");
    let threw = null;
    captureStart();
    try {
      await run(["mpp"]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw, null, `fresh init should succeed, got: ${threw?.message || ""} / ${capturedStderr()}`);
    const { ALLOWANCE_FILE } = await import("./cli/lib/config.mjs");
    const after = JSON.parse(readFileSync(ALLOWANCE_FILE, "utf8"));
    assert.equal(after.rail, "mpp", "fresh allowance should be created with rail=mpp");
  });

  it("init x402 (default) on mpp allowance refuses and leaves rail unchanged", async () => {
    await seedAllowance("mpp");
    const { ALLOWANCE_FILE } = await import("./cli/lib/config.mjs");
    const before = JSON.parse(readFileSync(ALLOWANCE_FILE, "utf8"));
    const { run } = await import("./cli/lib/init.mjs");
    let threw = null;
    captureStart();
    try {
      await run([]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)", "must exit non-zero");
    const stderr = capturedStderr();
    const line = stderr.split("\n").find((s) => s.trim().startsWith("{"));
    assert.ok(line, `expected JSON envelope on stderr, got: ${stderr}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.code, "RAIL_SWITCH_REQUIRES_CONFIRM");
    assert.equal(parsed.details?.current_rail, "mpp");
    assert.equal(parsed.details?.requested_rail, "x402");
    const after = JSON.parse(readFileSync(ALLOWANCE_FILE, "utf8"));
    assert.equal(after.rail, before.rail, "allowance.rail must NOT change without --switch-rail");
  });
});

// ── Canonical error envelope migration (GH-215, GH-174, GH-191, GH-177) ────
// Every client-side validation failure emits the same shape:
// {status:"error", code, message, retryable, safe_to_retry, hint?, details?,
//  next_actions, trace_id}. Exits with code 1 (status === "ok" ? 0 : 1).

describe("CLI canonical error envelope (GH-215, GH-174)", () => {
  function parseStderrJson() {
    const stderr = capturedStderr();
    const line = stderr.split("\n").map(s => s.trim()).find(s => s.startsWith("{"));
    assert.ok(line, `expected JSON envelope on stderr, got: ${stderr}`);
    return JSON.parse(line);
  }

  it("subdomains claim with empty name emits BAD_USAGE envelope", async () => {
    const { run } = await import("./cli/lib/subdomains.mjs");
    let threw = null;
    captureStart();
    try {
      await run("claim", [""]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)");
    const parsed = parseStderrJson();
    assert.equal(parsed.status, "error");
    assert.equal(parsed.code, "BAD_USAGE");
    assert.ok(/run402 subdomains claim/.test(parsed.hint || ""), `hint should retain usage, got: ${parsed.hint}`);
  });

  it("subdomains claim without deployment emits NO_DEPLOYMENT envelope", async () => {
    const { setActiveProjectId, saveProject } = await import("./cli/lib/config.mjs");
    saveProject("prj_no_deploy_test", { anon_key: "a", service_key: "s" });
    setActiveProjectId("prj_no_deploy_test");

    const { run } = await import("./cli/lib/subdomains.mjs");
    let threw = null;
    captureStart();
    try {
      await run("claim", ["foo"]);
    } catch (e) { threw = e; } finally {
      captureStop();
      const { removeProject } = await import("./cli/lib/config.mjs");
      removeProject("prj_no_deploy_test");
      setActiveProjectId("prj_test123");
    }
    assert.equal(threw?.message, "process.exit(1)");
    const parsed = parseStderrJson();
    assert.equal(parsed.code, "NO_DEPLOYMENT");
    assert.ok(Array.isArray(parsed.next_actions), "next_actions should be an array");
    assert.deepEqual(parsed.next_actions, [{ action: "deploy_site_first" }],
      `next_actions should populate with deploy_site_first, got: ${JSON.stringify(parsed.next_actions)}`);
  });

  it("domains add with no args emits BAD_USAGE envelope with usage hint", async () => {
    const { run } = await import("./cli/lib/domains.mjs");
    let threw = null;
    captureStart();
    try {
      await run("add", []);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)");
    const parsed = parseStderrJson();
    assert.equal(parsed.status, "error");
    assert.equal(parsed.code, "BAD_USAGE");
    assert.ok(/run402 domains add/.test(parsed.hint || ""), `hint should mention usage, got: ${parsed.hint}`);
  });

  it("blob put with unknown local project emits PROJECT_NOT_FOUND with details.source: local_registry", async () => {
    const { run } = await import("./cli/lib/blob.mjs");
    const tmpFile = join(tempDir, "blob-put-canary.bin");
    const { writeFileSync: wf } = await import("node:fs");
    wf(tmpFile, "x");
    let threw = null;
    captureStart();
    try {
      await run("put", [tmpFile, "--project", "prj_xxx_unknown"]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)");
    const parsed = parseStderrJson();
    assert.equal(parsed.status, "error");
    assert.equal(parsed.code, "PROJECT_NOT_FOUND");
    assert.equal(parsed.details?.project_id, "prj_xxx_unknown");
    assert.equal(parsed.details?.source, "local_registry",
      `must distinguish local-registry miss from gateway 404, got: ${JSON.stringify(parsed.details)}`);
  });
});

describe("CLI status exit codes (GH-191)", () => {
  it("status with no allowance exits 1 with status: no_allowance", async () => {
    const { ALLOWANCE_FILE } = await import("./cli/lib/config.mjs");
    try { rmSync(ALLOWANCE_FILE, { force: true }); } catch {}
    const { run } = await import("./cli/lib/status.mjs");
    let threw = null;
    captureStart();
    try {
      await run([]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)",
      "status with no allowance must exit 1 (status !== 'ok' rule), got: " + (threw?.message || "no exit"));
    const stdout = capturedStdout();
    const line = stdout.split("\n").find(s => s.trim().startsWith("{"));
    assert.ok(line, `should emit status payload on stdout, got: ${stdout}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "no_allowance",
      `payload status should remain 'no_allowance' for shell sentinels, got: ${parsed.status}`);
  });

  it("allowance status with no allowance exits 1 with status: no_wallet", async () => {
    const { ALLOWANCE_FILE } = await import("./cli/lib/config.mjs");
    try { rmSync(ALLOWANCE_FILE, { force: true }); } catch {}
    const { run } = await import("./cli/lib/allowance.mjs");
    let threw = null;
    captureStart();
    try {
      await run("status", []);
    } catch (e) { threw = e; } finally {
      captureStop();
      // Restore the allowance for any following test that expects it set.
      const { saveAllowance } = await import("./cli/lib/config.mjs");
      saveAllowance({
        address: "0x1234567890123456789012345678901234567890",
        privateKey: "0x" + "11".repeat(32),
        created: "2026-01-01T00:00:00.000Z",
        funded: true,
        rail: "x402",
      });
    }
    assert.equal(threw?.message, "process.exit(1)",
      "allowance status with no wallet must exit 1, got: " + (threw?.message || "no exit"));
  });
});

describe("CLI contracts JSON-flag parse errors (GH-177)", () => {
  function parseStderrJson() {
    const stderr = capturedStderr();
    const line = stderr.split("\n").map(s => s.trim()).find(s => s.startsWith("{"));
    assert.ok(line, `expected JSON envelope on stderr, got: ${stderr}`);
    return JSON.parse(line);
  }

  it("contracts call --abi 'not json' names the offending flag", async () => {
    const { saveProject } = await import("./cli/lib/config.mjs");
    saveProject("prj_contracts_test", { anon_key: "a", service_key: "s" });
    const { run } = await import("./cli/lib/contracts.mjs");
    let threw = null;
    captureStart();
    try {
      await run("call", [
        "prj_contracts_test", "cwlt_xyz",
        "--to", "0xabc",
        "--abi", "not json",
        "--fn", "ping",
        "--args", "[]",
      ]);
    } catch (e) { threw = e; } finally {
      captureStop();
      const { removeProject } = await import("./cli/lib/config.mjs");
      removeProject("prj_contracts_test");
    }
    assert.equal(threw?.message, "process.exit(1)");
    const parsed = parseStderrJson();
    assert.equal(parsed.code, "BAD_JSON_FLAG");
    assert.equal(parsed.details?.flag, "--abi",
      `must name the offending flag, got: ${JSON.stringify(parsed.details)}`);
    assert.ok(parsed.details?.value_preview, "must include value_preview");
    assert.ok(parsed.details?.parse_error, "must include parse_error");
  });

  it("contracts read --abi '{garbage' names --abi (first bad flag wins)", async () => {
    const { run } = await import("./cli/lib/contracts.mjs");
    let threw = null;
    captureStart();
    try {
      await run("read", [
        "--chain", "base-sepolia",
        "--to", "0xabc",
        "--abi", "{garbage",
        "--fn", "ping",
        "--args", "[]",
      ]);
    } catch (e) { threw = e; } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)");
    const parsed = parseStderrJson();
    assert.equal(parsed.code, "BAD_JSON_FLAG");
    assert.equal(parsed.details?.flag, "--abi",
      `with both --abi and --args potentially bad, --abi parses first and wins; got: ${JSON.stringify(parsed.details)}`);
  });
});
