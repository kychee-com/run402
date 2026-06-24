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
});
