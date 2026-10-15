// @types/node follows the oldest Node this repository supports, never the
// newest: types for a newer Node type-check APIs the supported runtime lacks.
// The oldest supported Node is the root package's `engines.node` minimum.
// Dependabot ignores @types/node majors, so the types move by hand, in the same
// commit that raises `engines.node`; this test fails while the majors differ.
// demos/ is excluded: each demo is built and updated by hand on its own runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "dist", "demos"]);

function packageFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return packageFiles(path);
    return entry.name === "package.json" ? [path] : [];
  });
}

function leadingMajor(range) {
  const match = /^\s*(?:>=|\^|~)?\s*v?(\d+)/.exec(range);
  assert.ok(match, `cannot read a major version from "${range}"`);
  return Number(match[1]);
}

test("every @types/node major equals the root engines.node minimum", () => {
  const engines = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines?.node;
  assert.match(engines ?? "", /^>=/, "the root package.json declares engines.node as a >= minimum");
  const supported = leadingMajor(engines);

  const declared = packageFiles(root).flatMap((file) => {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    const range = pkg.devDependencies?.["@types/node"] ?? pkg.dependencies?.["@types/node"];
    return range ? [{ file: relative(root, file), range }] : [];
  });
  assert.ok(declared.length > 0, "no package.json declares @types/node");

  const mismatched = declared.filter(({ range }) => leadingMajor(range) !== supported);
  assert.deepEqual(
    mismatched,
    [],
    `@types/node must be ${supported}.x to match engines.node "${engines}"; ` +
      "raise engines.node and @types/node together",
  );
});
