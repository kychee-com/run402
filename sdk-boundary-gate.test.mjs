/**
 * sdk-boundary-gate.test.mjs — the CLI and the MCP server reach Run402 only
 * through @run402/sdk.
 *
 * Vision principle 13: fix behavior at its deepest capable owner —
 * server → SDK → CLI → documentation. The server owns shared policy and
 * authoritative validation; the typed SDK owns local context and reusable
 * workflow behavior; the CLI and MCP are thin adapters that parse, delegate,
 * and render. A `fetch(` in an adapter is a second HTTP client growing beside
 * the SDK: it drifts silently and the two disagree in production rather than
 * in CI. This gate is what keeps the principle a test instead of prose.
 *
 * Every production source under `cli/` (`cli.mjs`, `lib/`,
 * `git-remote-run402.mjs`) and `src/` (the MCP server) is scanned — skipping
 * tests, `node_modules`, `dist`, `core-dist`, and the SDK copy `npm run build`
 * stages under `cli/sdk` — for:
 *
 *   A. a bare `fetch(` call. A member call such as `sdk.pay.fetch(` or
 *      `auth.fetch(` is the SDK's own method, not a client of its own, and
 *      passes.
 *   B. an import of `node:http`, `node:https`, or `undici`.
 *   C. a Run402 API host written as a URL literal (`api.run402.com` followed
 *      by a path or a closing quote). Prose that merely names the host passes;
 *      the SDK's `getApiBase()` is the one place the base URL is decided.
 *
 * The only way past the gate is ALLOWLIST below: the file, a pattern for the
 * exact line, and a one-line reason — a host that is not Run402's (a chain
 * RPC, GitHub's API), or a listener rather than a client. An entry that no
 * longer matches anything fails too, so the allowlist cannot go stale.
 *
 * Harness pattern follows cli-conventions-gate.test.mjs: pure source scan,
 * no command execution, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PRINCIPLE =
  "Vision principle #13 — fix behavior at its deepest capable owner: server → SDK → CLI → documentation. " +
  "CLI and MCP code is a thin adapter over @run402/sdk and never talks to Run402 on its own.";

const REMEDY =
  "Two ways out: (b) if the call targets Run402's API, move it into the SDK as a typed method " +
  "(sdk/src/namespaces/*.ts, or sdk/src/node/* for Node-only behavior) and call that method here — " +
  "the SDK is the deepest capable owner; or (a) if the host is not Run402's (a chain RPC, GitHub's API, " +
  "an npm registry), add an ALLOWLIST entry in sdk-boundary-gate.test.mjs naming the file, the line " +
  "pattern, and a one-line reason.";

/** Production roots: the CLI package and the MCP server. */
const SCAN_ROOTS = ["cli", "src"];

/** Directory names never scanned, at any depth. */
const SKIP_DIRS = new Set(["node_modules", "dist", "core-dist"]);

/** `npm run build` stages a copy of the SDK under cli/sdk; it IS the SDK, not an adapter. */
const SKIP_PATHS = new Set(["cli/sdk"]);

const SOURCE_FILE = /\.(?:mjs|cjs|js|ts)$/;

/**
 * Lines a listed file may contain. Each pattern must still match a line in
 * that file (a stale entry fails), and a file may only be listed for lines the
 * rules below would otherwise flag.
 */
const ALLOWLIST = [
  {
    file: "cli/lib/ci.mjs",
    pattern: /fetch\(`https:\/\/api\.github\.com\/repos\//,
    reason: "GitHub's API, for the repository id a CI binding pins; not a Run402 host",
  },
  {
    file: "cli/lib/sign-in.mjs",
    pattern: /^import \{ createServer \} from "node:http";$/,
    reason: "the loopback listener the browser redirects to during `run402 login`; a server, never a client of the gateway",
  },
  {
    file: "cli/lib/init-astro.mjs",
    pattern: /Cross-origin-safe fetch \(auto-forwards actor context/,
    reason: "template prose written into the user's scaffold README, not a call the CLI makes",
  },
];

/** The rules, each a `{ id, pattern, label }` the scan applies per line. */
const RULES = [
  {
    id: "bare-fetch",
    // Not preceded by `.`, a word character, or `$` — so `sdk.pay.fetch(`,
    // `auth.fetch(`, `paidFetch(`, and `${fetch(` style template text pass,
    // while `fetch(`, `await fetch(`, `(fetch(`, and `= fetch(` are caught.
    pattern: /(^|[^.\w$])fetch\s*\(/,
    label: "bare fetch( — a second HTTP client beside the SDK kernel",
  },
  {
    id: "http-import",
    pattern: /\b(?:from\s+|require\(\s*|import\(\s*)["'](?:node:https?|undici)["']/,
    label: "imports node:http / node:https / undici — all HTTP goes through the SDK kernel",
  },
  {
    id: "api-host-literal",
    pattern: /api\.run402\.com(?=[/"'`])/,
    label: "spells the Run402 API host as a URL literal — the SDK's getApiBase() decides the base URL",
  },
];

function walk(absDir, relDir, out) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.has(rel)) continue;
      walk(join(absDir, entry.name), rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_FILE.test(entry.name)) continue;
    if (entry.name.includes(".test.") || entry.name.endsWith(".d.ts")) continue;
    out.push(rel);
  }
  return out;
}

/** Every production source file the gate scans, repo-relative, sorted. */
export function productionSources(root = __dirname) {
  const out = [];
  for (const scanRoot of SCAN_ROOTS) {
    const abs = join(root, scanRoot);
    if (!existsSync(abs)) continue;
    walk(abs, scanRoot, out);
  }
  return out.sort();
}

/**
 * Violations in one file's text: `{ line, rule, text }` for every line a rule
 * matches that no allowlist entry for `file` covers. Pure, so the detectors
 * are testable on inline fixtures below.
 */
export function scanSource(file, text, allowlist = ALLOWLIST) {
  const allowed = allowlist.filter((entry) => entry.file === file).map((entry) => entry.pattern);
  const violations = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      if (allowed.some((pattern) => pattern.test(line))) continue;
      violations.push({ line: index + 1, rule: rule.id, label: rule.label, text: line.trim() });
    }
  });
  return violations;
}

function formatViolations(violations) {
  const lines = violations.map((v) => `  ${v.file}:${v.line}: ${v.label}\n      ${v.text}`);
  return `${PRINCIPLE}\n\n${lines.join("\n")}\n\n${REMEDY}`;
}

// ───────────────────────────────────────────────────────────────────────────
// A. The gate
// ───────────────────────────────────────────────────────────────────────────

describe("SDK boundary gate (vision principle 13)", () => {
  const files = productionSources();

  it("scans the CLI and the MCP server", () => {
    assert.ok(files.includes("cli/cli.mjs"), "cli/cli.mjs must be scanned");
    assert.ok(files.includes("cli/git-remote-run402.mjs"), "the git remote helper must be scanned");
    assert.ok(files.includes("src/index.ts"), "the MCP entry point must be scanned");
    assert.ok(files.some((f) => f.startsWith("cli/lib/")), "cli/lib must be scanned");
    assert.ok(files.some((f) => f.startsWith("src/tools/")), "the MCP tools must be scanned");
    assert.ok(!files.some((f) => f.startsWith("cli/sdk/")), "the staged SDK copy is the SDK, not an adapter");
    assert.ok(!files.some((f) => f.includes(".test.")), "tests are not production sources");
  });

  it("no CLI or MCP source calls fetch, imports an HTTP client, or spells the API host itself", () => {
    const violations = [];
    for (const file of files) {
      const text = readFileSync(join(__dirname, file), "utf8");
      for (const v of scanSource(file, text)) violations.push({ file, ...v });
    }
    assert.equal(violations.length, 0, formatViolations(violations));
  });

  it("every ALLOWLIST entry names an existing file, carries a reason, and still matches a flagged line", () => {
    for (const entry of ALLOWLIST) {
      const abs = join(__dirname, entry.file);
      assert.ok(existsSync(abs), `ALLOWLIST names ${entry.file}, which does not exist — remove the entry or fix the path`);
      assert.ok(files.includes(entry.file), `ALLOWLIST names ${entry.file}, which the gate does not scan`);
      assert.equal(typeof entry.reason, "string");
      assert.ok(entry.reason.length > 0, `ALLOWLIST entry for ${entry.file} needs a reason`);
      const lines = readFileSync(abs, "utf8").split(/\r?\n/);
      const matched = lines.filter((line) => entry.pattern.test(line));
      assert.ok(
        matched.length > 0,
        `ALLOWLIST entry for ${entry.file} (${entry.pattern}) matches nothing — the exception is gone, delete the entry`,
      );
      // The entry must be excusing something a rule would flag; otherwise it
      // is dead weight that hides a future violation on the same line.
      const flaggedWithout = scanSource(entry.file, matched.join("\n"), []);
      assert.ok(
        flaggedWithout.length > 0,
        `ALLOWLIST entry for ${entry.file} (${entry.pattern}) excuses lines no rule flags — delete it`,
      );
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. The detectors, on inline fixtures — so a regex edit cannot silently
//    blind the gate.
// ───────────────────────────────────────────────────────────────────────────

describe("SDK boundary gate detectors", () => {
  const rules = (text) => scanSource("cli/lib/fixture.mjs", text, []).map((v) => v.rule);

  it("flags a bare fetch( in every common spelling", () => {
    assert.deepEqual(rules('const res = await fetch(url);'), ["bare-fetch"]);
    assert.deepEqual(rules('fetch("https://x/")'), ["bare-fetch"]);
    assert.deepEqual(rules('return (fetch (url))'), ["bare-fetch"]);
    assert.deepEqual(rules('const f = globalThis.fetch; f(url); fetch(url)'), ["bare-fetch"]);
  });

  it("passes member calls that are the SDK's own fetch", () => {
    assert.deepEqual(rules('const result = await sdk.pay.fetch(url, init, options);'), []);
    assert.deepEqual(rules('const res = await auth.fetch("/api/internal");'), []);
    assert.deepEqual(rules('Use auth.fetch() for same-origin requests'), []);
    assert.deepEqual(rules('const res = await paidFetch(url);'), []);
  });

  it("flags node:http, node:https, and undici imports in every form", () => {
    assert.deepEqual(rules('import { request } from "node:https";'), ["http-import"]);
    assert.deepEqual(rules("import http from 'node:http';"), ["http-import"]);
    assert.deepEqual(rules('import { fetch as undiciFetch } from "undici";'), ["http-import"]);
    assert.deepEqual(rules('const { Agent } = require("undici");'), ["http-import"]);
    assert.deepEqual(rules('const { request } = await import("node:https");'), ["http-import"]);
    assert.deepEqual(rules('import { createServer } from "node:net";'), []);
  });

  it("flags the Run402 API host as a URL literal but not in prose", () => {
    assert.deepEqual(rules('const url = "https://api.run402.com/projects/v1";'), ["api-host-literal"]);
    assert.deepEqual(rules('const base = process.env.RUN402_API_BASE ?? "https://api.run402.com";'), ["api-host-literal"]);
    assert.deepEqual(rules('fetch(`https://api.run402.com/${path}`)'), ["bare-fetch", "api-host-literal"]);
    assert.deepEqual(rules('hits the LIVE project at https://api.run402.com — no local setup needed.'), []);
    assert.deepEqual(rules('const API = "https://test-api.run402.com";'), ["api-host-literal"]);
  });

  it("an allowlist entry excuses exactly the matching line in the named file", () => {
    const allow = [{ file: "cli/lib/fixture.mjs", pattern: /api\.github\.com/, reason: "GitHub" }];
    const text = 'const a = await fetch("https://api.github.com/repos/x");\nconst b = await fetch(other);';
    const hits = scanSource("cli/lib/fixture.mjs", text, allow);
    assert.deepEqual(hits.map((v) => v.line), [2]);
    assert.equal(scanSource("cli/lib/other.mjs", text, allow).length, 2, "the entry is file-scoped");
  });

  it("names the file, the line, the principle, and both remedies in its failure message", () => {
    const message = formatViolations([
      { file: "cli/lib/fixture.mjs", line: 7, rule: "bare-fetch", label: RULES[0].label, text: "await fetch(url)" },
    ]);
    assert.match(message, /cli\/lib\/fixture\.mjs:7/);
    assert.match(message, /principle #13/);
    assert.match(message, /\(b\) .*move it into the SDK as a typed method/);
    assert.match(message, /\(a\) .*ALLOWLIST entry in sdk-boundary-gate\.test\.mjs/);
  });

  it("the walk reports paths relative to the repo root", () => {
    for (const file of productionSources()) {
      assert.equal(file, relative(__dirname, join(__dirname, file)));
    }
  });
});
