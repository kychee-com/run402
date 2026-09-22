/**
 * run402-mcp must never import `@run402/sdk` by its package name.
 *
 * Why this exists: the published run402-mcp tarball VENDORS the built SDK
 * under `sdk/dist` (see `files` in package.json) and declares no
 * `@run402/sdk` dependency. Inside the monorepo a bare `@run402/sdk/node`
 * specifier resolves anyway, because the workspace root hoists the sdk
 * package into node_modules, so every unit test passes. Outside the
 * monorepo the same import is ERR_MODULE_NOT_FOUND on the first tool that
 * loads it. 4.93.0 shipped exactly that in dist/tools/app-up.js: `npx
 * run402-mcp` crashed on a clean machine, and two independent agents hit
 * it within the same hour.
 *
 * The publish workflow's tarball smoke resolves only `dist/sdk.js`, which
 * imports the vendored copy correctly, so it could not see a bare
 * specifier in a sibling module. This gate checks the source instead: any
 * import of `@run402/sdk` (bare or subpath) under src/ fails the build.
 * The only sanctioned form is the relative path into `sdk/dist`, the way
 * `src/sdk.ts` and every other tool already do it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "src");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) yield full;
  }
}

// `import ... from "@run402/sdk"`, `import("@run402/sdk/node")`,
// `export ... from "@run402/sdk"`. Type-only imports are erased by tsc and
// are harmless at runtime, so they are allowed.
const BARE_SDK = /(?:^|\n)\s*(?!import\s+type\b)(?:import|export)\b[^\n]*?from\s+["']@run402\/sdk(?:\/[^"']*)?["']|import\(\s*["']@run402\/sdk(?:\/[^"']*)?["']\s*\)/g;

test("no run402-mcp source imports @run402/sdk by package name", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(BARE_SDK)) {
      const line = text.slice(0, match.index).split("\n").length + (match[0].startsWith("\n") ? 1 : 0);
      offenders.push(`${relative(here, file)}:${line}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "run402-mcp vendors sdk/dist and declares no @run402/sdk dependency; " +
      "import the vendored build by relative path (e.g. \"../../sdk/dist/node/index.js\"), " +
      "never the package name. Offenders:\n" + offenders.join("\n"),
  );
});

test("the gate recognises the shape that shipped in 4.93.0", () => {
  const shipped = 'import { storeResult } from "../result-store.js";\nimport { prepareWorkflowOutput } from "@run402/sdk/node";\n';
  assert.equal([...shipped.matchAll(BARE_SDK)].length, 1);
  const fixed = 'import { prepareWorkflowOutput } from "../../sdk/dist/node/index.js";\n';
  assert.equal([...fixed.matchAll(BARE_SDK)].length, 0);
  const typeOnly = 'import type { NodeRun402 } from "@run402/sdk/node";\n';
  assert.equal([...typeOnly.matchAll(BARE_SDK)].length, 0);
});
