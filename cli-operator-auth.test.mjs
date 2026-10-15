// Operator auth-mode tests — the `--operator` global flag and the
// RUN402_AUTH_MODE=operator env var must force the human operator's
// control-plane Bearer instead of the active wallet's SIWX allowance, even when
// a wallet allowance IS present.
//
// Background (kychee-com/run402 issue #470): owner-only control-plane mutations
// (e.g. `run402 org member add`) are authorized by the operator's org role, not
// the wallet. In the default `auto` credential mode the resolver signs with the
// wallet whenever an allowance exists, so the request goes out as the wallet
// principal and the gateway returns 403. `--operator` / RUN402_AUTH_MODE=operator
// selects the cached control-plane session instead.
//
// Strategy: in-process, like cli-org.test.mjs — seed BOTH a wallet allowance and
// a live control-plane session, mock globalThis.fetch to capture request
// headers, and assert which credential family rides the org-member-add request.
// A separate subprocess case covers the BAD_ENV fast-fail on an invalid mode.

import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const __dirname = dirname(fileURLToPath(import.meta.url));

const tempDir = mkdtempSync(join(tmpdir(), "run402-operator-auth-"));
const configDir = join(tempDir, "config");
const API = "https://test-api.run402.com";

process.env.RUN402_CONFIG_DIR = configDir;
process.env.RUN402_API_BASE = API;
// Pin the control-plane session path explicitly so the test never depends on
// profile-dir resolution nuances.
const CPS_PATH = join(configDir, "control-plane-session.json");
process.env.RUN402_CONTROL_PLANE_SESSION_PATH = CPS_PATH;

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CPS_TOKEN = "cps_operator_test_token";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

let calls = [];
let runOrg;
let splitOperatorFlag;
let applyAuthModeSelection;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Normalize headers from either a Request object or an (input, init) pair. */
function headersOf(input, init) {
  const h = new Headers();
  if (typeof Request !== "undefined" && input instanceof Request) {
    for (const [k, v] of input.headers) h.set(k, v);
  }
  if (init?.headers) {
    for (const [k, v] of new Headers(init.headers)) h.set(k, v);
  }
  return h;
}

async function mockFetch(input, init) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method || (input && input.method) || "GET").toUpperCase();
  const headers = headersOf(input, init);
  calls.push({ url, method, headers });
  // Org-member routes — the wiring under test. Everything else (incl. viem RPC
  // balance probes from the x402 paid-fetch setup) gets a benign JSON object.
  if (url.includes("/members") && method === "POST") {
    return Promise.resolve(json({ status: "ok", principal_id: "prn_1", role: "admin" }, 201));
  }
  return Promise.resolve(json({}));
}

/** The org-member-add request (the credential-bearing call we assert on). */
function memberAddCall() {
  return calls.find((c) => c.url.includes("/members") && c.method === "POST");
}

function seedWalletAllowance() {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "allowance.json"),
    JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY }),
  );
}

function seedControlPlaneSession() {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    CPS_PATH,
    JSON.stringify({
      control_plane_session_token: CPS_TOKEN,
      token_type: "Bearer",
      provenance: "loopback_pkce",
      principal_id: "prn_operator",
      amr: ["passkey"],
      // Far-future epoch ms so the session is never treated as expired.
      expires_at: 9999999999999,
    }),
    { mode: 0o600 },
  );
}

before(async () => {
  seedWalletAllowance();
  seedControlPlaneSession();
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  console.log = () => {};
  console.error = () => {};
  ({ run: runOrg } = await import("./cli/lib/org.mjs"));
  ({ splitOperatorFlag, applyAuthModeSelection } = await import("./cli/lib/auth-mode.mjs"));
});

after(() => {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  delete process.env.RUN402_CONTROL_PLANE_SESSION_PATH;
  delete process.env.RUN402_AUTH_MODE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => { calls = []; });
afterEach(() => { delete process.env.RUN402_AUTH_MODE; });

// ── Pure edge helper ──────────────────────────────────────────────────────────

describe("auth-mode edge helpers", () => {
  it("splitOperatorFlag strips --operator and reports it (boolean, no value)", () => {
    const { argv, operator } = splitOperatorFlag(["org", "member", "add", "org_1", TEST_ADDRESS, "--operator"]);
    assert.equal(operator, true);
    assert.deepEqual(argv, ["org", "member", "add", "org_1", TEST_ADDRESS]);
  });

  it("splitOperatorFlag accepts the --as-operator alias", () => {
    const { argv, operator } = splitOperatorFlag(["--as-operator", "org", "list"]);
    assert.equal(operator, true);
    assert.deepEqual(argv, ["org", "list"]);
  });

  it("splitOperatorFlag leaves argv untouched when the flag is absent", () => {
    const { argv, operator } = splitOperatorFlag(["org", "list"]);
    assert.equal(operator, false);
    assert.deepEqual(argv, ["org", "list"]);
  });

  it("applyAuthModeSelection publishes RUN402_AUTH_MODE=operator on a scratch env", () => {
    const env = {};
    const { argv, operator } = applyAuthModeSelection({ rawArgv: ["org", "list", "--operator"], env });
    assert.equal(operator, true);
    assert.equal(env.RUN402_AUTH_MODE, "operator");
    assert.deepEqual(argv, ["org", "list"]);
  });

  it("applyAuthModeSelection does not set the env when the flag is absent", () => {
    const env = {};
    const { operator } = applyAuthModeSelection({ rawArgv: ["org", "list"], env });
    assert.equal(operator, false);
    assert.equal(env.RUN402_AUTH_MODE, undefined);
  });
});

// ── Credential family on the wire ─────────────────────────────────────────────

describe("operator mode forces the control-plane Bearer (wallet present)", () => {
  it("default (auto) mode signs org member add with the wallet allowance, not the Bearer", async () => {
    await runOrg("member", ["add", "org_1", TEST_ADDRESS, "--role", "admin"]);
    const call = memberAddCall();
    assert.ok(call, "expected a POST .../members request");
    assert.ok(call.headers.get("sign-in-with-x"), "auto mode with a wallet must send the SIGN-IN-WITH-X header");
    assert.equal(call.headers.get("authorization"), null, "auto mode must NOT send a control-plane Bearer");
  });

  it("RUN402_AUTH_MODE=operator sends the control-plane Bearer and NO wallet header", async () => {
    process.env.RUN402_AUTH_MODE = "operator";
    await runOrg("member", ["add", "org_1", TEST_ADDRESS, "--role", "admin"]);
    const call = memberAddCall();
    assert.ok(call, "expected a POST .../members request");
    assert.equal(call.headers.get("authorization"), `Bearer ${CPS_TOKEN}`,
      "operator mode must send the cached control-plane Bearer");
    assert.equal(call.headers.get("sign-in-with-x"), null,
      "operator mode must NOT leak the wallet SIGN-IN-WITH-X header");
  });

  it("the --operator flag (via applyAuthModeSelection) selects the Bearer too", async () => {
    // Simulate the cli.mjs edge: strip the flag + publish the env, then run the
    // cleaned argv.
    const { argv } = applyAuthModeSelection({
      rawArgv: ["org", "member", "add", "org_1", TEST_ADDRESS, "--role", "admin", "--operator"],
      env: process.env,
    });
    assert.equal(process.env.RUN402_AUTH_MODE, "operator");
    // argv is [cmd, sub, ...rest]; org.mjs's run(sub, rest) takes the tail.
    const [, sub, ...rest] = argv;
    await runOrg(sub, rest);
    const call = memberAddCall();
    assert.ok(call, "expected a POST .../members request");
    assert.equal(call.headers.get("authorization"), `Bearer ${CPS_TOKEN}`);
    assert.equal(call.headers.get("sign-in-with-x"), null);
  });

  it("RUN402_AUTH_MODE=wallet keeps the wallet header even with a session cached", async () => {
    process.env.RUN402_AUTH_MODE = "wallet";
    await runOrg("member", ["add", "org_1", TEST_ADDRESS, "--role", "admin"]);
    const call = memberAddCall();
    assert.ok(call, "expected a POST .../members request");
    assert.ok(call.headers.get("sign-in-with-x"), "wallet mode must send the SIGN-IN-WITH-X header");
    assert.equal(call.headers.get("authorization"), null, "wallet mode must NOT send the Bearer");
  });
});

// ── Invalid value fast-fail (subprocess: fail() calls process.exit) ───────────

describe("RUN402_AUTH_MODE validation", () => {
  it("an invalid mode fails fast with BAD_ENV before any network call", async () => {
    const subConfig = mkdtempSync(join(tmpdir(), "run402-authmode-bad-"));
    const child = spawn(process.execPath, [join(__dirname, "cli", "cli.mjs"), "org", "list"], {
      env: {
        ...process.env,
        RUN402_CONFIG_DIR: subConfig,
        HOME: subConfig,
        RUN402_API_BASE: "http://127.0.0.1:1", // unreachable; must never be hit
        RUN402_AUTH_MODE: "bogus",
        RUN402_CONTROL_PLANE_SESSION_PATH: join(subConfig, "cps.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [code] = await once(child, "exit");
    clearTimeout(killTimer);
    rmSync(subConfig, { recursive: true, force: true });

    assert.equal(code, 1, `expected exit 1, got ${code}\nstderr:\n${stderr}`);
    assert.match(stderr, /RUN402_AUTH_MODE/, `stderr must name the env var; got: ${stderr}`);
    assert.match(stderr, /BAD_ENV/, `stderr must carry the BAD_ENV code; got: ${stderr}`);
    // It must fail on validation, not on the unreachable network endpoint.
    assert.doesNotMatch(stderr, /fetch failed|ECONNREFUSED/, `must not have made a network call; got: ${stderr}`);
  });
});
