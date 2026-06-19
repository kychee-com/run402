import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const ABSOLUTE_TIME_FIELD =
  /(?:^|[\s{;,(])([A-Za-z_][A-Za-z0-9_]*(?:_at|At|timestamp|Timestamp|ingestion_time|expirationTime|issuedAt|observedAt))\??\s*:\s*([^;,\n}]+)/g;

const NUMERIC_TIME_UNITS = /(?:_ms|Ms|_seconds|Seconds|_in|In)$/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (["core-dist", "dist", "node_modules"].includes(entry)) continue;
      files.push(...sourceFiles(path));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".integ.ts")) continue;
    files.push(path);
  }
  return files;
}

describe("SDK timestamp conventions", () => {
  it("keeps public absolute-time fields as ISO strings, never Date or numeric epochs", () => {
    const violations: string[] = [];

    for (const file of sourceFiles(ROOT)) {
      const rel = relative(ROOT, file);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        let match: RegExpExecArray | null;
        ABSOLUTE_TIME_FIELD.lastIndex = 0;
        while ((match = ABSOLUTE_TIME_FIELD.exec(line)) !== null) {
          const [, name, rawType] = match;
          const type = rawType.trim();
          if (NUMERIC_TIME_UNITS.test(name)) continue;
          if (type.includes("??") || /new\s+Date|\.\w+\(/.test(type)) continue;
          if (!/\b(?:string|number|Date|null|undefined)\b/.test(type)) continue;
          if (/\bDate\b|\bnumber\b/.test(type) || !/\bstring\b/.test(type)) {
            violations.push(`${rel}:${index + 1}: ${name}: ${type}`);
          }
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      [
        "Absolute instants in public SDK contracts must be ISO-8601 strings.",
        "Use string/string|null/string? for *_at, *At, timestamp, ingestion_time, issuedAt, expirationTime, and observedAt.",
        "Use numeric fields only when the unit is explicit in the name, e.g. expires_in, duration_ms, elapsedMs.",
        ...violations,
      ].join("\n"),
    );
  });
});
