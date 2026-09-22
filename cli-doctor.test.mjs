/**
 * run402 doctor — flag handling (kychee-com/run402#566, --project half).
 *
 * Before this fix, doctor accepted ANY flag silently — an unrecognized one
 * (a typo, or --project before this fix existed) was parsed as `undefined`
 * and quietly never looked at, in violation of the CLI's own "unknown flag
 * is BAD_USAGE" convention every other command follows (`argparse.mjs`'s
 * `assertKnownFlags`). This file locks two things: (1) a truly unknown flag
 * is now rejected, never silently ignored, and (2) `--project <id>` actually
 * TARGETS the gitvault check, outranking the repo-standing/active-project
 * default `gitvault-target.mjs` otherwise resolves.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = "https://test-api.run402.com";
const tempDir = mkdtempSync(join(tmpdir(), "run402-doctor-"));
// A scratch, NON-git cwd: doctor's gitvault check first asks
// `gitvault-target.mjs` whether cwd is a repository with its own pinned/
// remote-addressed vault (kychee-com/run402#559d) — running from inside
// THIS checkout would pick up its own `run402`/`origin` remotes and hit the
// network with an address-resolution read this test never intends to
// exercise. `--project` must win regardless, but the "no --project" case
// specifically wants the plain active-project fallback.
const scratchDir = join(tempDir, "scratch");

process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;

const ACTIVE_PROJECT = "prj_active_0001";
const EXPLICIT_PROJECT = "prj_explicit_0002";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
let stdout = [];
let stderr = [];
/** Every `/gitvault/v1/vaults?project_id=...` read the gitvault check made. */
let gitvaultProjectReads = [];
/** Every URL any check fetched this run, in order — used to prove --only skips the WORK of an unselected check, not just its output. */
let allFetchUrls = [];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function mockFetch(input) {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  allFetchUrls.push(url);
  if (url.includes("/gitvault/v1/vaults")) {
    const projectId = new URL(url).searchParams.get("project_id");
    gitvaultProjectReads.push(projectId);
    // No vault for either project — the gitvault check reports its ordinary
    // "vault: null" shape either way; this test only cares WHICH project_id
    // was read, not the vault contents.
    return json({}, 404);
  }
  // Every other endpoint (service/status, tier/status, me/status, ...):
  // an empty 200 is enough for doctor's own try/catch-wrapped checks to move on.
  return json({});
}

function captureStart() {
  stdout = [];
  stderr = [];
  gitvaultProjectReads = [];
  allFetchUrls = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
}
function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

const originalCwd = process.cwd();
let run;
before(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(scratchDir, { recursive: true });
  process.chdir(scratchDir);
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  ({ run } = await import("./cli/lib/doctor.mjs"));
  const { setActiveProjectId } = await import("./cli/core-dist/keystore.js");
  setActiveProjectId(ACTIVE_PROJECT);
});

after(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  process.chdir(originalCwd);
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.exitCode = undefined;
});

function firstJsonError(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
  return null;
}

describe("run402 doctor — unknown flags are BAD_USAGE, never silently ignored", () => {
  // kychee-com/run402#569's bonus bug: 'run402 doctor --human' was accepted,
  // silently ignored, and printed JSON anyway. Fixed as a side effect of
  // #566's --project half (doctor now validates every flag it is handed) —
  // pinned here directly so a regression on EITHER issue is caught.
  it("--human is not a doctor flag — BAD_USAGE, never silently-ignored JSON (kychee-com/run402#569)", async () => {
    captureStart();
    let threw = null;
    try {
      await run("--human", ["--no-scan"]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    assert.ok(threw, "--human must fail, not silently print the JSON report anyway");
    const err = firstJsonError(stderr);
    assert.ok(err, `expected a structured error envelope on stderr, got: ${stderr.join("\n")}`);
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details?.flag, "--human");
    // The bug's own symptom: no JSON report snuck onto stdout regardless.
    assert.equal(stdout.length, 0, `stdout must stay empty on a rejected flag, got: ${stdout.join("\n")}`);
  });

  it("a made-up flag is rejected", async () => {
    captureStart();
    let threw = null;
    try {
      await run("--this-flag-does-not-exist", ["--no-scan"]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    assert.ok(threw, "an unknown flag must fail, not silently proceed to print a report");
    const err = firstJsonError(stderr);
    assert.ok(err, `expected a structured error envelope on stderr, got: ${stderr.join("\n")}`);
    assert.equal(err.code, "UNKNOWN_FLAG");
    assert.equal(err.details?.flag, "--this-flag-does-not-exist");
  });

  it("every flag doctor documents in --help is still accepted (no regression from the new gate)", async () => {
    captureStart();
    let threw = null;
    try {
      await run("--verbose", ["--refresh", "--no-scan", "--scan-dir", tempDir, "--project", EXPLICIT_PROJECT]);
    } catch (err) {
      threw = err; // process.exit(N) throws in this harness — tolerated
    } finally {
      captureStop();
    }
    const err = firstJsonError(stderr);
    assert.equal(err, null, `a documented flag combination must not produce an error envelope: ${JSON.stringify(err)}`);
    assert.match(threw?.message ?? "", /process\.exit\(\d\)/, "doctor should still reach its normal exit, not an argv failure");
  });
});

describe("run402 doctor --project <id> — targets the gitvault check (kychee-com/run402#566)", () => {
  it("without --project, the gitvault check reads the ACTIVE project (unchanged default)", async () => {
    captureStart();
    try {
      await run("--no-scan", []);
    } catch {
      // process.exit(N) throws — tolerated
    } finally {
      captureStop();
    }
    assert.deepEqual(gitvaultProjectReads, [ACTIVE_PROJECT]);
  });

  it("--project <id> outranks the active project for the gitvault check", async () => {
    captureStart();
    try {
      await run("--project", [EXPLICIT_PROJECT, "--no-scan"]);
    } catch {
      // process.exit(N) throws — tolerated
    } finally {
      captureStop();
    }
    assert.deepEqual(gitvaultProjectReads, [EXPLICIT_PROJECT]);
  });

  it("the JSON report's gitvault check echoes the explicit project, not the active one", async () => {
    captureStart();
    try {
      await run("--project", [EXPLICIT_PROJECT, "--no-scan"]);
    } catch {
      // tolerated
    } finally {
      captureStop();
    }
    const reportLine = stdout.join("\n");
    const report = JSON.parse(reportLine);
    const gitvaultCheck = report.checks.find((c) => c.name === "gitvault");
    assert.ok(gitvaultCheck, "expected a gitvault check in the report");
    // A 404 read reports as `skipped` (see doctor.mjs's catch branch) — the
    // targeting proof is which project_id was READ (asserted above), not
    // this check's status, but assert the report still shapes as expected.
    assert.ok(["skipped", "ok", "warning"].includes(gitvaultCheck.status));
  });
});

// ─── --only <check> (kychee-com/run402#566, the remaining half) ──────────────
//
// Codex's exact ask was `--only gitvault`: it should run JUST the gitvault
// check and suppress everything else — INCLUDING the source-tree scan that
// buried the gitvault diagnosis under ~1,800 monorepo findings. Pinned here:
// (1) the report contains exactly the named check(s), nothing else; (2) the
// UNSELECTED checks' network work never runs at all (not merely hidden from
// the report — a skipped check costs nothing); (3) an unknown name is
// BAD_USAGE listing the valid registry; (4) --only composes with --project;
// (5) --only is rejected together with --buzz.

describe("run402 doctor --only <check> — scoped checks (kychee-com/run402#566)", () => {
  it("--only gitvault runs ONLY the gitvault check — report has exactly one check, named gitvault", async () => {
    captureStart();
    try {
      await run("--only", ["gitvault"]);
    } catch {
      // process.exit(N) throws — tolerated
    } finally {
      captureStop();
    }
    const report = JSON.parse(stdout.join("\n"));
    assert.deepEqual(report.checks.map((c) => c.name), ["gitvault"]);
  });

  it("--only gitvault suppresses the source-tree scan WITHOUT needing --no-scan", async () => {
    captureStart();
    try {
      await run("--only", ["gitvault"]);
    } catch {
      // tolerated
    } finally {
      captureStop();
    }
    const report = JSON.parse(stdout.join("\n"));
    assert.equal(report.checks.some((c) => c.name === "source_scan"), false);
  });

  it("--only gitvault does the WORK of only the gitvault check — no tier/api/account fetch happened", async () => {
    captureStart();
    try {
      await run("--only", ["gitvault"]);
    } catch {
      // tolerated
    } finally {
      captureStop();
    }
    // Exactly one network read: the gitvault vault lookup. Every other
    // check's own fetch (service/status, tier/status, me/status) must
    // never have been attempted — --only skips the WORK, not just the output.
    assert.equal(allFetchUrls.length, 1, `expected exactly one fetch; saw: ${JSON.stringify(allFetchUrls)}`);
    assert.match(allFetchUrls[0], /\/gitvault\/v1\/vaults/);
  });

  it("--only is repeatable — --only config_dir --only wallet runs exactly those two, in registry order", async () => {
    captureStart();
    try {
      await run("--only", ["config_dir", "--only", "wallet"]);
    } catch {
      // tolerated
    } finally {
      captureStop();
    }
    const report = JSON.parse(stdout.join("\n"));
    assert.deepEqual(report.checks.map((c) => c.name), ["config_dir", "wallet"]);
    assert.equal(allFetchUrls.length, 0, "neither config_dir nor wallet touches the network");
  });

  it("an unknown check name is BAD_USAGE, listing the valid registry", async () => {
    captureStart();
    let threw = null;
    try {
      await run("--only", ["not_a_real_check"]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    assert.ok(threw, "an unknown --only name must fail, not silently run every check");
    const err = firstJsonError(stderr);
    assert.ok(err, `expected a structured error envelope on stderr, got: ${stderr.join("\n")}`);
    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /not_a_real_check/);
    assert.ok(Array.isArray(err.details?.known_checks) && err.details.known_checks.includes("gitvault"));
    assert.match(err.hint ?? "", /gitvault/);
  });

  it("--only composes with --project: the gitvault check still targets the explicit project", async () => {
    captureStart();
    try {
      await run("--only", ["gitvault", "--project", EXPLICIT_PROJECT]);
    } catch {
      // tolerated
    } finally {
      captureStop();
    }
    assert.deepEqual(gitvaultProjectReads, [EXPLICIT_PROJECT]);
    const report = JSON.parse(stdout.join("\n"));
    assert.deepEqual(report.checks.map((c) => c.name), ["gitvault"]);
  });

  it("--only is not used with --buzz — rejected as BAD_USAGE before buzz mode runs", async () => {
    captureStart();
    let threw = null;
    try {
      await run("--only", ["gitvault", "--buzz"]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    assert.ok(threw, "--only combined with --buzz must fail");
    const err = firstJsonError(stderr);
    assert.ok(err, `expected a structured error envelope on stderr, got: ${stderr.join("\n")}`);
    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /--buzz/);
    // Buzz mode never started — no "mode": "buzz" report on stdout.
    assert.equal(stdout.join("\n").includes("\"mode\": \"buzz\""), false);
  });

  it("--only <check> ... is documented in --help, alongside the full registry", async () => {
    captureStart();
    try {
      await run("--help", []);
    } finally {
      captureStop();
    }
    const help = stdout.join("\n");
    assert.match(help, /--only <check>/);
    assert.match(help, /gitvault/);
    assert.match(help, /source_scan/);
  });
});

describe("run402 doctor — recovery_posture (gitvault-recovery-custody)", () => {
  /** Temporarily answer me/status with a specific recovery_posture payload (or none). */
  function withAccountStatus(body, fn) {
    const prior = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      if (url.includes("/agent/v1/me/status")) return json(body);
      return prior(input);
    };
    return fn().finally(() => { globalThis.fetch = prior; });
  }

  const BASE_STATUS = {
    contact: { email_status: "verified", passkey_status: "verified" },
    reachability: { reachable: true, verified_recipient_count: 1, sources: [], skipped_last_90d: 0 },
    skipped_notifications: [],
    critical_items: [],
    runtime: { stale_function_count: 0, stale_functions: [] },
  };

  async function runOnlyPosture() {
    captureStart();
    try {
      await run("--only", ["recovery_posture"]);
    } catch {
      // process.exit(N) throws — tolerated
    } finally {
      captureStop();
    }
    const report = JSON.parse(stdout.join("\n"));
    assert.deepEqual(report.checks.map((c) => c.name), ["recovery_posture"]);
    return report.checks[0];
  }

  it("degraded posture renders each gap with its remedy (Anticipatory), one line per fact per org", async () => {
    const check = await withAccountStatus({
      ...BASE_STATUS,
      recovery_posture: [{
        org_id: "org-1111", vault_count: 2,
        control_plane_configured: false,
        source_wrapper_configured: false,
        source_backup_configured: false,
        custody_legacy_present: false,
        human_owner_with_login_count: 0, source_custodian_count: 0, wrapper_backed_custodian_count: 0,
        state_generation: 3,
      }],
    }, runOnlyPosture);
    assert.equal(check.status, "warning");
    assert.equal(check.value.gaps.length, 2);
    assert.match(check.value.gaps[0], /org org-1111 \(2 vaults\): no human owner with a working control-plane login/);
    assert.match(check.value.gaps[0], /run402 org invite create org-1111/);
    assert.match(check.value.gaps[1], /no human member holds a working source-access key/);
    assert.match(check.value.gaps[1], /console\.run402\.com\/account/);
    assert.equal(check.value.orgs[0].state_generation, 3);
  });

  it("legacy custody warns even when source backup exists (a single-credential key is a standing risk)", async () => {
    const check = await withAccountStatus({
      ...BASE_STATUS,
      recovery_posture: [{
        org_id: "org-2222", vault_count: 1,
        control_plane_configured: true,
        source_wrapper_configured: false,
        source_backup_configured: true,
        custody_legacy_present: true,
        human_owner_with_login_count: 1, source_custodian_count: 1, wrapper_backed_custodian_count: 0,
        state_generation: 1,
      }],
    }, runOnlyPosture);
    assert.equal(check.status, "warning");
    assert.equal(check.value.gaps.length, 1);
    assert.match(check.value.gaps[0], /legacy custody/);
    assert.match(check.value.gaps[0], /recovery code/);
  });

  it("healthy posture is ok and still carries the org facts", async () => {
    const check = await withAccountStatus({
      ...BASE_STATUS,
      recovery_posture: [{
        org_id: "org-3333", vault_count: 1,
        control_plane_configured: true,
        source_wrapper_configured: true,
        source_backup_configured: true,
        custody_legacy_present: false,
        human_owner_with_login_count: 1, source_custodian_count: 1, wrapper_backed_custodian_count: 1,
        state_generation: 4,
      }],
    }, runOnlyPosture);
    assert.equal(check.status, "ok");
    assert.equal(check.value.orgs.length, 1);
  });

  it("no vault-owning org is ok with an empty orgs list (nothing to lose, nothing to advise)", async () => {
    const check = await withAccountStatus({ ...BASE_STATUS, recovery_posture: [] }, runOnlyPosture);
    assert.equal(check.status, "ok");
    assert.deepEqual(check.value.orgs, []);
  });

  it("a gateway without the block reports skipped, never a doctor failure", async () => {
    const check = await withAccountStatus(BASE_STATUS, runOnlyPosture);
    assert.equal(check.status, "skipped");
  });
});

// ─── ok vs warnings[] — the "can this agent ship" split ──────────────────────
//
// An agent user's report: `ok: false` with only two NON-blocking findings
// (contact passkey not bound, recovery posture degraded on another org) —
// and it could still deploy. `ok` now answers exactly one question (is any
// check blocking?) and is structural, never a status-string allowlist; every
// check carries `severity`, advisory gaps ride in `warnings[]`, and
// `blocking[]` is what to fix when `ok` is false. The tier check's status
// is a fixed vocabulary that never leaks a tier NAME into the status slot.

describe("run402 doctor — ok is 'can this agent ship'; warnings[] carries the non-blocking gaps", () => {
  /** Answer specific API paths with fixed bodies; everything else falls through to the suite mock. */
  function withRoutes(routes, fn) {
    const prior = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      for (const [needle, body] of Object.entries(routes)) {
        if (url.includes(needle)) return json(body);
      }
      return prior(input);
    };
    return fn().finally(() => { globalThis.fetch = prior; });
  }

  async function runDoctor(args) {
    captureStart();
    let threw = null;
    try {
      await run(args[0], args.slice(1));
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    return { exit: threw?.message ?? null, report: JSON.parse(stdout.join("\n")) };
  }

  const ACTIVE_TIER = {
    tier: "team",
    active: true,
    organization_lifecycle_state: "active",
    lease_expires_at: "2099-01-01T00:00:00.000Z",
    projects: [{ id: ACTIVE_PROJECT, name: "active" }],
  };
  const ACCOUNT_WITH_GAPS = {
    contact: { email_status: "verified", passkey_status: "not_bound" },
    reachability: { reachable: true, verified_recipient_count: 1, sources: [], skipped_last_90d: 0 },
    skipped_notifications: [],
    critical_items: [],
    runtime: { stale_function_count: 0, stale_functions: [] },
    recovery_posture: [{
      org_id: "org-other", vault_count: 1,
      control_plane_configured: false,
      source_wrapper_configured: true,
      source_backup_configured: true,
      custody_legacy_present: false,
      human_owner_with_login_count: 0, source_custodian_count: 1, wrapper_backed_custodian_count: 1,
      state_generation: 2,
    }],
  };
  const ONLY_SHIP_CHECKS = ["--only", "tier", "--only", "account_health", "--only", "recovery_posture", "--only", "runtime_staleness"];

  it("the user's exact shape — passkey not bound + degraded posture on another org — is ok:true, exit 0, with both gaps in warnings[]", async () => {
    const { exit, report } = await withRoutes({
      "/tiers/v1/status": ACTIVE_TIER,
      "/agent/v1/me/status": ACCOUNT_WITH_GAPS,
    }, () => runDoctor(ONLY_SHIP_CHECKS));
    assert.equal(exit, "process.exit(0)", "advisory warnings must never change the exit code");
    assert.equal(report.ok, true);
    assert.deepEqual(report.blocking, []);
    assert.ok(report.warnings.length >= 2, `expected the two advisory gaps in warnings[], got ${JSON.stringify(report.warnings)}`);
    const forCheck = (name) => report.warnings.filter((w) => w.check === name);
    assert.match(forCheck("account_health")[0].message, /contact passkey not bound/);
    assert.match(forCheck("recovery_posture")[0].message, /org org-other \(1 vault\): no human owner/);
    for (const w of report.warnings) {
      assert.equal(typeof w.check, "string");
      assert.equal(typeof w.message, "string");
    }
    // The advisory checks are still reported as `warning` with their gaps —
    // checks[] is unchanged apart from the added severity.
    assert.equal(report.checks.find((c) => c.name === "account_health").status, "warning");
    assert.equal(report.checks.find((c) => c.name === "account_health").severity, "advisory");
    assert.equal(report.checks.find((c) => c.name === "tier").severity, "info");
  });

  it("a frozen tier is ok:false, exit 1, with tier as the blocking entry (GH-570 semantics kept)", async () => {
    const { exit, report } = await withRoutes({
      "/tiers/v1/status": { ...ACTIVE_TIER, tier: "prototype", active: false, organization_lifecycle_state: "frozen" },
      "/agent/v1/me/status": ACCOUNT_WITH_GAPS,
    }, () => runDoctor(ONLY_SHIP_CHECKS));
    assert.equal(exit, "process.exit(1)");
    assert.equal(report.ok, false);
    assert.equal(report.blocking.length, 1);
    assert.equal(report.blocking[0].check, "tier");
    assert.equal(report.blocking[0].status, "frozen");
    assert.equal(typeof report.blocking[0].message, "string");
    const tier = report.checks.find((c) => c.name === "tier");
    assert.equal(tier.status, "frozen");
    assert.equal(tier.severity, "blocking");
    assert.equal(tier.value.tier, "prototype");
    assert.equal(tier.value.lifecycle, "frozen");
    // The advisory gaps are STILL surfaced alongside the blocker.
    assert.ok(report.warnings.some((w) => w.check === "account_health"));
  });

  it("every check carries severity ∈ {blocking, advisory, info}, on a full run, --only, and --refresh alike", async () => {
    for (const args of [["--no-scan"], ["--only", "gitvault"], ["--refresh", "--no-scan"]]) {
      const { report } = await runDoctor(args);
      assert.ok(report.checks.length > 0);
      for (const c of report.checks) {
        assert.ok(["blocking", "advisory", "info"].includes(c.severity), `${c.name} (${args.join(" ")}) has severity ${c.severity}`);
      }
      assert.equal(typeof report.ok, "boolean");
      assert.ok(Array.isArray(report.blocking));
      assert.ok(Array.isArray(report.warnings));
      assert.equal(report.ok, report.blocking.length === 0, "ok is exactly 'blocking[] is empty'");
      assert.ok(report.checks.every((c) => (c.severity === "blocking") === report.blocking.some((b) => b.check === c.name)));
    }
  });

  it("the tier status is a fixed vocabulary — an active tier reports 'ok', never the tier name, and value.tier/value.lifecycle carry the facts", async () => {
    const { report } = await withRoutes({ "/tiers/v1/status": ACTIVE_TIER }, () => runDoctor(["--only", "tier"]));
    const tier = report.checks[0];
    assert.equal(tier.status, "ok");
    assert.equal(tier.severity, "info");
    assert.equal(tier.value.tier, "team");
    assert.equal(tier.value.lifecycle, "active");
    assert.equal(tier.value.active, true);
    // A gateway that (against its own contract) returns an empty lifecycle
    // string used to fall through to `tierName ?? "missing"` and put "team"
    // in the status slot — which then failed the ok allowlist.
    const { report: r2 } = await withRoutes({ "/tiers/v1/status": { ...ACTIVE_TIER, organization_lifecycle_state: "" } }, () => runDoctor(["--only", "tier"]));
    assert.equal(r2.checks[0].status, "unknown");
    assert.equal(r2.checks[0].severity, "info");
    assert.equal(r2.ok, true);
    // An unrecognized non-active lifecycle string is 'inactive' (blocking), never echoed raw.
    const { report: r3 } = await withRoutes({ "/tiers/v1/status": { ...ACTIVE_TIER, organization_lifecycle_state: "hibernating" } }, () => runDoctor(["--only", "tier"]));
    assert.equal(r3.checks[0].status, "inactive");
    assert.equal(r3.checks[0].value.lifecycle, "hibernating");
    assert.equal(r3.ok, false);
  });

  it("a wallet with no tier of its own but reachable projects on another org is 'missing' as an ADVISORY (it can still ship there); with nowhere to ship it blocks", async () => {
    const { exit, report } = await withRoutes({
      "/tiers/v1/status": { tier: null, active: false, organization_lifecycle_state: "active", projects: [{ id: "prj_other_org_0001", name: "theirs" }] },
    }, () => runDoctor(["--only", "tier"]));
    assert.equal(exit, "process.exit(0)");
    assert.equal(report.ok, true);
    assert.equal(report.checks[0].status, "missing");
    assert.equal(report.checks[0].severity, "advisory");
    assert.equal(report.checks[0].value.reachable_projects, 1);
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0].check, "tier");
    assert.equal(report.warnings[0].code, "TIER_MISSING_ON_OWN_ORG");
    assert.match(report.warnings[0].message, /can reach 1 project/);

    const { exit: exit2, report: r2 } = await withRoutes({
      "/tiers/v1/status": { tier: null, active: false, organization_lifecycle_state: "active", projects: [] },
    }, () => runDoctor(["--only", "tier"]));
    assert.equal(exit2, "process.exit(1)");
    assert.equal(r2.ok, false);
    assert.equal(r2.checks[0].status, "missing");
    assert.equal(r2.checks[0].severity, "blocking");
    assert.equal(r2.blocking[0].check, "tier");
  });
});

describe("doctor selected application source scope", () => {
  it("skips an unselected monorepo, ignores siblings, and agrees with apply on selected source errors", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const root = join(tempDir, "multi-app");
    const app = join(root, "app");
    const sibling = join(root, "sibling");
    mkdirSync(app, { recursive: true }); mkdirSync(sibling);
    writeFileSync(join(app, "run402.json"), JSON.stringify({ site: { replace: { "index.html": "ok" } } }));
    writeFileSync(join(sibling, "bad.js"), 'fetch("/", {headers:{Authorization:"Bearer fixture"}}); await getSession();');
    async function report(args) {
      captureStart();
      try { await run("--only", ["source_scan", ...args]); } catch (err) { assert.match(err.message, /process.exit/); } finally { captureStop(); }
      return JSON.parse(stdout.join("\n"));
    }
    let value = await report(["--dir", root]);
    assert.equal(value.checks[0].status, "skipped");
    assert.equal(value.checks[0].value.scope, "unscoped");
    value = await report(["--dir", app]);
    assert.equal(value.ok, true);
    mkdirSync(join(app, "src"));
    writeFileSync(join(app, "src", "bad.js"), "await getSession();");
    value = await report(["--dir", app]);
    assert.equal(value.ok, false);
    assert.equal(value.checks[0].value.details[0].file, "src/bad.js");
    assert.equal(value.checks[0].value.app_root, app);
    value = await report(["--scan-dir", sibling]);
    assert.equal(value.checks[0].severity, "advisory");
    assert.equal(value.ok, true);
  });
});

it("verbose wallet reports faucet history without a funded or private-key field", async () => {
  const { saveWallet } = await import("./cli/lib/config.mjs");
  saveWallet({ address: "0x" + "11".repeat(20), privateKey: "0x" + "22".repeat(32), rail: "x402", funded: false, created: "2026-09-16T00:00:00Z" });
  captureStart();
  try { await run("--verbose", ["--only", "wallet"]); } catch (err) { assert.match(err.message, /process.exit/); } finally { captureStop(); }
  const details = JSON.parse(stdout.join("\n")).checks.find(c => c.name === "wallet").value.details;
  assert.equal(details.faucet_used, false);
  assert.equal(details.funded, undefined);
  assert.equal(details.privateKey, undefined);
});
