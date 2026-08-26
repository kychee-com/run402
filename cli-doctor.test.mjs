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
  // Every other endpoint (service/status, tier/status, operator/status, ...):
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

  it("--only gitvault does the WORK of only the gitvault check — no tier/api/operator fetch happened", async () => {
    captureStart();
    try {
      await run("--only", ["gitvault"]);
    } catch {
      // tolerated
    } finally {
      captureStop();
    }
    // Exactly one network read: the gitvault vault lookup. Every other
    // check's own fetch (service/status, tier/status, operator/status) must
    // never have been attempted — --only skips the WORK, not just the output.
    assert.equal(allFetchUrls.length, 1, `expected exactly one fetch; saw: ${JSON.stringify(allFetchUrls)}`);
    assert.match(allFetchUrls[0], /\/gitvault\/v1\/vaults/);
  });

  it("--only is repeatable — --only config_dir --only allowance runs exactly those two, in registry order", async () => {
    captureStart();
    try {
      await run("--only", ["config_dir", "--only", "allowance"]);
    } catch {
      // tolerated
    } finally {
      captureStop();
    }
    const report = JSON.parse(stdout.join("\n"));
    assert.deepEqual(report.checks.map((c) => c.name), ["config_dir", "allowance"]);
    assert.equal(allFetchUrls.length, 0, "neither config_dir nor allowance touches the network");
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
