/**
 * cli-conventions-gate.test.mjs — self-enforcing CLI argument conventions.
 *
 * Driven entirely by cli/lib/command-manifest.mjs:
 *   A. Manifest invariants (pure): ≤1 positional attribute per canonical form,
 *      legacyPositionalProject ⇒ projectScoped, completeness vs cli.mjs's
 *      dispatch switch (allowlist in SKIPPED_FAMILIES).
 *   B. Behavioral --project acceptance: every projectScoped entry is invoked
 *      in-process with `--project prj_test123 --json` appended; the gate only
 *      asserts those two flags are not REJECTED (other failures — mocked
 *      network shape mismatches, missing follow-ups — are tolerated).
 *   C. Behavioral --json acceptance for non-projectScoped entries.
 *   D. The conflicting-project-ids rule (BAD_USAGE).
 *
 * Harness pattern follows cli-argv.test.mjs: in-process module invocation,
 * process.exit stubbed to throw, console capture, a universal `{}` fetch mock,
 * keystore seeded with active project prj_test123.
 *
 * Note: `npm run build` must have run once so cli/core-dist exists (the test
 * script chain already builds).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMMAND_MANIFEST, SKIPPED_FAMILIES } from "./cli/lib/command-manifest.mjs";

const API = "https://test-api.run402.com";
const tempDir = mkdtempSync(join(tmpdir(), "run402-conventions-"));
const scratchDir = join(tempDir, "scratch");
mkdirSync(scratchDir, { recursive: true });
const fixtureFile = join(scratchDir, "gate-fixture.json");
writeFileSync(fixtureFile, "{}");
const outFile = join(scratchDir, "gate-out.bin");

process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;
process.env.RUN402_NPM_REGISTRY = `${API}/npm/`;
process.env.RUN402_WALLET_LABEL_SYNC = "0";
process.env.RUN402_GATE_FAKE_SERVICE_KEY = "svc_gate_fake_key";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();
let stdout = [];
let stderr = [];

function mockFetch() {
  return Promise.resolve(new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

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

before(async () => {
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  // Some commands (wallets bind/unbind, ci link workflow detection) touch the
  // cwd — run everything from the scratch dir so the repo is never mutated.
  process.chdir(scratchDir);
  const { saveProject, setActiveProjectId } = await import("./cli/core-dist/keystore.js");
  saveProject("prj_test123", {
    anon_key: "anon_test_key",
    service_key: "svc_test_key",
  });
  setActiveProjectId("prj_test123");
});

after(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  process.chdir(originalCwd);
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  delete process.env.RUN402_NPM_REGISTRY;
  delete process.env.RUN402_WALLET_LABEL_SYNC;
  delete process.env.RUN402_GATE_FAKE_SERVICE_KEY;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.exitCode = undefined;
  captureStop();
});

function substituteTokens(args) {
  return args.map((a) => {
    if (a === "__FIXTURE_FILE__") return fixtureFile;
    if (a === "__OUT_FILE__") return outFile;
    if (a === "__SCRATCH_DIR__") return scratchDir;
    return a;
  });
}

const commandId = (entry) => entry.path.join(" ");

async function invokeEntry(entry, extraFlags) {
  const argv = [...substituteTokens(entry.minimalArgs), ...extraFlags];
  const style = entry.runStyle ?? "sub";
  if (style === "deployV2") {
    const { runDeployV2 } = await import("./cli/lib/deploy-v2.mjs");
    return runDeployV2(entry.path[1], [...entry.path.slice(2), ...argv]);
  }
  const moduleName = entry.path[0] === "deploy" ? "deploy-v2" : entry.path[0];
  const { run } = await import(`./cli/lib/${moduleName}.mjs`);
  if (style === "flat") {
    return run([...entry.path.slice(1), ...argv]);
  }
  if (style === "merged") {
    return run(argv[0], argv.slice(1));
  }
  return run(entry.path[1], [...entry.path.slice(2), ...argv]);
}

// Scan captured stderr for a structured rejection of one of the convention
// flags. Any OTHER failure (mocked-network shape mismatch, missing follow-up
// args, auth) is tolerated — the gate only proves the flags PARSE.
function findFlagRejection(lines, flags) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const flag = obj?.details?.flag;
    if (!flags.includes(flag)) continue;
    if (obj.code === "UNKNOWN_FLAG") return { obj, line };
    if ((obj.code === "BAD_FLAG" || obj.code === "BAD_USAGE") &&
        /unknown|unsupported|requires a value|not valid/i.test(String(obj.message ?? ""))) {
      return { obj, line };
    }
  }
  return null;
}

async function runToleratingFailures(entry, extraFlags) {
  captureStart();
  try {
    await invokeEntry(entry, extraFlags);
  } catch {
    // Tolerated: process.exit(N) throws, SDK shape mismatches throw. The gate
    // only inspects stderr for flag rejections below.
  } finally {
    captureStop();
  }
  return { stdout: [...stdout], stderr: [...stderr] };
}

// ───────────────────────────────────────────────────────────────────────────
// A. Manifest invariants (pure — no command execution)
// ───────────────────────────────────────────────────────────────────────────

describe("command manifest invariants", () => {
  it("has unique, well-formed paths", () => {
    const seen = new Set();
    for (const entry of COMMAND_MANIFEST) {
      assert.ok(Array.isArray(entry.path) && entry.path.length >= 1, `bad path in ${JSON.stringify(entry)}`);
      for (const word of entry.path) {
        assert.equal(typeof word, "string");
        assert.ok(word.length > 0);
      }
      const id = commandId(entry);
      assert.ok(!seen.has(id), `duplicate manifest entry: ${id}`);
      seen.add(id);
    }
    assert.ok(COMMAND_MANIFEST.length > 100, "manifest should cover the whole CLI");
  });

  it("every entry has at most ONE positional attribute (variadic counts as one)", () => {
    for (const entry of COMMAND_MANIFEST) {
      assert.ok(Array.isArray(entry.positionals), `${commandId(entry)}: positionals must be an array`);
      assert.ok(
        entry.positionals.length <= 1,
        `${commandId(entry)}: canonical form declares ${entry.positionals.length} positional attributes — add flag alternatives`,
      );
      for (const pos of entry.positionals) {
        assert.equal(typeof pos.name, "string", `${commandId(entry)}: positional needs a name`);
        assert.equal(typeof pos.required, "boolean", `${commandId(entry)}: positional needs required`);
        assert.equal(typeof pos.variadic, "boolean", `${commandId(entry)}: positional needs variadic`);
      }
    }
  });

  it("projectScoped / legacyPositionalProject / minimalArgs are well-formed", () => {
    for (const entry of COMMAND_MANIFEST) {
      const id = commandId(entry);
      assert.equal(typeof entry.projectScoped, "boolean", `${id}: projectScoped must be boolean`);
      assert.equal(typeof entry.legacyPositionalProject, "boolean", `${id}: legacyPositionalProject must be boolean`);
      if (entry.legacyPositionalProject) {
        assert.ok(entry.projectScoped, `${id}: legacyPositionalProject implies projectScoped`);
      }
      assert.ok(Array.isArray(entry.minimalArgs), `${id}: minimalArgs must be an array`);
      for (const a of entry.minimalArgs) assert.equal(typeof a, "string", `${id}: minimalArgs must be strings`);
      assert.ok(
        !entry.minimalArgs.includes("--project"),
        `${id}: minimalArgs must not hardcode --project (the gate injects it)`,
      );
      if (entry.skipBehavioral !== undefined) {
        assert.equal(typeof entry.skipBehavioral, "string", `${id}: skipBehavioral must be a reason string`);
        assert.ok(entry.skipBehavioral.length > 0, `${id}: skipBehavioral reason must be non-empty`);
      }
      if (entry.runStyle !== undefined) {
        assert.ok(["sub", "flat", "merged", "deployV2"].includes(entry.runStyle), `${id}: unknown runStyle`);
      }
    }
  });

  it("covers every command family in cli.mjs's dispatch switch (allowlist for skipped)", () => {
    const source = readFileSync(new URL("./cli/cli.mjs", import.meta.url), "utf8");
    const families = new Set();
    for (const m of source.matchAll(/^\s*case "([a-z][a-z0-9-]*)": \{?/gm)) {
      families.add(m[1]);
    }
    assert.ok(families.size > 30, `expected the full dispatch switch, found ${families.size} families`);

    const manifestFamilies = new Set(COMMAND_MANIFEST.map((e) => e.path[0]));
    for (const family of families) {
      if (Object.prototype.hasOwnProperty.call(SKIPPED_FAMILIES, family)) continue;
      assert.ok(
        manifestFamilies.has(family),
        `cli.mjs dispatches "${family}" but the manifest has no entry for it — add one (or allowlist it with a reason in SKIPPED_FAMILIES)`,
      );
    }
    // Manifest must not invent families, and the allowlist must not go stale.
    for (const family of manifestFamilies) {
      assert.ok(families.has(family), `manifest family "${family}" is not in cli.mjs's dispatch switch`);
    }
    for (const family of Object.keys(SKIPPED_FAMILIES)) {
      assert.ok(families.has(family), `SKIPPED_FAMILIES lists "${family}" which cli.mjs no longer dispatches`);
      assert.ok(!manifestFamilies.has(family) || family === "apply",
        `"${family}" is both allowlisted and present in the manifest`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. Behavioral --project (+ --json) acceptance for projectScoped commands
// ───────────────────────────────────────────────────────────────────────────

describe("--project and --json are accepted by every projectScoped command", () => {
  for (const entry of COMMAND_MANIFEST.filter((e) => e.projectScoped)) {
    const id = commandId(entry);
    if (entry.skipBehavioral) {
      it(`${id} (structural only — ${entry.skipBehavioral})`, () => {});
      continue;
    }
    it(id, async () => {
      const { stderr: errLines } = await runToleratingFailures(entry, ["--project", "prj_test123", "--json"]);
      const rejection = findFlagRejection(errLines, ["--project", "--json"]);
      assert.ok(
        !rejection,
        `${id} rejected a convention flag: ${rejection?.line}`,
      );
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// C. Behavioral --json acceptance for non-projectScoped commands
// ───────────────────────────────────────────────────────────────────────────

describe("--json is accepted by every non-projectScoped command", () => {
  for (const entry of COMMAND_MANIFEST.filter((e) => !e.projectScoped)) {
    const id = commandId(entry);
    if (entry.skipBehavioral) {
      it(`${id} (structural only — ${entry.skipBehavioral})`, () => {});
      continue;
    }
    it(id, async () => {
      const { stderr: errLines } = await runToleratingFailures(entry, ["--json"]);
      const rejection = findFlagRejection(errLines, ["--json"]);
      assert.ok(
        !rejection,
        `${id} rejected --json: ${rejection?.line}`,
      );
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// D. Conflicting project ids rule
// ───────────────────────────────────────────────────────────────────────────

describe("conflicting project selectors", () => {
  // Earlier behavioral runs may have mutated the local credential cache (e.g.
  // `credentials project-keys remove`) — reseed before asserting.
  before(async () => {
    const { saveProject, setActiveProjectId } = await import("./cli/core-dist/keystore.js");
    saveProject("prj_test123", { anon_key: "anon_test_key", service_key: "svc_test_key" });
    setActiveProjectId("prj_test123");
  });

  it("secrets list prj_other_1 --project prj_test123 fails BAD_USAGE", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    let threw = null;
    captureStart();
    try {
      await run("list", ["prj_other_1", "--project", "prj_test123"]);
    } catch (err) {
      threw = err;
    } finally {
      captureStop();
    }
    assert.equal(threw?.message, "process.exit(1)");
    const line = stderr.map((s) => s.trim()).find((s) => s.startsWith("{"));
    assert.ok(line, `expected a JSON error envelope on stderr, got: ${stderr.join("\n")}`);
    const err = JSON.parse(line);
    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /Conflicting project ids/);
    assert.match(err.message, /prj_test123/);
    assert.match(err.message, /prj_other_1/);
  });

  it("matching flag + positional project ids are accepted (no conflict)", async () => {
    const { run } = await import("./cli/lib/secrets.mjs");
    captureStart();
    try {
      await run("list", ["prj_test123", "--project", "prj_test123"]);
    } catch (err) {
      captureStop();
      assert.fail(`agreeing selectors must not fail: ${err?.message} / ${stderr.join("\n")}`);
    } finally {
      captureStop();
    }
    const out = stdout.join("\n");
    assert.ok(out.includes("secrets"), `expected a secrets list payload, got: ${out}`);
  });
});
