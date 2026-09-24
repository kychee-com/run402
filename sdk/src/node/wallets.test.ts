/**
 * Named wallets and wallet selection on `@run402/sdk/node` (code-mode MCP,
 * task 1.5): the precedence chain, fail-closed existence, the published
 * selection context, and the `r.wallets` management verbs, each against a
 * temp config dir and temp working directories. Ported from the CLI's
 * `cli-wallets.test.mjs` and `cli/lib/wallet-context.test.mjs`, which now
 * exercise the same implementation through `run402 wallets …`.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ACTIVE_WALLET_CONTEXT_ENV,
  WalletSelectionError,
  assertWalletExists,
  findWalletBinding,
  resolveWalletSelection,
  run402,
  selectWallet,
} from "./index.js";
import { isSecretRequiresCli, type LocalError } from "../errors.js";
import { ensureProfileDir, setDefaultWallet } from "../../core-dist/profiles.js";

const KEYS = ["RUN402_CONFIG_DIR", "RUN402_WALLET", "RUN402_PROFILE", ACTIVE_WALLET_CONTEXT_ENV, "RUN402_WALLET_LABEL_SYNC", "RUN402_API_BASE"] as const;
const saved: Record<string, string | undefined> = {};
let configDir: string;
let workDir: string;
const origCwd = process.cwd();

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  configDir = mkdtempSync(join(tmpdir(), "run402-sdk-wallets-cfg-"));
  workDir = mkdtempSync(join(tmpdir(), "run402-sdk-wallets-cwd-"));
  process.env.RUN402_CONFIG_DIR = configDir;
  process.env.RUN402_API_BASE = "https://api.run402.test";
  process.env.RUN402_WALLET_LABEL_SYNC = "0";
  delete process.env.RUN402_WALLET;
  delete process.env.RUN402_PROFILE;
  delete process.env[ACTIVE_WALLET_CONTEXT_ENV];
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(origCwd);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const noFetch = (async () => {
  throw new Error("wallet management must not touch the network");
}) as typeof globalThis.fetch;

function sdk(surface: "cli" | "sandbox" | "sdk" = "sdk") {
  return run402({ surface, fetch: noFetch, apiBase: "https://api.run402.test" });
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<LocalError> {
  let caught: unknown;
  await assert.rejects(p, (err: unknown) => {
    caught = err;
    return (err as LocalError)?.code === code;
  });
  return caught as LocalError;
}

function bind(dir: string, wallet: string, local?: string) {
  writeFileSync(join(dir, ".run402.json"), JSON.stringify({ wallet }));
  if (local) writeFileSync(join(dir, ".run402.local.json"), JSON.stringify({ wallet: local }));
}

describe("resolveWalletSelection — precedence", () => {
  it("flag beats env and binding", () => {
    bind(workDir, "client-a");
    const r = resolveWalletSelection({ walletFlag: { flag: "--wallet", value: "kychon" }, env: { RUN402_WALLET: "personal" }, cwd: workDir });
    assert.deepEqual(r, { name: "kychon", source: "flag", sourceDetail: "--wallet" });
  });

  it("env selects when there is no flag and no binding", () => {
    assert.deepEqual(resolveWalletSelection({ env: { RUN402_WALLET: "kychon" }, cwd: workDir }), { name: "kychon", source: "env", sourceDetail: "RUN402_WALLET" });
    assert.equal(resolveWalletSelection({ env: { RUN402_PROFILE: "alias" }, cwd: workDir }).name, "alias");
  });

  it("the nearest binding selects when there is no flag or env, and .run402.local.json overrides", () => {
    bind(workDir, "client-a", "client-a-staging");
    const sub = join(workDir, "api");
    mkdirSync(sub);
    const r = resolveWalletSelection({ env: {}, cwd: sub });
    assert.equal(r.name, "client-a-staging");
    assert.equal(r.source, "binding");
    assert.equal(findWalletBinding(sub)?.wallet, "client-a-staging");
  });

  it("the global `wallets use` default applies next, reported as config", () => {
    setDefaultWallet("kychon");
    assert.deepEqual(resolveWalletSelection({ env: {}, cwd: workDir }), { name: "kychon", source: "config", sourceDetail: "wallets use" });
  });

  it("falls back to default when nothing selects", () => {
    assert.deepEqual(resolveWalletSelection({ env: {}, cwd: workDir }), { name: "default", source: "default", sourceDetail: null });
  });
});

describe("resolveWalletSelection — conflict and validation", () => {
  it("env vs binding mismatch is WALLET_SELECTION_CONFLICT unless allowed", () => {
    bind(workDir, "client-a");
    assert.throws(
      () => resolveWalletSelection({ env: { RUN402_WALLET: "personal" }, cwd: workDir }),
      (err: unknown) => err instanceof WalletSelectionError && err.code === "WALLET_SELECTION_CONFLICT" && /personal/.test(err.message) && /client-a/.test(err.message),
    );
    assert.equal(resolveWalletSelection({ env: { RUN402_WALLET: "personal" }, cwd: workDir, allowConflict: true }).name, "personal");
    assert.equal(resolveWalletSelection({ env: { RUN402_WALLET: "client-a" }, cwd: workDir }).name, "client-a");
  });

  it("a flag with no value is BAD_FLAG", () => {
    assert.throws(() => resolveWalletSelection({ walletFlag: { flag: "--wallet", value: undefined }, env: {}, cwd: workDir }), (err: unknown) => (err as LocalError).code === "BAD_FLAG");
  });

  it("an invalid name is BAD_WALLET_NAME, shown in full when it is plainly a typo", () => {
    assert.throws(
      () => resolveWalletSelection({ env: { RUN402_WALLET: "../evil" }, cwd: workDir }),
      (err: unknown) => {
        const e = err as WalletSelectionError;
        return e.code === "BAD_WALLET_NAME" && /\.\.\/evil/.test(e.message) && (e.details as { name: string }).name === "../evil";
      },
    );
  });

  it("never echoes a secret-shaped name, on the format path or the conflict path", () => {
    const privateKey = "0x" + "22a3f0".repeat(11);
    for (const run of [
      () => resolveWalletSelection({ env: { RUN402_WALLET: privateKey }, cwd: workDir }),
      () => { bind(workDir, "client-a"); return resolveWalletSelection({ env: { RUN402_WALLET: privateKey }, cwd: workDir }); },
      () => resolveWalletSelection({ walletFlag: { flag: "--wallet", value: privateKey }, env: {}, cwd: workDir }),
    ]) {
      assert.throws(run, (err: unknown) => {
        const text = JSON.stringify({ ...(err as WalletSelectionError).toJSON(), message: (err as Error).message });
        return !text.includes("22a3f0");
      });
    }
  });
});

describe("assertWalletExists — fail closed", () => {
  it("passes default and an existing wallet", () => {
    assert.doesNotThrow(() => assertWalletExists({ name: "default", source: "default" }));
    ensureProfileDir("client-a");
    writeFileSync(join(configDir, "profiles", "client-a", "wallet.json"), "{}");
    assert.doesNotThrow(() => assertWalletExists({ name: "client-a", source: "binding" }));
  });

  it("refuses a missing wallet with a create hint, an address hint, or a redacted secret", () => {
    assert.throws(() => assertWalletExists({ name: "ghost", source: "binding" }), (err: unknown) => {
      const e = err as WalletSelectionError;
      return e.code === "WALLET_NOT_FOUND" && /ghost/.test(e.message) && /wallets new ghost/.test(e.hint ?? "");
    });
    assert.throws(() => assertWalletExists({ name: "0x" + "a".repeat(40), source: "flag" }), (err: unknown) => /--address 0x/.test((err as WalletSelectionError).hint ?? ""));
    const bareKey = "22a3f0".repeat(10) + "aabb";
    assert.throws(() => assertWalletExists({ name: bareKey, source: "binding" }), (err: unknown) => {
      const e = err as WalletSelectionError;
      return e.code === "WALLET_NOT_FOUND" && !`${e.message}${e.hint}${JSON.stringify(e.details)}`.includes("22a3f0");
    });
  });
});

describe("selectWallet — publishes the selection", () => {
  it("sets RUN402_WALLET and the context current() reads back", async () => {
    bind(workDir, "client-a");
    ensureProfileDir("client-a");
    writeFileSync(join(configDir, "profiles", "client-a", "wallet.json"), "{}");
    const env: Record<string, string | undefined> = {};
    const sel = selectWallet({ env, cwd: workDir });
    assert.equal(sel.name, "client-a");
    assert.equal(env.RUN402_WALLET, "client-a");
    const ctx = JSON.parse(env[ACTIVE_WALLET_CONTEXT_ENV]!);
    assert.equal(ctx.source, "binding");
    assert.equal(ctx.diverged, false);
  });

  it("fails closed on a missing wallet unless the surface creates wallets", () => {
    assert.throws(() => selectWallet({ env: {}, cwd: workDir, walletFlag: { flag: "--wallet", value: "ghost" } }), WalletSelectionError);
    assert.equal(selectWallet({ env: {}, cwd: workDir, walletFlag: { flag: "--wallet", value: "ghost" }, allowMissing: true }).name, "ghost");
  });
});

describe("r.wallets management verbs", () => {
  it("create → list → remove, with the created alias as the next action", async () => {
    const r = sdk();
    const created = await r.wallets.create("dx-test_1");
    assert.equal(created.local_label, "dx-test_1");
    assert.equal(created.created, true);
    assert.equal(created.rail, "x402");
    assert.equal(created.next_actions[0]?.command, "run402 wallets use dx-test_1");
    assert.equal(created.next, created.next_actions[0]?.command);
    const list = await r.wallets.list();
    assert.deepEqual(list.map((w) => w.local_label), ["dx-test_1"]);
    assert.equal(list[0]!.server_label, "dx-test_1");
    const noConfirm = await rejectsWith(r.wallets.remove("dx-test_1"), "CONFIRMATION_REQUIRED");
    assert.equal(noConfirm.hint, "Re-run with --yes to confirm: run402 wallets rm dx-test_1 --yes");
    assert.deepEqual(await r.wallets.remove("dx-test_1", { confirm: true }), { local_label: "dx-test_1", removed: true });
    assert.deepEqual(await r.wallets.list(), []);
  });

  it("create refuses a duplicate, an invalid or shell-sensitive name, and an unknown rail", async () => {
    const r = sdk();
    await r.wallets.create("kychon");
    await rejectsWith(r.wallets.create("kychon"), "WALLET_EXISTS");
    for (const name of ["bad name", "bad;name", "$(bad)", "Kychon"]) {
      await rejectsWith(r.wallets.create(name), "BAD_WALLET_NAME");
    }
    await rejectsWith(r.wallets.create("other", { rail: "bogus" }), "BAD_USAGE");
    assert.equal((await r.wallets.create("lnw", { rail: "lightning" })).next, "run402 --wallet lnw init lightning");
    assert.equal((await r.wallets.create("default")).next, "run402 wallets fund");
  });

  it("use sets the global default; rename moves the root wallet under profiles/", async () => {
    const r = sdk();
    await r.wallets.create("default");
    assert.ok(existsSync(join(configDir, "wallet.json")));
    assert.deepEqual(await r.wallets.rename("default", "kychon"), { from: "default", to: "kychon", renamed: true });
    assert.ok(!existsSync(join(configDir, "wallet.json")));
    assert.ok(existsSync(join(configDir, "profiles", "kychon", "wallet.json")));
    assert.deepEqual(await r.wallets.use("kychon"), { local_label: "kychon", active: true });
    await rejectsWith(r.wallets.use("ghost"), "WALLET_NOT_FOUND");
    await rejectsWith(r.wallets.rename("kychon", "default"), "BAD_WALLET_NAME");
  });

  it("bind merges into .run402.json and unbind removes only the wallet key", async () => {
    const r = sdk();
    writeFileSync(join(workDir, ".run402.json"), JSON.stringify({ org: "11111111-2222-4333-8444-555555555555" }));
    const bound = await r.wallets.bind("client-a");
    assert.equal(bound.bound, true);
    assert.equal(bound.safe_to_commit, true);
    assert.match(bound.warning ?? "", /wallets new client-a/);
    assert.deepEqual(JSON.parse(readFileSync(join(workDir, ".run402.json"), "utf8")), { org: "11111111-2222-4333-8444-555555555555", wallet: "client-a" });
    const unbound = await r.wallets.unbind();
    assert.equal(unbound.unbound, true);
    assert.equal(unbound.removed, false);
    assert.deepEqual(unbound.binding, { org: "11111111-2222-4333-8444-555555555555" });
  });

  it("import adopts a key and reads a lazy key only after the name checks pass", async () => {
    const r = sdk();
    const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const imported = await r.wallets.import("adopted", () => key);
    assert.equal(imported.imported, true);
    assert.equal(imported.address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    let read = false;
    await rejectsWith(r.wallets.import("adopted", () => { read = true; return key; }), "WALLET_EXISTS");
    assert.equal(read, false, "the key is not read for a refused name");
    await rejectsWith(r.wallets.import("other", "not-a-key"), "BAD_PRIVATE_KEY");
    await rejectsWith(r.wallets.import("default", key), "BAD_WALLET_NAME");
  });

  it("current() reports the resolved wallet and its source, the same answer the CLI prints", async () => {
    const r = sdk();
    await r.wallets.create("client-a");
    bind(workDir, "client-a");
    const cur = await r.wallets.current();
    assert.equal(cur.local_label, "client-a");
    assert.equal(cur.source, "binding");
    assert.ok(cur.source_detail?.endsWith(".run402.json"));
    assert.equal(cur.server_label, "client-a");
    assert.deepEqual(cur.warnings, []);
  });

  it("current() prefers a published selection context and reports an env/binding divergence", async () => {
    const r = sdk();
    process.env[ACTIVE_WALLET_CONTEXT_ENV] = JSON.stringify({
      name: "kychon", source: "flag", sourceDetail: "--wallet",
      binding: { wallet: "client-a", file: "/x/.run402.json" }, envName: "personal", diverged: true,
    });
    const cur = await r.wallets.current();
    assert.equal(cur.local_label, "kychon");
    assert.equal(cur.source, "flag");
    assert.equal(cur.source_detail, "--wallet");
    assert.equal(cur.warnings[0]?.code, "WALLET_SELECTION_CONFLICT");
    assert.equal(cur.configured, false);
    assert.equal(cur.next_actions?.[0]?.type, "initialize_wallet");
  });

  it("wallet creation and import refuse on the sandbox surface before touching disk", async () => {
    const r = sdk("sandbox");
    await assert.rejects(r.wallets.create("ci"), (err: unknown) => isSecretRequiresCli(err) && (err as { command: string }).command === "run402 wallets new ci");
    await assert.rejects(r.wallets.import("ci", "0xabc"), (err: unknown) => isSecretRequiresCli(err) && (err as { command: string }).command === "run402 wallets import ci --key <path|->");
    assert.ok(!existsSync(join(configDir, "profiles", "ci")));
    // Reads stay open to a snippet.
    assert.deepEqual(await r.wallets.list(), []);
  });
});
