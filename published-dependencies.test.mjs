/**
 * published-dependencies.test.mjs: the published packages do not carry a
 * dependency the SDK replaced with its own code.
 *
 * Every entry in `dependencies` of run402, run402-mcp and @run402/sdk installs
 * on a customer's machine under the customer's npm settings, so one
 * compromised release of it reaches every agent that installs ours. These
 * were small enough to own:
 *
 *   json-canonicalize      -> sdk/src/jcs.ts (RFC 8785)
 *   @humanwhocodes/momoa   -> sdk/src/strict-json.ts
 *   ipaddr.js              -> sdk/src/node/ip-range.ts
 *   tsx                    -> Node's own type stripping; a config that needs
 *                             a transpiler asks for `npm install --save-dev tsx`
 *
 * Adding one back fails here, on purpose: own the code instead.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = import.meta.dirname;
const REPLACED = ["json-canonicalize", "@humanwhocodes/momoa", "ipaddr.js", "tsx"];
const PACKAGES = [
  { label: "run402-mcp", path: "package.json" },
  { label: "run402", path: "cli/package.json" },
  { label: "@run402/sdk", path: "sdk/package.json" },
];
// Production sources that end up in a published tarball.
const SOURCE_DIRS = ["src", "sdk/src", "core/src", "cli/lib"];
const SOURCE_FILES = ["cli/cli.mjs", "cli/git-remote-run402.mjs"];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.(test|integ)\./.test(name)) yield full;
  }
}

const specifier = (name) => new RegExp(String.raw`(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:/[^"']*)?["']`);

describe("published packages carry no replaced dependency", () => {
  for (const pkg of PACKAGES) {
    it(`${pkg.label} does not declare ${REPLACED.join(", ")}`, () => {
      const declared = Object.keys(JSON.parse(readFileSync(join(root, pkg.path), "utf8")).dependencies ?? {});
      assert.deepEqual(declared.filter((name) => REPLACED.includes(name)), [], `${pkg.path} declares a dependency the SDK replaced with its own code (see this file's header)`);
    });
  }

  it("no production source imports one", () => {
    const files = [...SOURCE_DIRS.flatMap((dir) => [...walk(join(root, dir))]), ...SOURCE_FILES.map((file) => join(root, file))];
    assert.ok(files.length > 50, "expected to scan the production sources");
    const hits = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const name of REPLACED) {
        // The SDK's lazy tsx fallback resolves `tsx/esm/api` from the
        // config's own project at run time; that is the documented door.
        if (name === "tsx" && relative(root, file) === join("sdk", "src", "node", "deploy-manifest.ts")) continue;
        if (specifier(name).test(text)) hits.push(`${relative(root, file)} imports ${name}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
