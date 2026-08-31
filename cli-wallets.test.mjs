/**
 * End-to-end tests for the `run402 wallets` command family and wallet
 * selection (named profiles). Spawns the real CLI as a subprocess. Wallet
 * management is local (no network), so no fetch mocking is needed.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(repoRoot, "cli/cli.mjs");
const API = "https://test-api.run402.com";

let configDir;
let workDir;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "run402-wallets-cfg-"));
  workDir = mkdtempSync(join(tmpdir(), "run402-wallets-cwd-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function run(args, { cwd = workDir, env = {} } = {}) {
  // RUN402_WALLET_LABEL_SYNC=0 keeps these tests offline/hermetic — the
  // server-side label push is on by default in real use.
  const base = { ...process.env, RUN402_CONFIG_DIR: configDir, RUN402_API_BASE: API, RUN402_WALLET_LABEL_SYNC: "0" };
  delete base.RUN402_WALLET;
  delete base.RUN402_PROFILE;
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...base, ...env },
    encoding: "utf-8",
  });
  return result;
}

function jsonOut(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`stdout not JSON: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

function errEnvelope(result) {
  const line = result.stderr.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

describe("wallets — lifecycle", () => {
  it("new → list → rm", () => {
    assert.equal(run(["wallets", "new", "kychon"]).status, 0);
    const list = jsonOut(run(["wallets", "list"]));
    assert.deepEqual(list.map((w) => w.local_label).sort(), ["kychon"]);
    assert.equal(list[0].server_label, "kychon");
    // rm requires --yes
    const noConfirm = run(["wallets", "rm", "kychon"]);
    assert.notEqual(noConfirm.status, 0);
    assert.equal(errEnvelope(noConfirm).code, "CONFIRMATION_REQUIRED");
    assert.equal(run(["wallets", "rm", "kychon", "--yes"]).status, 0);
    assert.deepEqual(jsonOut(run(["wallets", "list"])), []);
  });

  it("rename default migrates the root wallet into profiles/", () => {
    assert.equal(run(["allowance", "create"]).status, 0); // creates the default wallet locally
    assert.ok(existsSync(join(configDir, "allowance.json")));
    assert.equal(run(["wallets", "rename", "default", "kychon"]).status, 0);
    assert.ok(!existsSync(join(configDir, "allowance.json")), "root allowance.json migrated away");
    assert.ok(existsSync(join(configDir, "profiles", "kychon", "allowance.json")));
    assert.deepEqual(jsonOut(run(["wallets", "list"])).map((w) => w.local_label), ["kychon"]);
  });
});

// kychee-com/run402-private#640: a live Base-mainnet private key was pasted
// into RUN402_WALLET (which takes a wallet NAME, not a key), failed name
// validation, and was printed verbatim — full private key, in full — to a
// terminal, a log, and a session transcript. These reproduce the exact
// incident shape against the real CLI subprocess (not just the in-process
// resolver) and assert the secret is absent from BOTH stdout and stderr,
// not just from a parsed field of the error envelope.
describe("wallets — never echo a rejected secret-shaped value", () => {
  const privateKey = "0x" + "22a3f0".repeat(11); // 66 chars, the exact shape of #640
  const bareHexKey = "22a3f0".repeat(10) + "aabb"; // 64 lowercase-hex chars, no 0x — passes the name CHARSET

  function assertSecretAbsent(result, secret) {
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.ok(!combined.includes(secret), `output must not contain the secret:\n${combined}`);
    // Also check for any 12-char substring run of the secret, not just the
    // whole thing — a partial echo (a "prefix" style message) would still
    // be a leak of key material.
    for (let i = 0; i + 12 <= secret.length; i += 6) {
      const chunk = secret.slice(i, i + 12);
      assert.ok(!combined.includes(chunk), `output must not contain a substring of the secret (${chunk}):\n${combined}`);
    }
  }

  it("RUN402_WALLET=<private key> (the exact incident reproduction)", () => {
    const result = run(["wallets", "list"], { env: { RUN402_WALLET: privateKey } });
    assert.notEqual(result.status, 0);
    assert.equal(errEnvelope(result).code, "BAD_WALLET_NAME");
    assertSecretAbsent(result, privateKey);
  });

  it("RUN402_WALLET=<private key> with a directory binding present (the conflict path, checked BEFORE format validation)", () => {
    // A checkout following this repo's own fleet-coordination convention
    // (AGENTS.md: `run402 wallets bind`) has a .run402.json binding — the
    // WALLET_SELECTION_CONFLICT check fires on that before the name ever
    // reaches the BAD_WALLET_NAME format check, so it needs its own redaction.
    // `wallets` itself is conflict-EXEMPT (it must keep working while
    // ambiguous), so use an unrelated command to actually hit the check —
    // it fires before dispatch, so the command never actually runs.
    writeFileSync(join(workDir, ".run402.json"), JSON.stringify({ wallet: "client-a" }));
    const result = run(["status"], { env: { RUN402_WALLET: privateKey } });
    assert.notEqual(result.status, 0);
    assert.equal(errEnvelope(result).code, "WALLET_SELECTION_CONFLICT");
    assertSecretAbsent(result, privateKey);
  });

  it("--wallet <private key>", () => {
    const result = run(["--wallet", privateKey, "wallets", "list"]);
    assert.notEqual(result.status, 0);
    assert.equal(errEnvelope(result).code, "BAD_WALLET_NAME");
    assertSecretAbsent(result, privateKey);
  });

  it("wallets new <private key>", () => {
    const result = run(["wallets", "new", privateKey]);
    assert.notEqual(result.status, 0);
    assert.equal(errEnvelope(result).code, "BAD_WALLET_NAME");
    assertSecretAbsent(result, privateKey);
  });

  it("wallets use <private key>", () => {
    const result = run(["wallets", "use", privateKey]);
    assert.notEqual(result.status, 0);
    assert.equal(errEnvelope(result).code, "BAD_WALLET_NAME");
    assertSecretAbsent(result, privateKey);
  });

  it("wallets rename <existing> --to <private key>", () => {
    run(["wallets", "new", "kychon"]);
    const result = run(["wallets", "rename", "kychon", "--to", privateKey]);
    assert.notEqual(result.status, 0);
    assert.equal(errEnvelope(result).code, "BAD_WALLET_NAME");
    assertSecretAbsent(result, privateKey);
  });

  it("wallets use <bare 64-hex key, no 0x prefix> (passes the name charset, still redacted)", () => {
    const result = run(["wallets", "use", bareHexKey]);
    assert.notEqual(result.status, 0);
    assert.equal(errEnvelope(result).code, "WALLET_NOT_FOUND");
    assertSecretAbsent(result, bareHexKey);
  });

  it("a normal short typo is still shown in full (redaction does not break usability)", () => {
    const result = run(["wallets", "use", "Kychon"]); // uppercase — fails the lowercase-only rule
    assert.notEqual(result.status, 0);
    const envelope = errEnvelope(result);
    assert.equal(envelope.code, "BAD_WALLET_NAME");
    assert.match(envelope.message, /Kychon/);
    assert.equal(envelope.details.name, "Kychon");
  });
});

describe("wallets — selection precedence", () => {
  beforeEach(() => {
    run(["wallets", "new", "kychon"]);
    run(["wallets", "new", "client-a"]);
  });

  it("flag wins and reports source=flag", () => {
    const cur = jsonOut(run(["--wallet", "kychon", "wallets", "current"]));
    assert.equal(cur.local_label, "kychon");
    assert.equal(cur.source, "flag");
  });

  it("env selects when no flag", () => {
    const cur = jsonOut(run(["wallets", "current"], { env: { RUN402_WALLET: "client-a" } }));
    assert.equal(cur.local_label, "client-a");
    assert.equal(cur.source, "env");
  });

  it("directory binding selects when no flag/env", () => {
    writeFileSync(join(workDir, ".run402.json"), JSON.stringify({ wallet: "client-a" }));
    const cur = jsonOut(run(["wallets", "current"]));
    assert.equal(cur.local_label, "client-a");
    assert.equal(cur.source, "binding");
  });

  it(".run402.local.json overrides .run402.json and walks up from a subdir", () => {
    writeFileSync(join(workDir, ".run402.json"), JSON.stringify({ wallet: "client-a" }));
    writeFileSync(join(workDir, ".run402.local.json"), JSON.stringify({ wallet: "kychon" }));
    const sub = join(workDir, "api");
    mkdirSync(sub);
    const cur = jsonOut(run(["wallets", "current"], { cwd: sub }));
    assert.equal(cur.local_label, "kychon");
  });

  it("global `wallets use` applies when no flag/env/binding", () => {
    assert.equal(run(["wallets", "use", "kychon"]).status, 0);
    const cur = jsonOut(run(["wallets", "current"]));
    assert.equal(cur.local_label, "kychon");
    assert.equal(cur.source, "config");
  });

  it("falls back to default when nothing selects", () => {
    const cur = jsonOut(run(["wallets", "current"]));
    assert.equal(cur.local_label, "default");
    assert.equal(cur.source, "default");
  });
});

describe("wallets — conflict + fail-closed", () => {
  beforeEach(() => {
    run(["wallets", "new", "kychon"]);
    run(["wallets", "new", "client-a"]);
  });

  it("env vs binding mismatch is a hard error on a normal command", () => {
    writeFileSync(join(workDir, ".run402.json"), JSON.stringify({ wallet: "client-a" }));
    const r = run(["allowance", "export"], { env: { RUN402_WALLET: "kychon" } });
    assert.notEqual(r.status, 0);
    const env = errEnvelope(r);
    assert.equal(env.code, "WALLET_SELECTION_CONFLICT");
    assert.match(env.message, /kychon/);
    assert.match(env.message, /client-a/);
  });

  it("--wallet resolves the conflict", () => {
    writeFileSync(join(workDir, ".run402.json"), JSON.stringify({ wallet: "client-a" }));
    const r = run(["--wallet", "kychon", "allowance", "export"], { env: { RUN402_WALLET: "client-a" } });
    assert.equal(r.status, 0, r.stderr);
  });

  it("selecting an unknown wallet fails closed on a normal command", () => {
    const r = run(["--wallet", "ghost", "allowance", "export"]);
    assert.notEqual(r.status, 0);
    assert.equal(errEnvelope(r).code, "WALLET_NOT_FOUND");
  });

  it("the wallets group itself is never blocked by a conflict (can unbind)", () => {
    writeFileSync(join(workDir, ".run402.json"), JSON.stringify({ wallet: "client-a" }));
    const r = run(["wallets", "unbind"], { env: { RUN402_WALLET: "kychon" } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(workDir, ".run402.json")));
  });
});

describe("wallets — provenance", () => {
  it("does not emit a provenance line for a non-default selection by default", () => {
    run(["wallets", "new", "kychon"]);
    const r = run(["--wallet", "kychon", "allowance", "export"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/↪ wallet:/.test(r.stderr), `expected no provenance line, got: ${r.stderr}`);
  });

  it("can emit a provenance line when explicitly requested", () => {
    run(["wallets", "new", "kychon"]);
    const r = run(["--wallet", "kychon", "allowance", "export"], { env: { RUN402_WALLET_PROVENANCE: "1" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /wallet: kychon/);
  });

  it("stays silent for the default wallet", () => {
    run(["allowance", "create"]); // default wallet
    const r = run(["allowance", "export"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/↪ wallet:/.test(r.stderr), `expected no provenance line, got: ${r.stderr}`);
  });
});
