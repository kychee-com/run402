import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import {
  readBaseConfig,
  writeBaseConfig,
  getDefaultWallet,
  setDefaultWallet,
  profileDir,
  ensureProfileDir,
  readMeta,
  writeMeta,
  profileExists,
  listProfileNames,
  removeProfile,
  renameProfile,
} from "./profiles.js";

const origConfigDir = process.env.RUN402_CONFIG_DIR;
const origWallet = process.env.RUN402_WALLET;
const origProfile = process.env.RUN402_PROFILE;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "profiles-test-"));
  process.env.RUN402_CONFIG_DIR = tmp;
  delete process.env.RUN402_WALLET;
  delete process.env.RUN402_PROFILE;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (origConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = origConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  if (origWallet !== undefined) process.env.RUN402_WALLET = origWallet;
  else delete process.env.RUN402_WALLET;
  if (origProfile !== undefined) process.env.RUN402_PROFILE = origProfile;
  else delete process.env.RUN402_PROFILE;
});

describe("profiles — base config (active_wallet)", () => {
  it("returns default when no base config exists", () => {
    assert.deepEqual(readBaseConfig(), {});
    assert.equal(getDefaultWallet(), "default");
  });

  it("round-trips the active wallet pointer", () => {
    setDefaultWallet("kychon");
    assert.equal(getDefaultWallet(), "kychon");
    assert.equal(readBaseConfig().active_wallet, "kychon");
    // stored at base config.json, mode 0600
    const p = join(tmp, "config.json");
    assert.ok(existsSync(p));
    if (process.platform !== "win32") assert.equal(statSync(p).mode & 0o777, 0o600);
  });

  it("ignores an invalid persisted active_wallet", () => {
    writeBaseConfig({ active_wallet: "../evil" });
    assert.equal(getDefaultWallet(), "default");
  });
});

describe("profiles — meta.json", () => {
  it("default maps to the base dir; named maps under profiles/", () => {
    assert.equal(profileDir("default"), tmp);
    assert.equal(profileDir("kychon"), join(tmp, "profiles", "kychon"));
  });

  it("writes and reads non-secret meta", () => {
    writeMeta("kychon", { name: "kychon", address: "0xabc", label: "kychon", rail: "x402", created: "2026-01-01" });
    const meta = readMeta("kychon");
    assert.equal(meta?.name, "kychon");
    assert.equal(meta?.label, "kychon");
    assert.equal(meta?.address, "0xabc");
  });

  it("ensureProfileDir creates owner-only 0700 directories", () => {
    const dir = ensureProfileDir("kychon");
    assert.ok(existsSync(dir));
    if (process.platform !== "win32") {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(join(tmp, "profiles")).mode & 0o777, 0o700);
    }
  });

  it("returns null meta for an unknown wallet", () => {
    assert.equal(readMeta("nope"), null);
  });
});

describe("profiles — listing + lifecycle", () => {
  it("lists default only when a root allowance.json exists", () => {
    assert.deepEqual(listProfileNames(), []);
    writeFileSync(join(tmp, "allowance.json"), "{}");
    assert.deepEqual(listProfileNames(), ["default"]);
  });

  it("lists named wallets from the profiles directory", () => {
    writeFileSync(join(tmp, "allowance.json"), "{}");
    ensureProfileDir("client-a");
    ensureProfileDir("client-b");
    const names = listProfileNames().sort();
    assert.deepEqual(names, ["client-a", "client-b", "default"]);
  });

  it("profileExists checks for allowance.json", () => {
    assert.ok(!profileExists("client-a"));
    ensureProfileDir("client-a");
    writeFileSync(join(tmp, "profiles", "client-a", "allowance.json"), "{}");
    assert.ok(profileExists("client-a"));
  });

  it("removeProfile deletes a named wallet but refuses default", () => {
    ensureProfileDir("client-a");
    writeFileSync(join(tmp, "profiles", "client-a", "allowance.json"), "{}");
    removeProfile("client-a");
    assert.ok(!existsSync(join(tmp, "profiles", "client-a")));
    assert.throws(() => removeProfile("default"), /Refusing to remove/);
  });
});

describe("profiles — rename", () => {
  it("moves a named wallet's directory", () => {
    ensureProfileDir("client-a");
    writeFileSync(join(tmp, "profiles", "client-a", "allowance.json"), '{"k":1}');
    renameProfile("client-a", "acme");
    assert.ok(!existsSync(join(tmp, "profiles", "client-a")));
    assert.ok(existsSync(join(tmp, "profiles", "acme", "allowance.json")));
  });

  it("migrates the default (root) wallet into profiles/<name>/", () => {
    writeFileSync(join(tmp, "allowance.json"), '{"key":"x"}');
    writeFileSync(join(tmp, "projects.json"), '{"projects":{}}');
    renameProfile("default", "kychon");
    assert.ok(!existsSync(join(tmp, "allowance.json")), "root allowance.json moved");
    assert.ok(existsSync(join(tmp, "profiles", "kychon", "allowance.json")));
    assert.ok(existsSync(join(tmp, "profiles", "kychon", "projects.json")));
  });

  it("refuses to overwrite an existing destination", () => {
    ensureProfileDir("client-a");
    ensureProfileDir("acme");
    assert.throws(() => renameProfile("client-a", "acme"), /already exists/);
  });

  it("rejects invalid destination names", () => {
    ensureProfileDir("client-a");
    assert.throws(() => renameProfile("client-a", "../evil"), /Invalid wallet name/);
  });
});
