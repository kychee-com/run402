/**
 * Every CLI module must resolve every helper it calls.
 *
 * Why this exists: splitting `messages` out of `rooms` left `splitNames`
 * behind in rooms.mjs while `messages send` still called it. The full suite
 * passed — 2299 + 1443 tests — and the very first real send failed with
 * "splitNames is not defined". It shipped.
 *
 * The gap is structural, not an oversight: the CLI tests exercise ARGUMENT
 * PARSING and help text, both of which run before any handler body. A helper
 * referenced only inside a network-calling branch is invisible to them, and
 * the branch cannot be exercised without a live server and a funded wallet.
 *
 * So this checks the one property that needs no server and no parser: a module
 * must not call a helper that is DECLARED IN A SIBLING cli/lib module without
 * importing it. That is precisely the shape a file split produces, and it
 * false-positives on nothing — a global like `TextDecoder` is declared in no
 * module here, so it is never a candidate.
 *
 * A general "is every identifier resolvable" check was tried first and
 * produced 21 false positives from globals and parameter forms a regex cannot
 * see. A gate that noisy gets suppressed rather than fixed; this one is narrow
 * enough to stay honest. The general version wants a real parser (ESLint
 * `no-undef`), which is its own decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, "cli", "lib");

/** Globals and language constructs a module may use without declaring. */
const AMBIENT = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "await", "new",
  "console", "process", "JSON", "Object", "Array", "String", "Number", "Boolean",
  "Math", "Date", "Promise", "Error", "Set", "Map", "RegExp", "Buffer", "URL",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "setTimeout", "clearTimeout", "setInterval", "fetch",
  "structuredClone", "require", "import", "globalThis", "TextEncoder", "AbortController",
]);

/** Identifiers a module declares or imports. */
function declared(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  // Destructured locals: `const { run } = await import(...)`, catch params, etc.
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(":").pop()?.trim().replace(/\s*=.*$/, "");
      if (name) names.add(name);
    }
  }
  // Parameters — approximated by every identifier inside a parameter list.
  for (const m of src.matchAll(/(?:function\s*[\w$]*\s*|=>\s*|\()\(([^)]*)\)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[=:{}\s]/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Called as a function: `name(`, but not `.name(` (a method). */
function calledFunctions(src) {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // Object-literal method shorthand (`async approve(request) {`) reads as a
  // call to a regex but declares one. Drop those before matching.
  const noShorthand = stripped.replace(/\basync\s+[A-Za-z_$][\w$]*\s*\(/g, " (");
  const names = new Set();
  for (const m of noShorthand.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[2]);
  return names;
}

const modules = readdirSync(LIB).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));

/** Top-level `function NAME` declarations — the helpers a split can strand. */
function topLevelFunctions(src) {
  return new Set([...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
}

test("no module calls a helper that lives in a sibling module it never imported", () => {
  assert.ok(modules.length > 20, "found almost no modules — fix the scan, not the test");

  // Where each top-level helper name is declared.
  const declaredIn = new Map();
  const sources = new Map();
  for (const file of modules) {
    const src = readFileSync(join(LIB, file), "utf8");
    sources.set(file, src);
    for (const name of topLevelFunctions(src)) {
      if (!declaredIn.has(name)) declaredIn.set(name, []);
      declaredIn.get(name).push(file);
    }
  }

  const stranded = [];
  for (const [file, src] of sources) {
    const known = declared(src);
    for (const name of calledFunctions(src)) {
      if (known.has(name) || AMBIENT.has(name)) continue;
      const homes = (declaredIn.get(name) ?? []).filter((f) => f !== file);
      // Only a name that demonstrably EXISTS elsewhere in cli/lib is a
      // stranded reference. Anything else is a global or a parser artifact,
      // and guessing about those is what made the general check unusable.
      if (homes.length > 0) stranded.push(`${file} calls ${name}(), declared in ${homes.join(", ")} — and does not import it`);
    }
  }

  assert.deepEqual(
    stranded,
    [],
    `\n  ${stranded.join("\n  ")}\n\n`
      + "This is what a file split leaves behind. It passes every arg-parsing test and fails on the first real call.",
  );
});
