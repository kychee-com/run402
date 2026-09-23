/**
 * `r.doctor()` on `@run402/sdk/node` (code-mode MCP, task 1.7): the
 * `{ ok, blocking[], warnings[], checks[] }` report, the severity contract,
 * the fixed tier vocabulary, `only` scoping (skipping a check's WORK, not just
 * its output), vault targeting, and the application-scoped source scan.
 * Ported from the CLI's `cli-doctor.test.mjs`, which now pins `run402 doctor`
 * as a shim over this same implementation.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DOCTOR_CHECK_NAMES, buildDoctorReport, run402, type DoctorReport, type NodeRun402 } from "./index.js";
import { saveWallet } from "../../core-dist/wallet.js";
import { setActiveProjectId } from "../../core-dist/keystore.js";
import type { LocalError } from "../errors.js";

const ACTIVE_PROJECT = "prj_active_0001";
const EXPLICIT_PROJECT = "prj_explicit_0002";
const saved: Record<string, string | undefined> = {};
let tempDir: string;
let scratchDir: string;
let routes: Record<string, unknown> = {};
let fetched: string[] = [];
let vaultProjectReads: Array<string | null> = [];
let r: NodeRun402;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const fetchImpl = (async (input: RequestInfo | URL) => {
  const url = String(input);
  fetched.push(url);
  for (const [needle, body] of Object.entries(routes)) if (url.includes(needle)) return json(body);
  if (url.includes("/vaults/v1")) {
    vaultProjectReads.push(new URL(url).searchParams.get("project_id"));
    return json({}, 404);
  }
  return json({});
}) as typeof globalThis.fetch;

before(() => {
  for (const k of ["RUN402_CONFIG_DIR", "RUN402_API_BASE", "RUN402_WALLET", "RUN402_PROJECT_ID"]) saved[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), "run402-sdk-doctor-"));
  scratchDir = join(tempDir, "scratch");
  mkdirSync(scratchDir, { recursive: true });
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  delete process.env.RUN402_WALLET;
  delete process.env.RUN402_PROJECT_ID;
  setActiveProjectId(ACTIVE_PROJECT);
  r = run402({ surface: "cli", fetch: fetchImpl, apiBase: "https://test-api.run402.com" });
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

async function doctor(opts: Parameters<NodeRun402["doctor"]>[0] = {}, withRoutes: Record<string, unknown> = {}): Promise<DoctorReport> {
  routes = withRoutes;
  fetched = [];
  vaultProjectReads = [];
  try {
    return await r.doctor({ cwd: scratchDir, noScan: true, ...opts });
  } finally {
    routes = {};
  }
}

const ACTIVE_TIER = {
  tier: "team",
  active: true,
  organization_lifecycle_state: "active",
  lease_expires_at: "2099-01-01T00:00:00.000Z",
  projects: [{ id: ACTIVE_PROJECT, name: "active" }],
};
const BASE_STATUS = {
  contact: { email_status: "verified", passkey_status: "verified" },
  reachability: { reachable: true, verified_recipient_count: 1, sources: [], skipped_last_90d: 0 },
  skipped_notifications: [],
  critical_items: [],
  runtime: { stale_function_count: 0, stale_functions: [] },
};

describe("r.doctor — report shape and severity", () => {
  it("every check carries a severity, and ok is exactly 'blocking[] is empty'", async () => {
    for (const opts of [{}, { only: ["vault"] }, { refresh: true }]) {
      const report = await doctor(opts);
      assert.ok(report.checks.length > 0);
      for (const c of report.checks) assert.ok(["blocking", "advisory", "info"].includes(c.severity), `${c.name}: ${c.severity}`);
      assert.equal(report.ok, report.blocking.length === 0);
      assert.ok(report.checks.every((c) => (c.severity === "blocking") === report.blocking.some((b) => b.check === c.name)));
    }
  });

  it("advisory gaps ride in warnings[] and never flip ok; a frozen tier blocks", async () => {
    const withGaps = {
      ...BASE_STATUS,
      contact: { email_status: "verified", passkey_status: "not_bound" },
      recovery_posture: [{ org_id: "org-other", vault_count: 1, control_plane_configured: false, source_backup_configured: true, custody_legacy_present: false }],
    };
    const only = ["tier", "account_health", "recovery_posture", "runtime_staleness"];
    const shipping = await doctor({ only }, { "/tiers/v1/status": ACTIVE_TIER, "/agent/v1/me/status": withGaps });
    assert.equal(shipping.ok, true);
    assert.deepEqual(shipping.blocking, []);
    assert.match(shipping.warnings.find((w) => w.check === "account_health")!.message, /contact passkey not bound/);
    assert.match(shipping.warnings.find((w) => w.check === "recovery_posture")!.message, /org org-other \(1 vault\): no human owner/);
    const frozen = await doctor({ only }, { "/tiers/v1/status": { ...ACTIVE_TIER, tier: "prototype", active: false, organization_lifecycle_state: "frozen" }, "/agent/v1/me/status": withGaps });
    assert.equal(frozen.ok, false);
    assert.deepEqual(frozen.blocking.map((b) => [b.check, b.status]), [["tier", "frozen"]]);
    assert.ok(frozen.warnings.some((w) => w.check === "account_health"));
  });

  it("the tier status is a fixed vocabulary, never the tier name", async () => {
    const ok = await doctor({ only: ["tier"] }, { "/tiers/v1/status": ACTIVE_TIER });
    assert.equal(ok.checks[0]!.status, "ok");
    assert.deepEqual((ok.checks[0]!.value as { tier: string; lifecycle: string }).tier, "team");
    const unknown = await doctor({ only: ["tier"] }, { "/tiers/v1/status": { ...ACTIVE_TIER, organization_lifecycle_state: "" } });
    assert.equal(unknown.checks[0]!.status, "unknown");
    assert.equal(unknown.ok, true);
    const odd = await doctor({ only: ["tier"] }, { "/tiers/v1/status": { ...ACTIVE_TIER, organization_lifecycle_state: "hibernating" } });
    assert.equal(odd.checks[0]!.status, "inactive");
    assert.equal(odd.ok, false);
  });

  it("no tier of its own but reachable projects is an advisory TIER_MISSING_ON_OWN_ORG; nowhere to ship blocks", async () => {
    const reachable = await doctor({ only: ["tier"] }, { "/tiers/v1/status": { tier: null, active: false, organization_lifecycle_state: "active", projects: [{ id: "prj_x" }] } });
    assert.equal(reachable.ok, true);
    assert.equal(reachable.warnings[0]?.code, "TIER_MISSING_ON_OWN_ORG");
    const nowhere = await doctor({ only: ["tier"] }, { "/tiers/v1/status": { tier: null, active: false, organization_lifecycle_state: "active", projects: [] } });
    assert.equal(nowhere.ok, false);
    assert.equal(nowhere.blocking[0]?.check, "tier");
  });

  it("recovery posture: gaps name their remedy; no block is skipped, never a failure", async () => {
    const degraded = await doctor({ only: ["recovery_posture"] }, {
      "/agent/v1/me/status": { ...BASE_STATUS, recovery_posture: [{ org_id: "org-1111", vault_count: 2, control_plane_configured: false, source_backup_configured: false, custody_legacy_present: false }] },
    });
    const value = degraded.checks[0]!.value as { gaps: string[] };
    assert.equal(value.gaps.length, 2);
    assert.match(value.gaps[0]!, /run402 orgs invite create org-1111/);
    const absent = await doctor({ only: ["recovery_posture"] }, { "/agent/v1/me/status": BASE_STATUS });
    assert.equal(absent.checks[0]!.status, "skipped");
  });

  it("buildDoctorReport fails an unknown status closed as blocking", () => {
    const report = buildDoctorReport([{ name: "x", status: "brand_new_status" }, { name: "y", status: "ok" }]);
    assert.equal(report.ok, false);
    assert.deepEqual(report.blocking.map((b) => b.check), ["x"]);
  });
});

describe("r.doctor — only scoping and hooks", () => {
  it("only runs exactly the named checks, in registry order, and skips the others' work", async () => {
    const two = await doctor({ only: ["wallet", "config_dir"] });
    assert.deepEqual(two.checks.map((c) => c.name), ["config_dir", "wallet"]);
    const vaultOnly = await doctor({ only: ["vault"] });
    assert.deepEqual(vaultOnly.checks.map((c) => c.name), ["vault"]);
    assert.ok(!fetched.some((u) => /\/tiers\/v1|\/agent\/v1\/me\/status|\/status$/.test(u.split("?")[0]!)), `no tier/account/api read under only vault: ${fetched.join(", ")}`);
  });

  it("an unknown check name is BAD_USAGE listing the registry", async () => {
    await assert.rejects(r.doctor({ only: ["nope"] }), (err: unknown) => {
      const e = err as LocalError;
      return e.code === "BAD_USAGE" && (e.details as { known_checks: string[] }).known_checks.length === DOCTOR_CHECK_NAMES.length;
    });
  });

  it("cli_update comes from the caller's hook, and is skipped without one", async () => {
    const hooked = await doctor({ only: ["cli_update"], cliUpdate: async ({ refresh }) => ({ name: "cli_update", status: "ok", value: { refresh } }) });
    assert.deepEqual(hooked.checks[0]!.value, { refresh: false });
    const bare = await doctor({ only: ["cli_update"] });
    assert.equal(bare.checks[0]!.status, "skipped");
  });

  it("verbose wallet details carry faucet history without a funded or private-key field", async () => {
    saveWallet({ address: "0x" + "11".repeat(20), privateKey: "0x" + "22".repeat(32), rail: "x402", funded: false, created: "2026-09-16T00:00:00Z" });
    const report = await doctor({ only: ["wallet"], verbose: true });
    const details = (report.checks[0]!.value as { details: Record<string, unknown> }).details;
    assert.equal(details.faucet_used, false);
    assert.equal(details.funded, undefined);
    assert.equal(details.privateKey, undefined);
  });
});

describe("r.doctor — vault targeting", () => {
  it("reads the active project by default and an explicit project when named", async () => {
    await doctor({ only: ["vault"] });
    assert.deepEqual(vaultProjectReads, [ACTIVE_PROJECT]);
    const explicit = await doctor({ only: ["vault"], project: EXPLICIT_PROJECT });
    assert.deepEqual(vaultProjectReads, [EXPLICIT_PROJECT]);
    assert.equal((explicit.checks[0]!.value as { project_id: string }).project_id, EXPLICIT_PROJECT);
  });

  it("reports the resident helper only when the caller supplies it", async () => {
    const withDaemon = await doctor({ only: ["vault"], daemonStatus: async () => ({ running: false }) });
    assert.deepEqual((withDaemon.checks[0]!.value as { daemon: unknown }).daemon, { running: false });
    const without = await doctor({ only: ["vault"] });
    assert.equal("daemon" in (without.checks[0]!.value as object), false);
  });
});

describe("r.doctor — application-scoped source scan", () => {
  it("skips an unselected monorepo, scans the selected app, and treats an arbitrary scan dir as advisory", async () => {
    const root = join(tempDir, "multi-app");
    const app = join(root, "app");
    const sibling = join(root, "sibling");
    mkdirSync(app, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(app, "run402.json"), JSON.stringify({ site: { replace: { "index.html": "ok" } } }));
    writeFileSync(join(sibling, "bad.js"), 'fetch("/", {headers:{Authorization:"Bearer fixture"}}); await getSession();');
    const scan = (opts: Parameters<NodeRun402["doctor"]>[0]) => doctor({ only: ["source_scan"], noScan: false, ...opts });
    let report = await scan({ dir: root });
    assert.equal(report.checks[0]!.status, "skipped");
    report = await scan({ dir: app });
    assert.equal(report.ok, true);
    mkdirSync(join(app, "src"));
    writeFileSync(join(app, "src", "bad.js"), "await getSession();");
    report = await scan({ dir: app });
    assert.equal(report.ok, false);
    assert.equal((report.checks[0]!.value as { details: Array<{ file: string }> }).details[0]!.file, "src/bad.js");
    report = await scan({ scanDir: sibling });
    assert.equal(report.checks[0]!.severity, "advisory");
    assert.equal(report.ok, true);
  });
});
