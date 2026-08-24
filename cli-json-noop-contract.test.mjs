/**
 * cli-json-noop-contract.test.mjs — drift protection for the `--json` no-op
 * contract (see the cli-output-shape OpenSpec spec).
 *
 * The rule, in one sentence: **JSON is always the default on stdout, and
 * `--json` is a universally-accepted no-op that never changes what stdout
 * says.**
 *
 * This rule drifted twice before this gate existed, in opposite directions at
 * the same time — the spec mandated an `UNKNOWN_FLAG` rejection the CLI never
 * implemented, while `run402 errors` gated stdout on the flag in six places
 * and shipped prose by default on the post-deploy promote gate. Acceptance
 * alone was tested; inertness and absence-of-gating were not, which is exactly
 * the hole both drifts lived in. Hence three independent axes:
 *
 *   A. ACCEPTANCE  — no command rejects `--json`. (Also covered behaviorally by
 *      cli-conventions-gate.test.mjs; here we pin the STRUCTURAL guarantee that
 *      acceptance comes from the shared baseline set, so it cannot be silently
 *      replaced by per-command allowlist entries.)
 *   B. INERTNESS   — passing `--json` produces byte-identical stdout.
 *   C. NO GATE     — no source construct branches stdout on the flag.
 *
 * Axis C is a static scan rather than only a behavioral test on purpose: a
 * behavioral test can prove the commands it enumerates are inert, but only a
 * scan proves the ABSENCE of the construct in a command nobody thought to
 * enumerate. Neither axis subsumes the other.
 *
 * Sanctioned exception, and the only one: `run402 assets put --json` is a
 * preserved deprecated alias for `--stream` (NDJSON progress events, not a
 * format switch). It is an `=== "--json"` equality test that sets a stream
 * flag, not a membership test bound to an output gate, so it does not match
 * the axis-C pattern and needs no allowlist entry.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_LIB_DIR = join(__dirname, "cli", "lib");
const CLI_PATH = join(__dirname, "cli", "cli.mjs");

function libSources() {
  return readdirSync(CLI_LIB_DIR)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .map((f) => ({ file: f, source: readFileSync(join(CLI_LIB_DIR, f), "utf-8") }));
}

// ───────────────────────────────────────────────────────────────────────────
// A. Acceptance is structural, not per-command
// ───────────────────────────────────────────────────────────────────────────

describe("A. --json acceptance is structural", () => {
  it("argparse bakes --json into the shared baseline known-flag set", () => {
    const source = readFileSync(join(CLI_LIB_DIR, "argparse.mjs"), "utf-8");
    assert.match(
      source,
      /const\s+ALWAYS_KNOWN_FLAGS\s*=\s*\[[^\]]*"--json"/,
      "ALWAYS_KNOWN_FLAGS must contain --json so every command inherits acceptance",
    );
    assert.match(
      source,
      /new Set\(\[\s*\.\.\.knownFlags\s*,\s*\.\.\.ALWAYS_KNOWN_FLAGS\s*\]\)/,
      "assertKnownFlags must merge ALWAYS_KNOWN_FLAGS into the per-command known set",
    );
  });

  it("a command whose own allowlist omits --json still accepts it", () => {
    // `cache inspect` never names --json in its own assertKnownFlags call.
    // Acceptance must therefore come from the baseline set. We assert the CLI
    // does not emit an UNKNOWN_FLAG envelope for --json; any other failure
    // (network, auth) is tolerated — this axis is about flag parsing only.
    const tempDir = mkdtempSync(join(tmpdir(), "run402-json-accept-"));
    try {
      const result = spawnSync(
        process.execPath,
        [CLI_PATH, "cache", "inspect", "https://example.com/", "--json"],
        {
          env: { ...process.env, RUN402_CONFIG_DIR: tempDir, RUN402_API_BASE: "http://127.0.0.1:1" },
          encoding: "utf-8",
          timeout: 20_000,
        },
      );
      const stderr = result.stderr ?? "";
      assert.ok(
        !/"code"\s*:\s*"UNKNOWN_FLAG"/.test(stderr) || !/--json/.test(stderr),
        `cache inspect rejected --json:\n${stderr}`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. Inertness — --json never changes stdout
// ───────────────────────────────────────────────────────────────────────────

// Commands that produce deterministic stdout offline. Each runs twice against
// an identical fresh config dir, once with --json appended.
//
// stdout only, never stderr (design D4): stderr legitimately carries update
// notices, progress narration, and deprecation warnings that vary run to run
// and are explicitly NOT part of the JSON contract.
const INERTNESS_CASES = [
  { name: "status", argv: ["status"] },
  { name: "wallets list", argv: ["wallets", "list"] },
  { name: "projects current", argv: ["projects", "current"] },
];

function runOffline(argv) {
  const tempDir = mkdtempSync(join(tmpdir(), "run402-json-inert-"));
  try {
    const profileDir = join(tempDir, "profiles", "agent-a");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "allowance.json"), "{", { mode: 0o600 });
    const result = spawnSync(process.execPath, [CLI_PATH, ...argv], {
      env: {
        ...process.env,
        RUN402_CONFIG_DIR: tempDir,
        RUN402_WALLET: "agent-a",
        // Unroutable base: any network attempt fails fast and identically for
        // both runs of a pair, keeping the comparison hermetic.
        RUN402_API_BASE: "http://127.0.0.1:1",
        RUN402_WALLET_LABEL_SYNC: "0",
      },
      encoding: "utf-8",
      timeout: 20_000,
    });
    return result.stdout ?? "";
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("B. --json is inert on stdout", () => {
  for (const { name, argv } of INERTNESS_CASES) {
    it(`${name} — stdout is byte-identical with and without --json`, () => {
      const without = runOffline(argv);
      const with_ = runOffline([...argv, "--json"]);
      assert.ok(
        without.trim().length > 0,
        `\`run402 ${argv.join(" ")}\` produced no stdout offline, so the ` +
          `byte-comparison below would pass vacuously. Fix the fixture or drop the case.`,
      );
      assert.equal(
        with_,
        without,
        `--json changed stdout for \`run402 ${argv.join(" ")}\`.\n` +
          `JSON is the default and --json is a no-op; a command that renders ` +
          `differently under the flag is gating output on it.\n` +
          `--- without ---\n${without}\n--- with ---\n${with_}`,
      );
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// C. No source construct gates stdout on --json
// ───────────────────────────────────────────────────────────────────────────

// A gate looks like: bind a `--json` membership test to a variable, then use
// that variable as a condition guarding a stdout emission.
//
//     const json = a.includes("--json");   // ← binding
//     if (!json) console.log(render(page)); // ← gate
//
// Deliberately NOT matched (these read the flag without selecting output):
//   - the `--human` / `--json` conflict checks in up.mjs and errors.mjs, which
//     test the flag INLINE inside a condition whose body calls fail(), never
//     console.log, and never bind it to a variable;
//   - `assets put`'s `=== "--json"` equality alias for --stream.
//
// Both are excluded by the pattern's SHAPE rather than by an allowlist, per
// design D3/risk 4 — an allowlist entry for them would blunt the gate.
const JSON_BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.includes\(\s*["']--json["']\s*\)/g;

// Allowlist is intentionally EMPTY. Only two kinds of entry could ever be
// legitimate — the sanctioned `assets put --stream` alias, and a flag
// selecting a non-stdout destination — and neither matches the pattern above,
// so neither needs one. A third kind of entry is a signal the rule is being
// worked around; treat it as such in review rather than widening this set.
const OUTPUT_GATE_ALLOWLIST = new Set([]);

/** Body of the `if (...)` beginning at `ifIndex`: braced block or single statement. */
function ifBody(source, ifIndex) {
  const open = source.indexOf("(", ifIndex);
  if (open === -1) return "";
  let depth = 0;
  let i = open;
  for (; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  let cursor = i + 1;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (source[cursor] === "{") {
    let braces = 0;
    for (let j = cursor; j < source.length; j += 1) {
      if (source[j] === "{") braces += 1;
      else if (source[j] === "}") {
        braces -= 1;
        if (braces === 0) return source.slice(cursor, j + 1);
      }
    }
    return source.slice(cursor);
  }
  const nl = source.indexOf("\n", cursor);
  return source.slice(cursor, nl === -1 ? source.length : nl);
}

function findOutputGates(source) {
  const hits = [];
  for (const match of source.matchAll(JSON_BINDING)) {
    const variable = match[1];
    const conditional = new RegExp(`\\bif\\s*\\(\\s*!?\\s*${variable}\\b`, "g");
    for (const cond of source.matchAll(conditional)) {
      if (/console\.log|process\.stdout\.write/.test(ifBody(source, cond.index))) {
        hits.push({
          variable,
          line: source.slice(0, cond.index).split("\n").length,
        });
      }
    }
  }
  return hits;
}

describe("C. no source construct gates stdout on --json", () => {
  for (const { file, source } of libSources()) {
    it(file, () => {
      const hits = findOutputGates(source);
      if (OUTPUT_GATE_ALLOWLIST.has(file)) {
        assert.ok(hits.length > 0, `${file} is allowlisted but has no gate — drop the stale entry`);
        return;
      }
      assert.deepEqual(
        hits,
        [],
        `${file} gates stdout on --json at ${hits.map((h) => `line ${h.line} (via \`${h.variable}\`)`).join(", ")}.\n` +
          `JSON is always the default; expose human output behind --human instead ` +
          `(see cli/lib/up.mjs and cli/lib/errors.mjs).`,
      );
    });
  }

  it("the scanner actually detects a reintroduced gate", () => {
    // Guards against the gate rotting into a no-op that passes vacuously.
    const reintroduced = [
      'const json = a.includes("--json");',
      "if (!json) console.log(renderHumanList(page));",
    ].join("\n");
    assert.equal(findOutputGates(reintroduced).length, 1);
  });

  it("the scanner does not flag the --human/--json conflict check", () => {
    const conflictCheck = [
      'const human = a.includes("--human");',
      'if (human && a.includes("--json")) {',
      '  fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json." });',
      "}",
      "if (!human) console.log(JSON.stringify(page, null, 2));",
    ].join("\n");
    assert.deepEqual(findOutputGates(conflictCheck), []);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D. `run402 errors` emits JSON by default (the flipped command, non-vacuously)
// ───────────────────────────────────────────────────────────────────────────
//
// Axis B runs subprocesses offline, where `errors` reaches the network and
// therefore writes nothing to stdout — a byte-comparison of two empty strings
// proves nothing. This section drives the command IN-PROCESS against a mocked
// gateway page so stdout is real, then asserts the three properties that
// actually define the flip: JSON with no flags, byte-identical under `--json`,
// and rendered prose only under `--human`.

const PAGE = {
  errors: [{
    fingerprint_id: "fp_9b21fa",
    kind: "uncaught",
    message: "TypeError: cannot read properties of undefined",
    count: 3,
    function_name: "checkout",
    first_seen_at: "2026-08-20T10:00:00.000Z",
    last_seen_at: "2026-08-20T12:00:00.000Z",
  }],
  verdict: { new_fingerprints: 0, release_id: "rel_01JX", invocations: 42 },
  has_more: false,
  next_cursor: null,
};

const cliOriginalLog = console.log;
const cliOriginalError = console.error;
const cliOriginalExit = process.exit;
const cliOriginalFetch = globalThis.fetch;
let errorsTempDir;

async function runErrors(args) {
  const out = [];
  console.log = (...a) => out.push(a.map(String).join(" "));
  console.error = () => {};
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  try {
    const { run } = await import("./cli/lib/errors.mjs");
    await run(args[0], args.slice(1));
  } catch {
    // process.exit throws by design; gate paths use it for exit codes.
  } finally {
    console.log = cliOriginalLog;
    console.error = cliOriginalError;
    process.exit = cliOriginalExit;
  }
  return out.join("\n");
}

describe("D. run402 errors emits JSON by default", () => {
  before(async () => {
    errorsTempDir = mkdtempSync(join(tmpdir(), "run402-errors-flip-"));
    process.env.RUN402_CONFIG_DIR = errorsTempDir;
    process.env.RUN402_API_BASE = "https://test-api.run402.com";
    globalThis.fetch = async () =>
      new Response(JSON.stringify(PAGE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const { saveProject, setActiveProjectId } = await import("./cli/core-dist/keystore.js");
    saveProject("prj_test123", { anon_key: "anon_test_key", service_key: "svc_test_key" });
    setActiveProjectId("prj_test123");
  });

  after(() => {
    globalThis.fetch = cliOriginalFetch;
    delete process.env.RUN402_CONFIG_DIR;
    delete process.env.RUN402_API_BASE;
    rmSync(errorsTempDir, { recursive: true, force: true });
  });

  it("no flags -> stdout parses as JSON carrying the gateway page", async () => {
    const out = await runErrors(["--project", "prj_test123"]);
    assert.ok(out.trim().length > 0, "expected stdout; the mock page never reached the renderer");
    const parsed = JSON.parse(out);
    assert.equal(parsed.errors[0].fingerprint_id, "fp_9b21fa");
    assert.ok(!/cannot read properties of undefined\s+\|/.test(out), "stdout must not be the rendered table");
  });

  it("--json produces byte-identical stdout (true no-op)", async () => {
    const without = await runErrors(["--project", "prj_test123"]);
    const with_ = await runErrors(["--project", "prj_test123", "--json"]);
    assert.equal(with_, without);
  });

  it("--human renders prose instead of JSON", async () => {
    const out = await runErrors(["--project", "prj_test123", "--human"]);
    assert.ok(out.trim().length > 0, "expected rendered output under --human");
    assert.throws(() => JSON.parse(out), "stdout under --human must not be JSON");
  });

  it("--human with --json is a usage error and emits nothing on stdout", async () => {
    const out = await runErrors(["--project", "prj_test123", "--human", "--json"]);
    assert.equal(out.trim(), "");
  });
});
