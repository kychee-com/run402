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

  // Faucet
  if (path === "/faucet/v1" && method === "POST") {
    return Promise.resolve(json({ tx_hash: "0xabc123", amount: "250000", token: "USDC", network: "base-sepolia" }));
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

  // RLS
  if (path.match(/\/rls$/) && method === "POST") {
    return Promise.resolve(json({ status: "ok", tables_updated: 1 }));
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

  // Bundle deploy
  if (path === "/deploy/v1" && method === "POST") {
    const migrations_result = body?.migrations
      ? { tables_created: ["items"], columns_added: [], status: "applied" }
      : undefined;
    return Promise.resolve(json({
      project_id: TEST_PROJECT.project_id,
      ...(migrations_result && { migrations_result }),
      site_url: "https://test.sites.run402.com",
      subdomain_url: "https://test-app.run402.com",
    }));
  }

  // Deployments (sites)
  if (path === "/deployments/v1" && method === "POST") {
    return Promise.resolve(json({
      deployment_id: "dpl_test456", url: "https://dpl_test456.sites.run402.com",
    }));
  }
  if (path.match(/^\/deployments\/v1\//) && method === "GET") {
    return Promise.resolve(json({ id: "dpl_test456", status: "live", url: "https://dpl_test456.sites.run402.com" }));
  }

  // Subdomains
  if (path === "/subdomains/v1" && method === "POST") {
    return Promise.resolve(json({ name: "my-app", url: "https://my-app.run402.com", deployment_id: "dpl_test456" }, 201));
  }
  if (path === "/subdomains/v1" && method === "GET") {
    return Promise.resolve(json([{ name: "my-app", url: "https://my-app.run402.com" }]));
  }
  if (path.match(/^\/subdomains\/v1\//) && method === "DELETE") {
    return Promise.resolve(json({ status: "ok" }));
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
  // Also route deploy.mjs's undici.fetch path through the same mock — the
  // CLI deploy no longer uses globalThis.fetch (it uses undici.fetch so its
  // custom dispatcher is honored), so we inject the mock via its test seam.
  const { _setFetchImpl } = await import("./cli/lib/deploy.mjs");
  _setFetchImpl(mockFetch);
  // Override process.exit to throw
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
});

after(async () => {
  globalThis.fetch = originalFetch;
  const { _setFetchImpl } = await import("./cli/lib/deploy.mjs");
  _setFetchImpl(null);
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

  it("projects rls", async () => {
    const { run } = await import("./cli/lib/projects.mjs");
    captureStart();
    await run("rls", ["prj_test123", "public_read", '[{"table":"items"}]']);
    captureStop();
    assert.ok(captured().includes("ok"), "should apply RLS");
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

  it("deploy surfaces HTML gateway errors without SyntaxError (GH-28)", async () => {
    const deployMod = await import("./cli/lib/deploy.mjs");
    const { run, _setFetchImpl } = deployMod;
    const { writeFileSync: wf } = await import("node:fs");
    const manifestPath = join(tempDir, "html-err-manifest.json");
    wf(manifestPath, JSON.stringify({
      files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
    }));
    // Replace deploy's fetch with a stub that returns HTML 504 on /deploy/v1.
    // Note: globalThis.fetch cannot intercept undici.fetch, so we inject via
    // the module's test seam.
    _setFetchImpl((input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (url.endsWith("/deploy/v1") && method === "POST") {
        const html = "<html><head></head><body>504 Gateway Timeout</body></html>";
        return Promise.resolve(new Response(html, {
          status: 504,
          headers: { "Content-Type": "text/html" },
        }));
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    let threw = null;
    captureStart();
    try {
      await run(["--manifest", manifestPath, "--project", "prj_test123"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      _setFetchImpl(mockFetch);
    }
    const out = captured();
    // process.exit stub throws, so we expect a non-zero exit.
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message), `should exit non-zero, got: ${threw && threw.message}`);
    // Output must NOT contain the raw SyntaxError / tokeniser complaint.
    assert.ok(!/SyntaxError/i.test(out), `must not leak SyntaxError, got: ${out}`);
    assert.ok(!/Unexpected token/i.test(out), `must not leak JSON parser message, got: ${out}`);
    // Output must be a JSON line with structured fields.
    const line = out.split("\n").map(s => s.trim()).find(s => s.startsWith("{") && s.endsWith("}"));
    assert.ok(line, `should emit a JSON error line, got: ${out}`);
    const parsed = JSON.parse(line);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.http, 504);
    assert.ok(/text\/html/.test(parsed.content_type || ""), `content_type should be text/html, got: ${parsed.content_type}`);
    assert.ok(typeof parsed.body_preview === "string" && parsed.body_preview.length > 0, "body_preview should be non-empty string");
    assert.ok(parsed.body_preview.includes("504 Gateway Timeout"), `body_preview should include the HTML body, got: ${parsed.body_preview}`);
    assert.ok(parsed.body_preview.length <= 500, `body_preview should be truncated to <=500 chars, got length ${parsed.body_preview.length}`);
  });

  it("deploy retries on UND_ERR_HEADERS_TIMEOUT and succeeds (GH-29)", async () => {
    const { run, _setFetchImpl } = await import("./cli/lib/deploy.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    const manifestPath = join(tempDir, "retry-headers-timeout-manifest.json");
    wf(manifestPath, JSON.stringify({
      files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
    }));
    let attempts = 0;
    _setFetchImpl((input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (url.endsWith("/deploy/v1") && method === "POST") {
        attempts++;
        if (attempts === 1) {
          const err = new TypeError("fetch failed");
          err.cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
          return Promise.reject(err);
        }
        return Promise.resolve(new Response(JSON.stringify({ project_id: "prj_test123", site_url: "https://x" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    captureStart();
    try {
      await run(["--manifest", manifestPath, "--project", "prj_test123"]);
    } finally {
      captureStop();
      _setFetchImpl(mockFetch);
    }
    const out = captured();
    assert.equal(attempts, 2, `should retry once after UND_ERR_HEADERS_TIMEOUT, got ${attempts} attempts`);
    assert.ok(out.includes("prj_test123"), `should return project info after retry, got: ${out}`);
  });

  it("deploy retries on HTTP 503 and succeeds (GH-29)", async () => {
    const { run, _setFetchImpl } = await import("./cli/lib/deploy.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    const manifestPath = join(tempDir, "retry-503-manifest.json");
    wf(manifestPath, JSON.stringify({
      files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
    }));
    let attempts = 0;
    _setFetchImpl((input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (url.endsWith("/deploy/v1") && method === "POST") {
        attempts++;
        if (attempts === 1) {
          return Promise.resolve(new Response("Service Unavailable", {
            status: 503, headers: { "Content-Type": "text/plain" },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify({ project_id: "prj_test123", site_url: "https://x" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    captureStart();
    try {
      await run(["--manifest", manifestPath, "--project", "prj_test123"]);
    } finally {
      captureStop();
      _setFetchImpl(mockFetch);
    }
    const out = captured();
    assert.equal(attempts, 2, `should retry once after 503, got ${attempts} attempts`);
    assert.ok(out.includes("prj_test123"), `should return project info after retry, got: ${out}`);
  });

  it("deploy does NOT retry on HTTP 400 (GH-29)", async () => {
    const { run, _setFetchImpl } = await import("./cli/lib/deploy.mjs");
    const { writeFileSync: wf } = await import("node:fs");
    const manifestPath = join(tempDir, "no-retry-400-manifest.json");
    wf(manifestPath, JSON.stringify({
      files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
    }));
    let attempts = 0;
    _setFetchImpl((input, init) => {
      const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (url.endsWith("/deploy/v1") && method === "POST") {
        attempts++;
        return Promise.resolve(new Response(JSON.stringify({ error: "bad request" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    let threw = null;
    captureStart();
    try {
      await run(["--manifest", manifestPath, "--project", "prj_test123"]);
    } catch (e) {
      threw = e;
    } finally {
      captureStop();
      _setFetchImpl(mockFetch);
    }
    assert.equal(attempts, 1, `should NOT retry on 400, got ${attempts} attempts`);
    assert.ok(threw && /process\.exit\(1\)/.test(threw.message), "should exit non-zero on 400");
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

  // ── Storage ─────────────────────────────────────────────────────────────

  it("storage upload", async () => {
    const { run } = await import("./cli/lib/storage.mjs");
    const filePath = join(tempDir, "readme.txt");
    const { writeFileSync: wf } = await import("node:fs");
    wf(filePath, "Hello, world!");
    captureStart();
    await run("upload", ["prj_test123", "assets", "readme.txt", "--file", filePath]);
    captureStop();
    assert.ok(captured().includes("readme.txt") || captured().includes("key"), "should upload file");
  });

  it("storage list", async () => {
    const { run } = await import("./cli/lib/storage.mjs");
    captureStart();
    await run("list", ["prj_test123", "assets"]);
    captureStop();
    assert.ok(captured().includes("readme.txt"), "should list files");
  });

  it("storage download", async () => {
    const { run } = await import("./cli/lib/storage.mjs");
    captureStart();
    await run("download", ["prj_test123", "assets", "readme.txt"]);
    captureStop();
    // download uses process.stdout.write, not console.log — just verify no error
    assert.ok(true, "should download without error");
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

  it("sites status", async () => {
    const { run } = await import("./cli/lib/sites.mjs");
    captureStart();
    await run("status", ["dpl_test456"]);
    captureStop();
    assert.ok(captured().includes("live"), "should show deployment status");
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

  // ── Cleanup commands (deletions) ────────────────────────────────────────

  it("storage delete", async () => {
    const { run } = await import("./cli/lib/storage.mjs");
    captureStart();
    await run("delete", ["prj_test123", "assets", "readme.txt"]);
    captureStop();
    assert.ok(captured().includes("ok") || captured().includes("delete"), "should delete file");
  });

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
    await run("delete", ["my-app", "--project", "prj_test123"]);
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
    await run("delete", ["prj_test123"]);
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
    await run(["mpp"]);
    captureStop();
    const out = captured();
    assert.ok(out.includes("Tempo"), "should show Tempo network");
    assert.ok(out.includes("pathUSD"), "should show pathUSD");
    assert.ok(out.includes("mpp"), "should show mpp rail");
    // Verify rail saved
    const allowance = JSON.parse(readFileSync(join(tempDir, "allowance.json"), "utf-8"));
    assert.equal(allowance.rail, "mpp", "rail should be mpp");
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
    await run([]);
    captureStop();
    const out = captured();
    assert.ok(out.includes("Base Sepolia"), "should show Base Sepolia network");
    assert.ok(out.includes("x402"), "should show x402 rail");
    // Verify rail switched back
    const allowance = JSON.parse(readFileSync(join(tempDir, "allowance.json"), "utf-8"));
    assert.equal(allowance.rail, "x402", "rail should be x402");
  });
});
