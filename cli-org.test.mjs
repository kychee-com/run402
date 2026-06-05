// CLI arg-wiring tests for the org + grants command groups (phase 2 —
// org-owned control plane). The SDK request-building is unit-tested in
// sdk/src/namespaces/{org,grants}.test.ts; here we verify the thin CLI shim
// maps flags + positional args to the right SDK call (role flag, positional
// order, grants --policy/--expires).

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-org-cli-"));
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

let calls = [];
let stdout = [];
let runOrg;
let runGrants;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

async function mockFetch(input, init) {
  // The Node SDK's x402-wrapped fetch may pass either (urlString, init) or a
  // Request object — handle both so body/method/url assertions are reliable.
  let url, method, body;
  if (typeof Request !== "undefined" && input instanceof Request) {
    url = input.url;
    method = (init?.method || input.method || "GET").toUpperCase();
    const raw = init?.body ?? (await input.clone().text());
    body = raw ? safeJson(String(raw)) : null;
  } else {
    url = typeof input === "string" ? input : String(input);
    method = (init?.method || "GET").toUpperCase();
    body = init?.body ? safeJson(String(init.body)) : null;
  }
  calls.push({ url, method, body });
  // Echo-style canned responses; shape doesn't matter for these wiring assertions.
  if (method === "DELETE") return Promise.resolve(json({ status: "revoked" }));
  if (url.endsWith("/grants") && method === "POST") {
    return Promise.resolve(json({ status: "ok", grant_id: "grt_1", principal_id: "prn_1" }, 201));
  }
  if (url.endsWith("/members") && method === "POST") {
    return Promise.resolve(json({ status: "ok", principal_id: "prn_1", role: body?.role ?? "developer" }, 201));
  }
  if (method === "PATCH") {
    return Promise.resolve(json({ status: "ok", principal_id: "prn_2", role: body?.role }));
  }
  if (url.endsWith("/whoami")) {
    return Promise.resolve(json({ principal: { id: "prn_1", type: "human", display_name: null }, memberships: [], authenticator_id: "auth_1" }));
  }
  if (url.endsWith("/orgs/v1")) return Promise.resolve(json({ orgs: [] }));
  if (url.endsWith("/members")) return Promise.resolve(json({ members: [] }));
  return Promise.resolve(json({}));
}

function capture() { stdout = []; console.log = (...a) => stdout.push(a.join(" ")); console.error = () => {}; }
function uncapture() { console.log = originalLog; console.error = originalError; }
function writeAllowance() {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "allowance.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
}

before(async () => {
  writeAllowance();
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  ({ run: runOrg } = await import("./cli/lib/org.mjs"));
  ({ run: runGrants } = await import("./cli/lib/grants.mjs"));
});

after(() => {
  uncapture();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => { calls = []; });

function lastCall() { return calls[calls.length - 1]; }

describe("run402 org", () => {
  it("whoami GETs /agent/v1/whoami with local SIWX", async () => {
    capture();
    await runOrg("whoami", []);
    uncapture();
    assert.equal(lastCall().url, `${API}/agent/v1/whoami`);
    assert.equal(lastCall().method, "GET");
    assert.match(stdout.join("\n"), /"principal"/);
  });

  it("list GETs /orgs/v1", async () => {
    capture(); await runOrg("list", []); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1`);
  });

  it("members GETs the members route", async () => {
    capture(); await runOrg("members", ["ba_1"]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/ba_1/members`);
    assert.equal(lastCall().method, "GET");
  });

  it("add-member POSTs { wallet } and omits role by default", async () => {
    capture(); await runOrg("add-member", ["ba_1", TEST_ADDRESS]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/ba_1/members`);
    assert.equal(lastCall().method, "POST");
    assert.deepEqual(lastCall().body, { wallet: TEST_ADDRESS });
  });

  it("add-member maps --role into the body", async () => {
    capture(); await runOrg("add-member", ["ba_1", TEST_ADDRESS, "--role", "admin"]); uncapture();
    assert.deepEqual(lastCall().body, { wallet: TEST_ADDRESS, role: "admin" });
  });

  it("set-role PATCHes .../members/:principal with positional order (ba, principal, role)", async () => {
    capture(); await runOrg("set-role", ["ba_1", "prn_2", "owner"]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/ba_1/members/prn_2`);
    assert.equal(lastCall().method, "PATCH");
    assert.deepEqual(lastCall().body, { role: "owner" });
  });

  it("remove-member DELETEs .../members/:principal", async () => {
    capture(); await runOrg("remove-member", ["ba_1", "prn_2"]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/ba_1/members/prn_2`);
    assert.equal(lastCall().method, "DELETE");
  });

  it("members without an arg fails locally (no network call)", async () => {
    capture();
    await assert.rejects(runOrg("members", []), (e) => /process\.exit\(1\)/.test(e.message));
    uncapture();
    assert.equal(calls.length, 0);
  });
});

describe("run402 grants", () => {
  it("create POSTs wallet + capability (positional order)", async () => {
    capture(); await runGrants("create", ["prj_1", TEST_ADDRESS, "deploy"]); uncapture();
    assert.equal(lastCall().url, `${API}/projects/v1/prj_1/grants`);
    assert.equal(lastCall().method, "POST");
    assert.deepEqual(lastCall().body, { wallet: TEST_ADDRESS, capability: "deploy" });
  });

  it("create maps --expires → expires_at and --policy JSON → policy", async () => {
    capture();
    await runGrants("create", ["prj_1", TEST_ADDRESS, "functions:write", "--policy", '{"paths":["/api/*"]}', "--expires", "2026-12-31T00:00:00Z"]);
    uncapture();
    assert.deepEqual(lastCall().body, {
      wallet: TEST_ADDRESS,
      capability: "functions:write",
      policy: { paths: ["/api/*"] },
      expires_at: "2026-12-31T00:00:00Z",
    });
  });

  it("revoke DELETEs the grant route", async () => {
    capture(); await runGrants("revoke", ["prj_1", "grt_1"]); uncapture();
    assert.equal(lastCall().url, `${API}/projects/v1/prj_1/grants/grt_1`);
    assert.equal(lastCall().method, "DELETE");
  });
});
