/**
 * cli-suggestions-gate.test.mjs — did-you-mean suggestions + doctor pre-init
 * fixes (item 12), driven by cli/lib/command-manifest.mjs.
 *
 *   A. Top-level typo (`run402 projcts`) → UNKNOWN_COMMAND with
 *      `Did you mean projects?` + details.closest.
 *   B. Subcommand typos in several families → UNKNOWN_SUBCOMMAND with the
 *      right details.closest.
 *   C. Never-regress: EVERY manifest family with subcommands routes its
 *      unknown-subcommand path through the shared failUnknownSubcommand
 *      helper (asserted via details.closest / details.known_subcommands on
 *      the envelope).
 *   D. Doctor pre-init: the projects-check hint is state-aware (no "already
 *      set up" claim when the allowance is missing) and check failure
 *      messages are composed context-first (no mid-sentence ". while ").
 *
 * Harness pattern follows cli-conventions-gate.test.mjs: in-process module
 * invocation, process.exit stubbed to throw, console capture, mocked fetch.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMMAND_MANIFEST, SKIPPED_FAMILIES } from "./cli/lib/command-manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "cli", "cli.mjs");
const API = "https://test-api.run402.com";
const tempDir = mkdtempSync(join(tmpdir(), "run402-suggestions-"));

process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;
process.env.RUN402_WALLET_LABEL_SYNC = "0";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
let stdout = [];
let stderr = [];

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
}

function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stderrEnvelope() {
  const line = stderr.map((s) => s.trim()).find((s) => s.startsWith("{"));
  assert.ok(line, `expected a JSON error envelope on stderr, got: ${stderr.join("\n")}`);
  return JSON.parse(line);
}

async function expectExit1(fn) {
  let threw = null;
  captureStart();
  try {
    await fn();
  } catch (err) {
    threw = err;
  } finally {
    captureStop();
  }
  assert.equal(threw?.message, "process.exit(1)", `expected process.exit(1); stderr:\n${stderr.join("\n")}`);
}

before(() => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({}));
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
});

after(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  delete process.env.RUN402_WALLET_LABEL_SYNC;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.exitCode = undefined;
  captureStop();
  globalThis.fetch = () => Promise.resolve(jsonResponse({}));
});

// ───────────────────────────────────────────────────────────────────────────
// A. Top-level did-you-mean
// ───────────────────────────────────────────────────────────────────────────

describe("top-level command did-you-mean", () => {
  it("run402 projcts suggests projects (UNKNOWN_COMMAND + details.closest)", () => {
    const spawnEnv = { ...process.env, RUN402_CONFIG_DIR: tempDir };
    delete spawnEnv.RUN402_WALLET;
    delete spawnEnv.RUN402_PROFILE;
    const result = spawnSync(process.execPath, [CLI_PATH, "projcts"], {
      env: spawnEnv,
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.code, "UNKNOWN_COMMAND");
    assert.match(parsed.message, /Did you mean projects\?/);
    assert.deepEqual(parsed.details.closest, ["projects"]);
    assert.equal(parsed.details.command, "projcts");
  });

  it("a distant typo still errors UNKNOWN_COMMAND without a bogus suggestion", () => {
    const spawnEnv = { ...process.env, RUN402_CONFIG_DIR: tempDir };
    delete spawnEnv.RUN402_WALLET;
    delete spawnEnv.RUN402_PROFILE;
    const result = spawnSync(process.execPath, [CLI_PATH, "zzzzzzzzzzzzzzz"], {
      env: spawnEnv,
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.code, "UNKNOWN_COMMAND");
    assert.doesNotMatch(parsed.message, /Did you mean/);
    assert.deepEqual(parsed.details.closest, []);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. Subcommand did-you-mean (representative typos)
// ───────────────────────────────────────────────────────────────────────────

describe("subcommand did-you-mean", () => {
  const cases = [
    { family: "secrets", typo: "lst", expected: "list" },
    { family: "functions", typo: "dploy", expected: "deploy" },
    { family: "projects", typo: "provsion", expected: "provision" },
  ];
  for (const { family, typo, expected } of cases) {
    it(`${family} ${typo} suggests ${expected}`, async () => {
      const { run } = await import(`./cli/lib/${family}.mjs`);
      await expectExit1(() => run(typo, []));
      const parsed = stderrEnvelope();
      assert.equal(parsed.code, "UNKNOWN_SUBCOMMAND");
      assert.match(parsed.message, new RegExp(`Did you mean ${expected}\\?`));
      assert.deepEqual(parsed.details.closest, [expected]);
      assert.equal(parsed.details.subcommand, typo);
      assert.ok(parsed.details.known_subcommands.includes(expected));
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// C. Never-regress: every family with subcommands uses the shared helper
// ───────────────────────────────────────────────────────────────────────────

// Families where an unknown first word is NOT a subcommand error by design.
const UNKNOWN_SUB_SKIP = {
  up: "an unknown first word is a positional repo/path source, not a subcommand",
};

// Families dispatched with a single argv array instead of (sub, rest).
const ARRAY_STYLE_FAMILIES = new Set(["deploy"]);

describe("every manifest family with subcommands routes unknown subs through failUnknownSubcommand", () => {
  const families = [...new Set(
    COMMAND_MANIFEST.filter((entry) => entry.path.length >= 2).map((entry) => entry.path[0]),
  )].sort();
  assert.ok(families.length > 30, `expected most families to declare subcommands, got ${families.length}`);

  for (const family of families) {
    if (Object.prototype.hasOwnProperty.call(SKIPPED_FAMILIES, family)) continue;
    if (UNKNOWN_SUB_SKIP[family]) {
      it(`${family} (skipped — ${UNKNOWN_SUB_SKIP[family]})`, () => {});
      continue;
    }
    it(family, async () => {
      const { run } = await import(`./cli/lib/${family}.mjs`);
      await expectExit1(() =>
        ARRAY_STYLE_FAMILIES.has(family)
          ? run(["definitely-not-a-sub"])
          : run("definitely-not-a-sub", []),
      );
      const parsed = stderrEnvelope();
      assert.equal(parsed.code, "UNKNOWN_SUBCOMMAND", `${family} must fail UNKNOWN_SUBCOMMAND`);
      assert.equal(parsed.details.subcommand, "definitely-not-a-sub");
      // The shared-helper fingerprint: closest + known_subcommands arrays.
      assert.ok(
        Array.isArray(parsed.details.closest) || Array.isArray(parsed.details.known_subcommands),
        `${family} unknown-subcommand envelope lacks closest/known_subcommands — route it through failUnknownSubcommand`,
      );
      assert.ok(
        parsed.details.known_subcommands.length > 0,
        `${family} known_subcommands should not be empty`,
      );
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// D. Doctor pre-init fixes
// ───────────────────────────────────────────────────────────────────────────

describe("doctor pre-init hints and check-failure composition", () => {
  const SIWX_MESSAGE =
    "Wallet signature required. Sign a SIWX message and send it in the SIGN-IN-WITH-X header. " +
    "See the WWW-Authenticate / payment-required header for the challenge.";

  function installDoctorFetchMock() {
    globalThis.fetch = (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/tiers/v1/status")) {
        return Promise.resolve(jsonResponse({ code: "UNAUTHORIZED", message: SIWX_MESSAGE }, 401));
      }
      if (url.includes("/agent/v1/operator/status")) {
        return Promise.resolve(jsonResponse({ code: "UNAUTHORIZED", message: SIWX_MESSAGE }, 401));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    };
  }

  async function runDoctor() {
    const { run } = await import("./cli/lib/doctor.mjs");
    let threw = null;
    captureStart();
    try {
      await run("--no-scan", []);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    assert.match(threw?.message ?? "", /^process\.exit\(/, `doctor should exit; stderr:\n${stderr.join("\n")}`);
    const text = stdout.join("\n");
    assert.ok(text.trim().startsWith("{"), `expected doctor JSON, got: ${text}`);
    return JSON.parse(text);
  }

  it("with an empty config dir, the projects hint points at run402 init (never 'already set up')", async () => {
    // Fresh, never-initialized profile dir.
    const preInitDir = join(tempDir, "pre-init");
    mkdirSync(preInitDir, { recursive: true });
    const previous = process.env.RUN402_CONFIG_DIR;
    process.env.RUN402_CONFIG_DIR = preInitDir;
    installDoctorFetchMock();
    try {
      const report = await runDoctor();
      const allowance = report.checks.find((check) => check.name === "allowance");
      assert.equal(allowance.status, "missing");
      const projects = report.checks.find((check) => check.name === "projects");
      assert.ok(projects, "projects check present");
      if (projects.hint) {
        assert.doesNotMatch(projects.hint, /already set up/);
        assert.match(projects.hint, /run402 init/);
      }
      const tier = report.checks.find((check) => check.name === "tier");
      assert.ok(tier, "tier check present");
      assert.doesNotMatch(tier.message ?? "", /\. while /);
    } finally {
      process.env.RUN402_CONFIG_DIR = previous;
    }
  });

  it("tier / operator_health / runtime_staleness failures are composed context-first (no '. while ')", async () => {
    // Seeded allowance so the SIWX-signed request actually reaches the
    // mocked gateway and comes back 401 with the period-terminated message
    // that used to produce "…challenge. while checking tier status".
    const seededDir = join(tempDir, "seeded");
    mkdirSync(seededDir, { recursive: true });
    const previous = process.env.RUN402_CONFIG_DIR;
    process.env.RUN402_CONFIG_DIR = seededDir;
    installDoctorFetchMock();
    try {
      const { saveAllowance } = await import("./cli/lib/config.mjs");
      saveAllowance({
        address: "0x0000000000000000000000000000000000000001",
        privateKey: "0x" + "11".repeat(32),
        rail: "x402",
        funded: true,
        created: "2026-07-01T00:00:00.000Z",
      });
      const report = await runDoctor();
      const tier = report.checks.find((check) => check.name === "tier");
      assert.equal(tier.status, "error");
      assert.match(tier.message, /^tier status check failed: /);
      assert.doesNotMatch(tier.message, /\. while /);
      assert.match(tier.message, /SIGN-IN-WITH-X/);
      for (const name of ["operator_health", "runtime_staleness"]) {
        const check = report.checks.find((c) => c.name === name);
        assert.ok(check, `${name} check present`);
        if (check.message) {
          assert.doesNotMatch(check.message, /\. while /, `${name} message must not be mid-sentence composed`);
          assert.match(check.message, /^operator status check failed: /);
        }
      }
    } finally {
      process.env.RUN402_CONFIG_DIR = previous;
    }
  });
});
