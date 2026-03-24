/**
 * SQL syntax validation test.
 *
 * Extracts every sql() call from the gateway source code and validates
 * it against the PostgreSQL parser (libpg-query). Catches syntax errors
 * at test time — no running database needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(__dirname, "..");

/** Recursively find all .ts files (excluding tests and node_modules). */
function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...findTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

interface SqlCall {
  file: string;
  line: number;
  query: string;
}

/** Extract sql(...) calls from source files. */
function extractSqlCalls(): SqlCall[] {
  const calls: SqlCall[] = [];
  const files = findTsFiles(SRC_DIR);

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");

    // Match sql(`...`) and sql("...") — handles multiline backtick strings
    // Strategy: find "sql(" then extract the string argument
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Find sql( with backtick
      const backtickMatches = [...line.matchAll(/\bsql\(`/g)];
      for (const m of backtickMatches) {
        // Collect the full backtick string (may span multiple lines)
        const startIdx = (m.index ?? 0) + 5; // after sql(`
        let query = line.slice(startIdx);
        let j = i;
        while (!query.includes("`)") && j < lines.length - 1) {
          j++;
          query += "\n" + lines[j];
        }
        // Trim the closing backtick + paren
        const endIdx = query.indexOf("`)");
        if (endIdx >= 0) {
          query = query.slice(0, endIdx);
        }
        // Skip if it has template interpolation (dynamic SQL)
        if (query.includes("${")) continue;
        calls.push({ file: file.replace(SRC_DIR, ""), line: i + 1, query });
      }

      // Match sql("...") — single-line only
      const quoteMatches = [...line.matchAll(/\bsql\("([^"]+)"\)/g)];
      for (const m of quoteMatches) {
        calls.push({ file: file.replace(SRC_DIR, ""), line: i + 1, query: m[1] });
      }
    }
  }

  return calls;
}

/** Replace $1, $2, etc. with NULL for parsing. */
function replaceParams(query: string): string {
  return query.replace(/\$\d+/g, "NULL");
}

describe("SQL syntax validation", () => {
  it("finds sql() calls in the codebase", () => {
    const calls = extractSqlCalls();
    assert.ok(calls.length > 100, `Expected >100 sql() calls, found ${calls.length}`);
  });

  it("all sql() calls are syntactically valid PostgreSQL", async () => {
    const { parse } = await import("libpg-query");
    const calls = extractSqlCalls();
    const errors: string[] = [];

    for (const call of calls) {
      const normalized = replaceParams(call.query.trim());
      if (!normalized) continue;
      try {
        await parse(normalized);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${call.file}:${call.line}\n  SQL: ${normalized.slice(0, 100)}...\n  Error: ${msg}`);
      }
    }

    if (errors.length > 0) {
      assert.fail(
        `${errors.length} SQL syntax error(s) found:\n\n${errors.join("\n\n")}`,
      );
    }
  });
});
