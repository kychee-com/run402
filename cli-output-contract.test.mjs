// Drift-protection for the CLI stdout output contract.
//
// Contract (see the cli-output-shape OpenSpec spec):
//   - Success-path stdout SHALL NOT contain a top-level `status` field.
//   - The stderr error envelope (in cli/lib/sdk-errors.mjs) DOES use
//     `status: "error"` as a sentinel; that is the allowlisted exception.
//   - Per-item `status` fields inside payload objects (e.g. doctor's
//     `checks[].status`) are NOT envelope statuses and are not matched
//     by this scanner (the regex only matches `JSON.stringify({ status:`).
//
// If you are tempted to add a new `JSON.stringify({ status: ... })` to a
// CLI subcommand handler, instead emit the raw payload. If the mutation
// has no natural payload, echo the affected resource identifiers plus an
// explicit boolean state field (e.g. `{ key, project_id, deleted: true }`).
//
// Contract for CLI-authored next actions:
//   - `next_actions[]` entries SHALL be typed objects with a `type` field.
//   - Bare string actions and invalid `{ action: ... }` objects are rejected.
//   - SDK/gateway-provided `next_actions` pass through at runtime; this scanner
//     targets literals authored in cli/lib source files.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_LIB_DIR = join(__dirname, "cli", "lib");
const CLI_PATH = join(__dirname, "cli", "cli.mjs");
const GROUPED_COMMANDS = [
  "admin",
  "agent",
  "ai",
  "allowance",
  "apps",
  "archives",
  "assets",
  "auth",
  "billing",
  "cache",
  "cdn",
  "ci",
  "cloud",
  "contracts",
  "core",
  "credentials",
  "domains",
  "email",
  "functions",
  "grants",
  "image",
  "jobs",
  "message",
  "notifications",
  "operator",
  "org",
  "projects",
  "secrets",
  "sender-domain",
  "service",
  "sites",
  "subdomains",
  "tier",
  "transfer",
  "wallets",
  "webhook-secret",
];

// Allowlist: file basenames whose `JSON.stringify({ status: ...` emissions
// are legitimately stderr-bound error envelopes.
const STDERR_ERROR_ENVELOPE_ALLOWLIST = new Set([
  "sdk-errors.mjs",
]);

// Match `JSON.stringify({ status: "<literal>"` allowing whitespace and
// newlines between paren, brace, and the `status` key. Multi-line tolerant.
const ENVELOPE_PATTERN = /JSON\.stringify\s*\(\s*\{\s*status\s*:\s*"([^"]+)"/g;

function extractNextActionArrays(source) {
  const arrays = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const keyIndex = source.indexOf("next_actions", searchFrom);
    if (keyIndex === -1) break;
    searchFrom = keyIndex + "next_actions".length;

    const colonIndex = source.indexOf(":", searchFrom);
    if (colonIndex === -1) continue;
    let cursor = colonIndex + 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== "[") continue;

    const end = findBalancedArrayEnd(source, cursor);
    if (end === -1) continue;
    arrays.push({ start: cursor, text: source.slice(cursor, end + 1) });
    searchFrom = end + 1;
  }
  return arrays;
}

function findBalancedArrayEnd(source, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineNumberFor(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

describe("CLI output contract drift protection", () => {
  it("no cli/lib/*.mjs file emits a top-level `status` field on success paths", () => {
    const files = readdirSync(CLI_LIB_DIR).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
    const violations = [];

    for (const file of files) {
      if (STDERR_ERROR_ENVELOPE_ALLOWLIST.has(file)) continue;
      const fullPath = join(CLI_LIB_DIR, file);
      const source = readFileSync(fullPath, "utf-8");
      const matches = source.matchAll(ENVELOPE_PATTERN);
      for (const match of matches) {
        const offset = match.index ?? 0;
        const lineNumber = source.slice(0, offset).split("\n").length;
        const statusValue = match[1];
        violations.push({ file, line: lineNumber, statusValue });
      }
    }

    if (violations.length > 0) {
      const summary = violations
        .map((v) => `  cli/lib/${v.file}:${v.line} → JSON.stringify({ status: "${v.statusValue}" ...`)
        .join("\n");
      assert.fail(
        `Found ${violations.length} disallowed top-level \`status\` emission${violations.length === 1 ? "" : "s"} ` +
        `in CLI success paths:\n${summary}\n\n` +
        `The CLI stdout envelope contract (cli-output-shape OpenSpec spec) forbids a top-level ` +
        `\`status\` field on success-path stdout. Emit the raw payload instead. For mutations with no natural ` +
        `payload, echo the affected resource identifiers plus an explicit boolean state field ` +
        `(e.g. \`{ key, project_id, deleted: true }\`). The only allowlisted emission is the stderr error ` +
        `envelope in cli/lib/sdk-errors.mjs.`,
      );
    }
  });

  it("the stderr error envelope in sdk-errors.mjs continues to use status: \"error\"", () => {
    // This is a positive assertion: sdk-errors.mjs MUST keep the
    // `status: "error"` sentinel on stderr so consumers can branch on it.
    const source = readFileSync(join(CLI_LIB_DIR, "sdk-errors.mjs"), "utf-8");
    assert.match(source, /status:\s*"error"/, "sdk-errors.mjs must keep the `status: \"error\"` sentinel for the stderr error envelope");
  });

  it("CLI-authored next_actions literals are typed objects, not strings or action keys", () => {
    const files = readdirSync(CLI_LIB_DIR).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
    const violations = [];

    for (const file of files) {
      const fullPath = join(CLI_LIB_DIR, file);
      const source = readFileSync(fullPath, "utf-8");
      for (const array of extractNextActionArrays(source)) {
        const body = array.text.slice(1, -1).trimStart();
        if (body.startsWith("\"") || body.startsWith("'") || body.startsWith("`")) {
          violations.push({
            file,
            line: lineNumberFor(source, array.start),
            reason: "bare string next_actions entry",
          });
          continue;
        }
        if (/[{,]\s*(?:"action"|'action'|action)\s*:/.test(array.text)) {
          violations.push({
            file,
            line: lineNumberFor(source, array.start),
            reason: "invalid action discriminator",
          });
        }
      }
    }

    if (violations.length > 0) {
      const summary = violations
        .map((v) => `  cli/lib/${v.file}:${v.line} -> ${v.reason}`)
        .join("\n");
      assert.fail(
        `Found ${violations.length} invalid CLI-authored next_actions shape${violations.length === 1 ? "" : "s"}:\n${summary}\n\n` +
        `CLI-authored next_actions must use typed objects such as ` +
        `\`{ type: "edit_request", command: "run402 ..." }\`. Preserve SDK/gateway-provided actions at runtime; ` +
        `do not author bare strings or \`{ action: ... }\` in cli/lib.`,
      );
    }
  });

  it("run402 status default output stays JSON-only even when a named wallet is selected", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "run402-status-output-"));
    try {
      const profileDir = join(tempDir, "profiles", "agent-a");
      mkdirSync(profileDir, { recursive: true });
      // Exists for fail-closed wallet selection, but reads as "no allowance"
      // so status stays offline/hermetic.
      writeFileSync(join(profileDir, "allowance.json"), "{", { mode: 0o600 });

      const result = spawnSync(process.execPath, [CLI_PATH, "status"], {
        env: {
          ...process.env,
          RUN402_CONFIG_DIR: tempDir,
          RUN402_WALLET: "agent-a",
        },
        encoding: "utf-8",
        timeout: 10_000,
      });

      assert.equal(result.status, 0, `run402 status failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.equal(result.stderr, "", `stderr must stay empty for status success output; got ${JSON.stringify(result.stderr)}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.wallet, null);
      assert.equal(typeof parsed.target.kind, "string");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run402 status --json is a JSON-only compatibility no-op", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "run402-status-json-"));
    try {
      const profileDir = join(tempDir, "profiles", "agent-a");
      mkdirSync(profileDir, { recursive: true });
      // Exists for fail-closed wallet selection, but reads as "no allowance"
      // so status stays offline/hermetic.
      writeFileSync(join(profileDir, "allowance.json"), "{", { mode: 0o600 });

      const result = spawnSync(process.execPath, [CLI_PATH, "status", "--json"], {
        env: {
          ...process.env,
          RUN402_CONFIG_DIR: tempDir,
          RUN402_WALLET: "agent-a",
        },
        encoding: "utf-8",
        timeout: 10_000,
      });

      assert.equal(result.status, 0, `run402 status --json failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.equal(result.stderr, "", `stderr must stay empty for status --json success output; got ${JSON.stringify(result.stderr)}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.wallet, null);
      assert.equal(typeof parsed.target.kind, "string");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run402 allowance export is JSON by default", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "run402-allowance-export-json-"));
    const address = "0x1111111111111111111111111111111111111111";
    try {
      writeFileSync(join(tempDir, "allowance.json"), JSON.stringify({
        address,
        privateKey: `0x${"2".repeat(64)}`,
        created: "2026-07-02T00:00:00.000Z",
      }), { mode: 0o600 });

      const result = spawnSync(process.execPath, [CLI_PATH, "allowance", "export"], {
        env: {
          ...process.env,
          RUN402_CONFIG_DIR: tempDir,
        },
        encoding: "utf-8",
        timeout: 10_000,
      });

      assert.equal(result.status, 0, `run402 allowance export failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.equal(result.stderr, "");
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed, { address });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("unknown root commands emit a JSON error envelope only", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "run402-unknown-command-"));
    const env = { ...process.env, RUN402_CONFIG_DIR: tempDir };
    delete env.RUN402_WALLET;
    delete env.RUN402_PROFILE;
    let result;
    try {
      result = spawnSync(process.execPath, [CLI_PATH, "does-not-exist"], {
        env,
        encoding: "utf-8",
        timeout: 10_000,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.code, "UNKNOWN_COMMAND");
    assert.equal(parsed.details.command, "does-not-exist");
  });

  it("unknown subcommands emit JSON envelopes instead of prose plus help", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "run402-unknown-subcommand-"));
    const env = { ...process.env, RUN402_CONFIG_DIR: tempDir };
    delete env.RUN402_WALLET;
    delete env.RUN402_PROFILE;
    let result;
    try {
      result = spawnSync(process.execPath, [CLI_PATH, "service", "does-not-exist"], {
        env,
        encoding: "utf-8",
        timeout: 10_000,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.code, "UNKNOWN_SUBCOMMAND");
    assert.equal(parsed.details.command, "service");
    assert.equal(parsed.details.subcommand, "does-not-exist");
  });

  it("every grouped command reports unknown subcommands as JSON-only errors", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "run402-unknown-subcommands-"));
    const env = { ...process.env, RUN402_CONFIG_DIR: tempDir };
    delete env.RUN402_WALLET;
    delete env.RUN402_PROFILE;

    try {
      for (const command of GROUPED_COMMANDS) {
        const result = spawnSync(process.execPath, [CLI_PATH, command, "does-not-exist"], {
          env,
          encoding: "utf-8",
          timeout: 10_000,
        });

        assert.equal(result.status, 1, `${command} should exit 1 for unknown subcommand`);
        assert.equal(result.stdout, "", `${command} wrote stdout prose: ${JSON.stringify(result.stdout)}`);
        const parsed = JSON.parse(result.stderr);
        assert.equal(parsed.status, "error", `${command} stderr must be an error envelope`);
        assert.equal(parsed.code, "UNKNOWN_SUBCOMMAND", `${command} should use UNKNOWN_SUBCOMMAND`);
        assert.equal(parsed.details.subcommand, "does-not-exist", `${command} should echo the bad subcommand`);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("CLI lib unknown-command branches cannot reintroduce raw prose output", () => {
    const offenders = [];
    for (const entry of readdirSync(CLI_LIB_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const file = join(CLI_LIB_DIR, entry.name);
      const source = readFileSync(file, "utf-8");
      if (/console\.error\(\s*(?:`|'|")Unknown/.test(source)) {
        offenders.push(`${entry.name}: raw console.error Unknown`);
      }
      if (/default:\s*[\s\S]{0,180}console\.log\(HELP\);\s*process\.exit\(1\)/.test(source)) {
        offenders.push(`${entry.name}: default branch prints HELP before exit(1)`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("npm start stays stdout-clean for stdio MCP hosts", () => {
    const npmrc = readFileSync(join(__dirname, ".npmrc"), "utf-8");
    assert.match(npmrc, /^loglevel=silent$/m, "root .npmrc must keep npm lifecycle banners off stdout");

    const tempDir = mkdtempSync(join(tmpdir(), "run402-npm-start-"));
    try {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "run402-mcp-stdio-smoke", scripts: { start: "node sleeper.js" } }, null, 2),
      );
      writeFileSync(join(tempDir, "sleeper.js"), "setTimeout(function () {}, 2000);\n");
      writeFileSync(join(tempDir, ".npmrc"), npmrc);

      const result = spawnSync("npm", ["start"], {
        cwd: tempDir,
        encoding: "utf-8",
        timeout: 500,
      });

      assert.equal(result.stdout, "", `npm start wrote pre-protocol stdout: ${JSON.stringify(result.stdout)}`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
