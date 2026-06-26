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
//   - Bare string actions and legacy `{ action: ... }` objects are rejected.
//   - SDK/gateway-provided `next_actions` pass through at runtime; this scanner
//     targets literals authored in cli/lib source files.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_LIB_DIR = join(__dirname, "cli", "lib");

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

  it("CLI-authored next_actions literals are typed objects, not legacy strings or action keys", () => {
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
            reason: "legacy action discriminator",
          });
        }
      }
    }

    if (violations.length > 0) {
      const summary = violations
        .map((v) => `  cli/lib/${v.file}:${v.line} -> ${v.reason}`)
        .join("\n");
      assert.fail(
        `Found ${violations.length} legacy CLI-authored next_actions shape${violations.length === 1 ? "" : "s"}:\n${summary}\n\n` +
        `CLI-authored next_actions must use typed objects such as ` +
        `\`{ type: "edit_request", command: "run402 ..." }\`. Preserve SDK/gateway-provided actions at runtime; ` +
        `do not author bare strings or \`{ action: ... }\` in cli/lib.`,
      );
    }
  });
});
