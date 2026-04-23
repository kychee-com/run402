/**
 * Enforces the isomorphism contract: nothing under `sdk/src/` outside of
 * `sdk/src/node/` may import Node-only modules. The `@run402/sdk/node`
 * subpath is the only place where `fs`, `path`, `os`, `child_process`, etc.
 * are allowed.
 *
 * This guarantees the isomorphic entry point loads cleanly inside a V8
 * isolate (no filesystem, no process globals, no native modules).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const SDK_SRC = here; // = sdk/src/
const NODE_SUBPATH = join(SDK_SRC, "node");

const FORBIDDEN_MODULE_RE =
  /from\s+["']node:(fs|path|os|child_process|process|crypto|url|worker_threads|net|http|https|dns|tls)[^"']*["']/;
const FORBIDDEN_BARE_RE =
  /from\s+["'](fs|path|os|child_process|process)["']/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (s.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) out.push(p);
  }
  return out;
}

describe("isomorphic SDK entry", () => {
  it("has no Node-only imports outside sdk/src/node/", () => {
    const files = walk(SDK_SRC).filter(
      (f) => !f.startsWith(NODE_SUBPATH + "/") && !f.endsWith(".test.ts"),
    );
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (FORBIDDEN_MODULE_RE.test(line) || FORBIDDEN_BARE_RE.test(line)) {
          offenders.push({ file: relative(SDK_SRC, file), line: i + 1, text: line.trim() });
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Isomorphic kernel must not import Node-only modules. Offenders:\n${offenders
        .map((o) => `  ${o.file}:${o.line}: ${o.text}`)
        .join("\n")}`,
    );
  });
});
