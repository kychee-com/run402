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

// `resolveOrg`'s `--org` path validates shape (a real UUID) — unlike
// `rename`'s bare positional passthrough, which never validates, so a
// short "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" fixture works there but not for `slug`.
const SLUG_ORG_ID = "11111111-2222-3333-4444-555555555555";
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const LEASE_STARTED_AT = "2026-06-19T12:00:00.000Z";
const LEASE_EXPIRES_AT = "2026-06-26T12:00:00.000Z";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

let calls = [];
let stdout = [];
let runOrg;
let runWhoami;
let runGrants;
let runProjects;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

// vault-multi-writer task 6.3 — the writer gate's two reads. A test sets
// globalThis.__orgVaults to make the org carry vaults; the record read then
// answers with a writer_set that does NOT contain this (identity-less) keystore.
async function mockFetch(input, init) {
  {
    const u = String(input?.url ?? input);
    const m = String(init?.method ?? "GET").toUpperCase();
    if (m === "GET" && u.includes("/vaults/v1?org_id=")) {
      return Promise.resolve(json({ vaults: globalThis.__orgVaults ?? [], has_more: false, next_cursor: null }));
    }
    if (m === "GET" && /\/vaults\/v1\/src_[0-9a-f]+$/.test(u)) {
      return Promise.resolve(json({
        repo_id: u.slice(u.lastIndexOf("/") + 1), org_id: "11111111-1111-4111-8111-111111111111", project_id: "prj_v1",
        writer_set: { version: "0000000000000000", sha256: "0".repeat(64), writers: [{ writer_key_id: "vk_" + "a".repeat(32), signing_pubkey: "A".repeat(43) }] },
        pending_writers: [], ineligible_members: [], read_only_terminal: false,
      }));
    }
  }
  // The Node SDK's x402-wrapped fetch may pass either (urlString, init) or a
  // Request object — handle both so body/method/url assertions are reliable.
  let url, method, body, headers;
  if (typeof Request !== "undefined" && input instanceof Request) {
    url = input.url;
    method = (init?.method || input.method || "GET").toUpperCase();
    const raw = init?.body ?? (await input.clone().text());
    body = raw ? safeJson(String(raw)) : null;
    headers = new Headers(init?.headers ?? input.headers);
  } else {
    url = typeof input === "string" ? input : String(input);
    method = (init?.method || "GET").toUpperCase();
    body = init?.body ? safeJson(String(init.body)) : null;
    headers = new Headers(init?.headers);
  }
  calls.push({ url, method, body, headers });
  // first-class-orgs (v1.82) routes — specific matches BEFORE the generic handlers below.
  if (url.endsWith("/orgs/v1") && method === "POST") {
    return Promise.resolve(json({
      org_id: "org_new",
      display_name: body?.display_name ?? null,
      tier: "prototype",
      lease_started_at: LEASE_STARTED_AT,
      lease_expires_at: LEASE_EXPIRES_AT,
    }, 201));
  }
  if (url.endsWith("/orgs/v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") && method === "GET") {
    return Promise.resolve(json({
      org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      display_name: "Kychee",
      tier: "prototype",
      lease_started_at: LEASE_STARTED_AT,
      lease_expires_at: LEASE_EXPIRES_AT,
      role: "owner",
    }));
  }
  if (url.endsWith("/orgs/v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") && method === "PATCH") {
    return Promise.resolve(json({
      org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      display_name: body?.display_name ?? null,
      tier: "prototype",
      lease_started_at: LEASE_STARTED_AT,
      lease_expires_at: LEASE_EXPIRES_AT,
    }));
  }
  if (url.endsWith(`/orgs/v1/${SLUG_ORG_ID}/slug`) && method === "POST") {
    return Promise.resolve(json({
      org_id: SLUG_ORG_ID,
      slug: body?.slug ?? null,
      previous_slug: body?.slug === "acme" ? null : "acme",
      created: body?.slug === "acme",
    }, body?.slug === "acme" ? 201 : 200));
  }
  if (url.endsWith("/orgs/v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/payout-wallet") && method === "PATCH") {
    return Promise.resolve(json({
      org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      default_payout_wallet: body?.wallet_address ?? null,
      active_wallet_count: 1,
      recovery: { status: body?.wallet_address ? "ready" : "required" },
      next_actions: [],
    }));
  }
  if (url.includes("/projects/v1/prj_1/tenant-payments") && method === "GET") {
    return Promise.resolve(json({
      payments: [
        {
          payment_id: "txp_1",
          project_id: "prj_1",
          status: "settled",
          amount_usd_micros: 250000,
          route: { method: "POST", pattern: "/api/credits" },
          created_at: "2026-07-07T12:00:00.000Z",
        },
      ],
      has_more: false,
      next_cursor: null,
    }));
  }
  if (url.endsWith("/projects/v1") && method === "POST") {
    return Promise.resolve(json({ project_id: "prj_1", anon_key: "a", service_key: "s", schema_slot: "p1" }));
  }
  // Echo-style canned responses; shape doesn't matter for these wiring assertions.
  if (method === "DELETE") return Promise.resolve(json({ status: "revoked" }));
  if (url.endsWith("/grants") && method === "POST") {
    return Promise.resolve(json({
      status: "ok",
      grant_id: "grt_1",
      principal_id: "prn_1",
      ...(body?.key ? { key: { key_id: "key_1", kind: "run402_agent_key", token: "gk_token_once", expires_at: null } } : {}),
    }, 201));
  }
  if (url.endsWith("/members") && method === "POST") {
    globalThis.__memberPosts = (globalThis.__memberPosts ?? 0) + 1;
    return Promise.resolve(json({ status: "ok", principal_id: "prn_1", role: body?.role ?? "developer" }, 201));
  }
  if (method === "PATCH") {
    return Promise.resolve(json({ status: "ok", principal_id: "prn_2", role: body?.role }));
  }
  if (url.endsWith("/whoami")) {
    return Promise.resolve(json({
      principal: { id: "prn_1", type: "human", display_name: null },
      active_authenticator: { authenticator_id: "auth_1", kind: "siwx_eoa", public_subject: TEST_ADDRESS },
      linked_identities: [],
      memberships: [],
      authenticator_id: "auth_1",
    }));
  }
  if (url.endsWith("/orgs/v1")) return Promise.resolve(json({ orgs: [] }));
  if (url.endsWith("/members")) return Promise.resolve(json({ members: [] }));
  return Promise.resolve(json({}));
}

function capture() { stdout = []; console.log = (...a) => stdout.push(a.join(" ")); console.error = () => {}; }
function uncapture() { console.log = originalLog; console.error = originalError; }
function writeWallet() {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "wallet.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }));
}

before(async () => {
  writeWallet();
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  ({ run: runOrg } = await import("./cli/lib/orgs.mjs"));
  ({ run: runWhoami } = await import("./cli/lib/whoami.mjs"));
  ({ run: runGrants } = await import("./cli/lib/grants.mjs"));
  ({ run: runProjects } = await import("./cli/lib/projects.mjs"));
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

describe("run402 orgs", () => {
  it("run402 whoami GETs /agent/v1/whoami with local SIWX", async () => {
    capture();
    await runWhoami([]);
    uncapture();
    assert.equal(lastCall().url, `${API}/agent/v1/whoami`);
    assert.equal(lastCall().method, "GET");
    const output = JSON.parse(stdout.join("\n"));
    assert.equal(output.principal.id, "prn_1");
    assert.equal(output.authenticator_id, output.active_authenticator.authenticator_id);
    assert.deepEqual(output.linked_identities, [], "an unlinked principal must render an empty list, not synthesized identity data");
  });

  it("run402 whoami --set-name PATCHes /agent/v1/me with the trimmed display_name", async () => {
    capture();
    await runWhoami(["--set-name", "  gate-agent  "]);
    uncapture();
    assert.equal(lastCall().url, `${API}/agent/v1/me`);
    assert.equal(lastCall().method, "PATCH");
    assert.deepEqual(lastCall().body, { display_name: "gate-agent" });
    const output = JSON.parse(stdout.join("\n"));
    assert.ok(Array.isArray(output.write_approvals));
  });

  it("list GETs /orgs/v1 and joins the account overview (GET /agent/v1/me/overview)", async () => {
    capture(); await runOrg("list", []); uncapture();
    const urls = calls.map((c) => c.url);
    assert.ok(urls.includes(`${API}/orgs/v1`));
    assert.ok(urls.includes(`${API}/agent/v1/me/overview`));
    const output = JSON.parse(stdout.join("\n"));
    assert.deepEqual(output.orgs, []);
    assert.equal(output.session, null);
  });

  it("members GETs the members route", async () => {
    capture(); await runOrg("members", ["list", "11111111-1111-4111-8111-111111111111"]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/11111111-1111-4111-8111-111111111111/members`);
    assert.equal(lastCall().method, "GET");
  });

  it("add-member POSTs { wallet } and omits role by default", async () => {
    capture(); await runOrg("members", ["add", "11111111-1111-4111-8111-111111111111", TEST_ADDRESS]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/11111111-1111-4111-8111-111111111111/members`);
    assert.equal(lastCall().method, "POST");
    assert.deepEqual(lastCall().body, { wallet: TEST_ADDRESS });
  });

  it("add-member maps --role into the body", async () => {
    capture(); await runOrg("members", ["add", "11111111-1111-4111-8111-111111111111", TEST_ADDRESS, "--role", "admin"]); uncapture();
    assert.deepEqual(lastCall().body, { wallet: TEST_ADDRESS, role: "admin" });
  });

  it("member add REFUSES a writer-eligible add when this session's key is not a writer on one of the org's vaults (vault-multi-writer 6.3, decided: refuse)", async () => {
    globalThis.__orgVaults = [{ repo_id: "src_" + "b".repeat(32), project_id: "prj_v1", project_name: null, repo_name: "notes", org_slug: null, vault_policy: "required", newest_generation: "5", source_bytes: "0", genesis_admitted_at: null, created_at: "2026-09-03T00:00:00.000Z" }];
    globalThis.__memberPosts = 0;
    const errs = [];
    try {
      capture();
      console.error = (...a) => errs.push(a.join(" ")); // fail() emits the envelope on stderr
      await assert.rejects(runOrg("members", ["add", "11111111-1111-4111-8111-111111111111", TEST_ADDRESS]), (e) => /process\.exit\(1\)/.test(e.message));
      uncapture();
      const out = errs.join("\n");
      assert.match(out, /VAULT_WRITER_NOT_ADMITTED/);
      assert.match(out, /request_writer_sync/);
      assert.match(out, /src_b{32}/);
      // The refusal is BEFORE the add: no POST /members ever happened.
      assert.equal(globalThis.__memberPosts, 0);
    } finally {
      delete globalThis.__orgVaults;
      uncapture();
    }
  });

  it("member add of a viewer never reaches the writer gate (nothing to admit)", async () => {
    globalThis.__orgVaults = [{ repo_id: "src_" + "b".repeat(32), project_id: "prj_v1", project_name: null, repo_name: "notes", org_slug: null, vault_policy: "required", newest_generation: "5", source_bytes: "0", genesis_admitted_at: null, created_at: "2026-09-03T00:00:00.000Z" }];
    try {
      capture(); await runOrg("members", ["add", "11111111-1111-4111-8111-111111111111", TEST_ADDRESS, "--role", "viewer"]); uncapture();
      const parsed = JSON.parse(stdout.join("\n"));
      assert.equal(parsed.role, "viewer");
    } finally {
      delete globalThis.__orgVaults;
      uncapture();
    }
  });

  it("set-role PATCHes .../members/:principal with positional order (org, principal, role)", async () => {
    capture(); await runOrg("members", ["role", "11111111-1111-4111-8111-111111111111", "prn_2", "owner"]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/11111111-1111-4111-8111-111111111111/members/prn_2`);
    assert.equal(lastCall().method, "PATCH");
    assert.deepEqual(lastCall().body, { role: "owner" });
  });

  it("remove-member DELETEs .../members/:principal", async () => {
    capture(); await runOrg("members", ["rm", "11111111-1111-4111-8111-111111111111", "prn_2"]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/11111111-1111-4111-8111-111111111111/members/prn_2`);
    assert.equal(lastCall().method, "DELETE");
  });

  it("members without an arg fails locally (no network call)", async () => {
    capture();
    await assert.rejects(runOrg("members", ["list"]), (e) => /process\.exit\(1\)/.test(e.message));
    uncapture();
    assert.equal(calls.length, 0);
  });

  // ── first-class-orgs (v1.82): create / get / rename ──────────────────────
  it("create POSTs display_name only (never a tier) and prints the new org", async () => {
    capture(); await runOrg("create", ["--name", "Kychee"]); uncapture();
    const post = calls.find((c) => c.url === `${API}/orgs/v1` && c.method === "POST");
    assert.ok(post, "should POST /orgs/v1");
    assert.deepEqual(post.body, { display_name: "Kychee" });
    assert.match(stdout.join("\n"), /"org_id": "org_new"/);
    assert.match(stdout.join("\n"), /"lease_expires_at": "2026-06-26T12:00:00.000Z"/);
  });

  it("get GETs /orgs/v1/:org and surfaces the caller role", async () => {
    capture(); await runOrg("get", ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    assert.equal(lastCall().method, "GET");
    assert.match(stdout.join("\n"), /"role": "owner"/);
    assert.match(stdout.join("\n"), /"lease_started_at": "2026-06-19T12:00:00.000Z"/);
  });

  it("rename sets a new label", async () => {
    capture(); await runOrg("rename", ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "New Name"]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    assert.equal(lastCall().method, "PATCH");
    assert.deepEqual(lastCall().body, { display_name: "New Name" });
  });

  it("rename --clear PATCHes display_name: null", async () => {
    capture(); await runOrg("rename", ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--clear"]); uncapture();
    assert.deepEqual(lastCall().body, { display_name: null });
  });

  it("slug POSTs {slug} to /orgs/v1/:org_id/slug with a generated Idempotency-Key", async () => {
    capture(); await runOrg("slug", ["acme", "--org", SLUG_ORG_ID]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/${SLUG_ORG_ID}/slug`);
    assert.equal(lastCall().method, "POST");
    assert.deepEqual(lastCall().body, { slug: "acme" });
    assert.ok(lastCall().headers.get("Idempotency-Key"), "a client-generated Idempotency-Key must be present");
    assert.match(stdout.join("\n"), /"created": true/);
  });

  it("slug rename reports created:false and names the previous slug (cooldown consequence)", async () => {
    capture(); await runOrg("slug", ["acme-hq", "--org", SLUG_ORG_ID]); uncapture();
    assert.deepEqual(lastCall().body, { slug: "acme-hq" });
    assert.match(stdout.join("\n"), /"previous_slug": "acme"/);
    assert.match(stdout.join("\n"), /"created": false/);
  });

  it("payout-wallet PATCHes wallet_address", async () => {
    capture(); await runOrg("payout-wallet", ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TEST_ADDRESS]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/payout-wallet`);
    assert.equal(lastCall().method, "PATCH");
    assert.deepEqual(lastCall().body, { wallet_address: TEST_ADDRESS });
    assert.match(stdout.join("\n"), /"default_payout_wallet":/);
  });

  it("payout-wallet --clear PATCHes wallet_address null", async () => {
    capture(); await runOrg("payout-wallet", ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--clear"]); uncapture();
    assert.equal(lastCall().url, `${API}/orgs/v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/payout-wallet`);
    assert.equal(lastCall().method, "PATCH");
    assert.deepEqual(lastCall().body, { wallet_address: null });
  });
});

describe("run402 provision --org", () => {
  it("threads org_id into POST /projects/v1", async () => {
    capture(); await runProjects("provision", ["--org", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]); uncapture();
    const post = calls.find((c) => c.url === `${API}/projects/v1` && c.method === "POST");
    assert.ok(post, "should POST /projects/v1");
    assert.equal(post.body.org_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("tenant-payments forwards filters to the redacted tenant payment listing route", async () => {
    capture();
    await runProjects("tenant-payments", ["prj_1", "--status", "settled", "--limit", "25", "--after", "cur_1"]);
    uncapture();
    const url = new URL(lastCall().url);
    assert.equal(`${url.origin}${url.pathname}`, `${API}/projects/v1/prj_1/tenant-payments`);
    assert.equal(url.searchParams.get("status"), "settled");
    assert.equal(url.searchParams.get("after"), "cur_1");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(lastCall().method, "GET");
    assert.match(stdout.join("\n"), /"payment_id": "txp_1"/);
  });
});

describe("run402 orgs adopt", () => {
  it("exits 1 with login guidance when no sign-in session is cached", async () => {
    const stderr = [];
    const origErr = console.error;
    console.log = () => {};
    console.error = (...a) => stderr.push(a.join(" "));
    let exitCode = null;
    try {
      await runOrg("adopt", []);
    } catch (e) {
      const m = /process\.exit\((\d+)\)/.exec(e.message);
      exitCode = m ? Number(m[1]) : null;
    } finally {
      console.error = origErr;
      console.log = originalLog;
    }
    assert.equal(exitCode, 1, "no sign-in session should exit 1");
    assert.match(stderr.join("\n"), /run402 login/);
  });
});

describe("run402 grants", () => {
  it("create POSTs wallet + capability", async () => {
    capture(); await runGrants("create", [TEST_ADDRESS, "--capability", "deploy", "--project", "prj_1"]); uncapture();
    assert.equal(lastCall().url, `${API}/projects/v1/prj_1/grants`);
    assert.equal(lastCall().method, "POST");
    assert.deepEqual(lastCall().body, { wallet: TEST_ADDRESS, capability: "deploy" });
  });

  it("create maps --expires-at → expires_at and --policy JSON → policy", async () => {
    capture();
    await runGrants("create", [TEST_ADDRESS, "--capability", "functions:write", "--project", "prj_1", "--policy", '{"paths":["/api/*"]}', "--expires-at", "2026-12-31T00:00:00Z"]);
    uncapture();
    assert.deepEqual(lastCall().body, {
      wallet: TEST_ADDRESS,
      capability: "functions:write",
      policy: { paths: ["/api/*"] },
      expires_at: "2026-12-31T00:00:00Z",
    });
  });

  it("create --key mints the first grant key in the same request and prints its token once", async () => {
    capture();
    await runGrants("create", [TEST_ADDRESS, "--capability", "deploy", "--project", "prj_1", "--key", "--spend-cap", '{"v":1,"currency":"usd_micros","per_period":5000000,"period":"month"}', "--expires-at", "2026-12-31T00:00:00Z"]);
    uncapture();
    assert.deepEqual(lastCall().body, {
      wallet: TEST_ADDRESS,
      capability: "deploy",
      expires_at: "2026-12-31T00:00:00Z",
      key: {
        spend_cap: { v: 1, currency: "usd_micros", per_period: 5000000, period: "month" },
        expires_at: "2026-12-31T00:00:00Z",
      },
    });
    const out = JSON.parse(stdout.join("\n"));
    assert.equal(out.key.token, "gk_token_once");
  });

  it("create refuses key-only flags without --key", async () => {
    capture();
    await assert.rejects(runGrants("create", [TEST_ADDRESS, "--capability", "deploy", "--project", "prj_1", "--scope", '{"v":1,"capabilities":["deploy"]}']), /process\.exit\(1\)/);
    uncapture();
    assert.equal(calls.length, 0);
  });

  it("list GETs the grants route", async () => {
    capture(); await runGrants("list", ["--project", "prj_1"]); uncapture();
    assert.equal(lastCall().url, `${API}/projects/v1/prj_1/grants`);
    assert.equal(lastCall().method, "GET");
  });

  it("revoke DELETEs the grant route", async () => {
    capture(); await runGrants("revoke", ["grt_1", "--project", "prj_1"]); uncapture();
    assert.equal(lastCall().url, `${API}/projects/v1/prj_1/grants/grt_1`);
    assert.equal(lastCall().method, "DELETE");
  });

  it("revoke-key DELETEs the grant-keys route", async () => {
    capture(); await runGrants("revoke-key", ["key_1", "--project", "prj_1"]); uncapture();
    assert.equal(lastCall().url, `${API}/projects/v1/prj_1/grant-keys/key_1`);
    assert.equal(lastCall().method, "DELETE");
  });

  it("rotate-key POSTs the rotate route", async () => {
    capture(); await runGrants("rotate-key", ["key_1", "--project", "prj_1"]); uncapture();
    assert.equal(lastCall().url, `${API}/projects/v1/prj_1/grant-keys/key_1/rotate`);
    assert.equal(lastCall().method, "POST");
  });
});
