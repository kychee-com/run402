/**
 * `r.init()` and `r.status()` on `@run402/sdk/node` (code-mode MCP, task
 * 1.8). Ported from the CLI's init/status e2e cases, which now drive the same
 * implementation through `run402 init` / `run402 status`: JSON-shaped results,
 * progress on a line callback, the rail-switch guard, the funding and tier
 * next step, the API-target branch, the bare no-wallet status, and the
 * sandbox refusals.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveScaffoldProject, run402, type InitSummary, type WalletStatus, type LocalOnlyStatus } from "./index.js";
import { isSecretRequiresCli, type LocalError } from "../errors.js";
import { readWallet, saveWallet } from "../../core-dist/wallet.js";

const API = "https://test-api.run402.com";
const saved: Record<string, string | undefined> = {};
const KEYS = ["RUN402_CONFIG_DIR", "RUN402_API_BASE", "RUN402_WALLET", "RUN402_PROJECT_ID"];
let tempDir: string;
let workDir: string;
const originalFetch = globalThis.fetch;
let onChainMicros = 250_000;
let faucetCalls = 0;
let routes: Record<string, unknown> = {};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function rpc(req: { id: unknown; method: string }) {
  return { jsonrpc: "2.0", id: req.id, result: req.method === "eth_call" ? "0x" + onChainMicros.toString(16).padStart(64, "0") : "0x14a34" };
}

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  const body = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  if (body?.jsonrpc === "2.0") return json(rpc(body));
  if (Array.isArray(body)) return json(body.map(rpc));
  if (url.includes("/faucet/v1")) { faucetCalls++; onChainMicros = 250_000; return json({ transaction_hash: "0x" + "ab".repeat(32), amount_usd_micros: 250000, token: "USDC", network: "base-sepolia" }); }
  for (const [needle, value] of Object.entries(routes)) if (url.includes(needle)) return json(value);
  if (url.includes("/health")) return json({ status: "ok", mode: "core" });
  if (url.includes("/tiers/v1/status")) return json({ tier: null, active: false });
  if (url.includes("/billing/")) return json({ exists: false, allowance_usd_micros: 0 });
  if (/\/orgs\/v1(\?|$)/.test(url)) return json({ orgs: [{ org_id: "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa", display_name: "mine", role: "owner" }] });
  return json({});
}

before(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  globalThis.fetch = mockFetch as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-sdk-init-"));
  workDir = join(tempDir, "work");
  mkdirSync(workDir, { recursive: true });
  process.env.RUN402_CONFIG_DIR = join(tempDir, "config");
  process.env.RUN402_API_BASE = API;
  delete process.env.RUN402_WALLET;
  delete process.env.RUN402_PROJECT_ID;
  onChainMicros = 250_000;
  faucetCalls = 0;
  routes = {};
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function sdk(surface: "cli" | "sandbox" = "cli") {
  return run402({ surface, apiBase: API, disablePaidFetch: true });
}

describe("r.init", () => {
  it("creates the wallet, reads the balance, and reports the summary with progress on the line callback", async () => {
    const lines: string[] = [];
    const summary = (await sdk().init({ cwd: workDir, env: {}, onLine: (l) => lines.push(l) })) as InitSummary;
    assert.ok(readWallet(), "a wallet was written");
    assert.equal(summary.wallet?.local_label, "default");
    assert.equal(summary.wallet?.server_label, null);
    assert.equal(summary.rail, "x402");
    assert.equal(summary.network, "base-sepolia");
    assert.equal(summary.balances?.on_chain_usd_micros, 250_000);
    assert.equal(summary.balances?.on_chain_token, "USDC");
    assert.equal(summary.tier, null);
    assert.equal(summary.projects_saved, 0);
    assert.equal(faucetCalls, 0, "a funded wallet never asks the faucet");
    assert.equal(summary.next_step, "run402 up -y", "no tier: the first deploy sets it");
    assert.equal(summary.next_actions[0]?.command, summary.next_step);
    assert.equal(summary.vault, null);
    assert.match(String(summary.vault_skipped), /no project is selected/);
    assert.deepEqual(summary.orgs, [{ org_id: "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa", display_name: "mine", role: "owner" }]);
    assert.ok(lines.some((l) => /^ {2}Config {5}/.test(l)));
    assert.ok(lines.some((l) => /Projects\s+0 saved/.test(l)));
    assert.ok(lines.includes("  Next: run402 up -y"));
  });

  it("asks the faucet for an empty wallet, polls until the drip lands, and records the faucet use", async () => {
    onChainMicros = 0;
    const lines: string[] = [];
    const summary = (await sdk().init({ cwd: workDir, env: {}, onLine: (l) => lines.push(l) })) as InitSummary;
    assert.equal(faucetCalls, 1);
    assert.equal(readWallet()?.funded, true);
    assert.equal(summary.balances?.on_chain_usd_micros, 250_000);
    assert.equal(summary.funding, null);
    assert.ok(lines.includes("  Balance    0.25 USDC (funded)"));
  });

  it("an active tier points at deploy; a rail switch needs confirmation", async () => {
    routes = { "/tiers/v1/status": { tier: "prototype", active: true, lease_expires_at: "2099-01-01T00:00:00.000Z" } };
    const summary = (await sdk().init({ cwd: workDir, env: {} })) as InitSummary;
    assert.deepEqual(summary.tier, { name: "prototype", expires: "2099-01-01T00:00:00.000Z" });
    assert.equal(summary.next_step, "run402 deploy --manifest app.json");
    await assert.rejects(sdk().init({ rail: "mpp", cwd: workDir, env: {} }), (err: unknown) => (err as LocalError).code === "RAIL_SWITCH_REQUIRES_CONFIRM");
  });

  it("with apiBase, configures the target and touches no wallet", async () => {
    const lines: string[] = [];
    const summary = await sdk().init({ apiBase: "http://my-core:4020", onLine: (l) => lines.push(l) });
    assert.equal(summary.api_base, "http://my-core:4020");
    assert.equal(summary.target.kind, "core");
    assert.equal(summary.payment_required, false);
    assert.equal(summary.next_step, 'run402 projects provision --name "my-app"');
    assert.equal(readWallet(), null);
    assert.ok(lines.some((l) => l.includes("API base")));
  });

  it("names the project the vault scaffold would act on", () => {
    assert.deepEqual(resolveScaffoldProject({ RUN402_PROJECT_ID: " prj_env " }, "prj_active"), { projectId: "prj_env", skipped: null });
    assert.deepEqual(resolveScaffoldProject({}, "prj_active"), { projectId: "prj_active", skipped: null });
    assert.equal(resolveScaffoldProject({}, null).projectId, null);
  });

  it("refuses on the sandbox surface to create a wallet or mint the Lightning pairing", async () => {
    await assert.rejects(sdk("sandbox").init({ cwd: workDir, env: {} }), (err: unknown) => isSecretRequiresCli(err) && (err as { command: string }).command === "run402 init");
    assert.equal(existsSync(join(tempDir, "config")), false, "nothing written before the refusal");
    saveWallet({ address: "0x" + "11".repeat(20), privateKey: "0x" + "22".repeat(32), rail: "x402" });
    await assert.rejects(sdk("sandbox").init({ rail: "lightning", cwd: workDir, env: {} }), (err: unknown) => isSecretRequiresCli(err) && (err as { command: string }).command === "run402 init lightning");
  });
});

describe("r.status", () => {
  it("with no wallet, reports the local facts and the next command", async () => {
    const status = (await sdk().status()) as LocalOnlyStatus;
    assert.equal(status.wallet, null);
    assert.deepEqual(status.projects, []);
    assert.equal(status.active_project, null);
    assert.equal(status.target.api_base, API);
    assert.equal(status.hint, "Run: run402 init");
  });

  it("with a wallet, groups balances, names the wallet, and keys projects by project_id", async () => {
    saveWallet({ address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", rail: "x402" });
    routes = {
      "/tiers/v1/status": { tier: "prototype", status: "active", active: true, lease_expires_at: "2099-01-01T00:00:00.000Z", organization_lifecycle_state: "active", lease_perpetual: false },
      "/orgs/v1/lookup": { exists: true, allowance_usd_micros: 5_000_000, held_usd_micros: 0 },
      "/projects/v1": { projects: [{ id: "prj_1", name: "one", site_url: "https://one.test" }] },
    };
    const status = (await sdk().status()) as WalletStatus;
    assert.deepEqual(status.wallet, { local_label: "default", server_label: null, address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
    assert.equal(status.rail, "x402");
    assert.equal(status.balances.on_chain_token, "USDC");
    assert.equal(status.balances.on_chain_usd_micros, 500_000, "mainnet + sepolia USDC summed");
    assert.equal(status.balances.allowance_usd_micros, 5_000_000);
    assert.deepEqual(status.tier, { name: "prototype", status: "active", expires: "2099-01-01T00:00:00.000Z" });
    assert.equal(status.projects_source, "remote");
    assert.deepEqual(status.projects, [{ project_id: "prj_1", name: "one", site_url: "https://one.test" }]);
    assert.equal(JSON.stringify(status).includes("privateKey"), false);
  });
});
