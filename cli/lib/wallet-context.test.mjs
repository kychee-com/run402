import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  splitWalletFlag,
  findBinding,
  resolveWallet,
  enforceWalletExists,
  emitProvenance,
} from "./wallet-context.mjs";
import { ensureProfileDir, setDefaultWallet } from "../core-dist/profiles.js";

const origConfigDir = process.env.RUN402_CONFIG_DIR;
let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wallet-ctx-"));
  process.env.RUN402_CONFIG_DIR = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (origConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = origConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
});

// Capture a fail() invocation: fail() does console.error(envelope) + process.exit.
function captureFail(fn) {
  const origExit = process.exit;
  const origErr = console.error;
  let envelope = null;
  let exited = false;
  console.error = (s) => { try { envelope = JSON.parse(s); } catch { envelope = s; } };
  process.exit = () => { exited = true; throw new Error("__EXIT__"); };
  try {
    fn();
  } catch (e) {
    if (!String(e?.message).startsWith("__EXIT__")) throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
  return { envelope, exited };
}

function bindingDir(wallet, localWallet) {
  const dir = mkdtempSync(join(tmpdir(), "binding-"));
  if (wallet) writeFileSync(join(dir, ".run402.json"), JSON.stringify({ wallet }));
  if (localWallet) writeFileSync(join(dir, ".run402.local.json"), JSON.stringify({ wallet: localWallet }));
  return dir;
}

describe("splitWalletFlag", () => {
  it("passes through argv with no global flag", () => {
    assert.deepEqual(splitWalletFlag(["status"]), { argv: ["status"], walletFlag: null });
  });
  it("strips --wallet <value>", () => {
    const r = splitWalletFlag(["--wallet", "kychon", "status"]);
    assert.deepEqual(r.argv, ["status"]);
    assert.deepEqual(r.walletFlag, { flag: "--wallet", value: "kychon" });
  });
  it("strips --wallet=<value> mid-args", () => {
    const r = splitWalletFlag(["deploy", "apply", "--wallet=foo", "--manifest", "x"]);
    assert.deepEqual(r.argv, ["deploy", "apply", "--manifest", "x"]);
    assert.equal(r.walletFlag.value, "foo");
  });
  it("accepts --profile as an alias", () => {
    const r = splitWalletFlag(["--profile", "p", "status"]);
    assert.equal(r.walletFlag.flag, "--profile");
    assert.equal(r.walletFlag.value, "p");
  });
  it("last occurrence wins", () => {
    const r = splitWalletFlag(["--wallet", "a", "--wallet", "b", "status"]);
    assert.equal(r.walletFlag.value, "b");
    assert.deepEqual(r.argv, ["status"]);
  });
  it("records a missing value as undefined", () => {
    const r = splitWalletFlag(["status", "--wallet"]);
    assert.deepEqual(r.argv, ["status"]);
    assert.equal(r.walletFlag.value, undefined);
  });
});

describe("findBinding", () => {
  it("finds the nearest .run402.json walking up", () => {
    const root = bindingDir("client-a");
    const sub = join(root, "api");
    mkdirSync(sub);
    const b = findBinding(sub);
    assert.equal(b.wallet, "client-a");
    rmSync(root, { recursive: true, force: true });
  });
  it(".run402.local.json overrides .run402.json in the same dir", () => {
    const dir = bindingDir("client-a", "client-a-staging");
    assert.equal(findBinding(dir).wallet, "client-a-staging");
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns null when no binding exists in the tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "nobind-"));
    assert.equal(findBinding(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveWallet — precedence", () => {
  it("flag beats everything", () => {
    const dir = bindingDir("client-a");
    const r = resolveWallet({ walletFlag: { flag: "--wallet", value: "kychon" }, env: { RUN402_WALLET: "personal" }, cwd: dir, cmd: "status" });
    assert.equal(r.name, "kychon");
    assert.equal(r.source, "flag");
    rmSync(dir, { recursive: true, force: true });
  });
  it("env beats binding when they agree is moot; env returned when no binding", () => {
    const dir = mkdtempSync(join(tmpdir(), "nobind-"));
    const r = resolveWallet({ env: { RUN402_WALLET: "kychon" }, cwd: dir, cmd: "status" });
    assert.equal(r.name, "kychon");
    assert.equal(r.source, "env");
    rmSync(dir, { recursive: true, force: true });
  });
  it("binding used when no flag/env", () => {
    const dir = bindingDir("client-a");
    const r = resolveWallet({ env: {}, cwd: dir, cmd: "status" });
    assert.equal(r.name, "client-a");
    assert.equal(r.source, "binding");
    rmSync(dir, { recursive: true, force: true });
  });
  it("global default (wallets use) applies when no flag/env/binding", () => {
    setDefaultWallet("kychon");
    const dir = mkdtempSync(join(tmpdir(), "nobind-"));
    const r = resolveWallet({ env: {}, cwd: dir, cmd: "status" });
    assert.equal(r.name, "kychon");
    assert.equal(r.source, "config");
    rmSync(dir, { recursive: true, force: true });
  });
  it("falls back to default when nothing selects", () => {
    const dir = mkdtempSync(join(tmpdir(), "nobind-"));
    const r = resolveWallet({ env: {}, cwd: dir, cmd: "status" });
    assert.equal(r.name, "default");
    assert.equal(r.source, "default");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveWallet — conflict + validation", () => {
  it("env vs binding mismatch is a hard error (non-wallets command)", () => {
    const dir = bindingDir("client-a");
    const { envelope, exited } = captureFail(() =>
      resolveWallet({ env: { RUN402_WALLET: "personal" }, cwd: dir, cmd: "deploy" }));
    assert.ok(exited);
    assert.equal(envelope.code, "WALLET_SELECTION_CONFLICT");
    assert.match(envelope.message, /personal/);
    assert.match(envelope.message, /client-a/);
    rmSync(dir, { recursive: true, force: true });
  });
  it("matching env and binding proceed without error", () => {
    const dir = bindingDir("client-a");
    const r = resolveWallet({ env: { RUN402_WALLET: "client-a" }, cwd: dir, cmd: "deploy" });
    assert.equal(r.name, "client-a");
    rmSync(dir, { recursive: true, force: true });
  });
  it("the wallets group is exempt from the conflict error", () => {
    const dir = bindingDir("client-a");
    const r = resolveWallet({ env: { RUN402_WALLET: "personal" }, cwd: dir, cmd: "wallets" });
    assert.equal(r.name, "personal"); // env still wins; no error
    rmSync(dir, { recursive: true, force: true });
  });
  it("rejects an invalid wallet name", () => {
    const dir = mkdtempSync(join(tmpdir(), "nobind-"));
    const { envelope } = captureFail(() =>
      resolveWallet({ env: { RUN402_WALLET: "../evil" }, cwd: dir, cmd: "status" }));
    assert.equal(envelope.code, "BAD_WALLET_NAME");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("enforceWalletExists — fail closed", () => {
  it("no-op for default", () => {
    assert.doesNotThrow(() => enforceWalletExists({ name: "default", source: "default" }, "deploy"));
  });
  it("no-op for an existing wallet", () => {
    ensureProfileDir("client-a");
    writeFileSync(join(tmp, "profiles", "client-a", "allowance.json"), "{}");
    assert.doesNotThrow(() => enforceWalletExists({ name: "client-a", source: "binding" }, "deploy"));
  });
  it("fails closed for a missing wallet on a normal command", () => {
    const { envelope, exited } = captureFail(() =>
      enforceWalletExists({ name: "ghost", source: "binding" }, "deploy"));
    assert.ok(exited);
    assert.equal(envelope.code, "WALLET_NOT_FOUND");
  });
  it("wallets + init are exempt (create paths)", () => {
    assert.doesNotThrow(() => enforceWalletExists({ name: "ghost", source: "flag" }, "wallets"));
    assert.doesNotThrow(() => enforceWalletExists({ name: "ghost", source: "flag" }, "init"));
  });
  it("address-looking name hints at billing --wallet-address", () => {
    const { envelope } = captureFail(() =>
      enforceWalletExists({ name: "0x" + "a".repeat(40), source: "flag" }, "deploy"));
    assert.match(envelope.hint, /--wallet-address/);
  });
});

describe("emitProvenance", () => {
  function captureStderr(fn) {
    const orig = process.stderr.write.bind(process.stderr);
    let out = "";
    process.stderr.write = (c) => { out += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); return true; };
    try { fn(); } finally { process.stderr.write = orig; }
    return out;
  }
  it("stays silent for the default wallet", () => {
    assert.equal(captureStderr(() => emitProvenance({ name: "default", source: "default" }, { cmd: "status" })), "");
  });
  it("emits a provenance line for a named wallet", () => {
    ensureProfileDir("kychon");
    writeFileSync(join(tmp, "profiles", "kychon", "meta.json"), JSON.stringify({ name: "kychon", address: "0x1234567890abcdef" }));
    const out = captureStderr(() => emitProvenance({ name: "kychon", source: "env", sourceDetail: "RUN402_WALLET" }, { cmd: "status" }));
    assert.match(out, /wallet: kychon/);
    assert.match(out, /RUN402_WALLET/);
  });
  it("honors --quiet", () => {
    assert.equal(captureStderr(() => emitProvenance({ name: "kychon", source: "env" }, { cmd: "status", quiet: true })), "");
  });
  it("stays silent for the wallets group", () => {
    assert.equal(captureStderr(() => emitProvenance({ name: "kychon", source: "flag" }, { cmd: "wallets" })), "");
  });
});
