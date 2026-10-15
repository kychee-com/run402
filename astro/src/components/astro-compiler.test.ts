/**
 * Every shipped `.astro` component compiles with the compiler Astro itself
 * builds with. Astro 7 compiles through `@astrojs/compiler-rs`, which is
 * stricter than the `@astrojs/compiler` the rendered-DOM tests drive (it
 * rejects an HTML comment inside an expression, for one), so a component can
 * pass those tests and still fail a consumer's `astro build`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return astroFiles(path);
    return entry.name.endsWith(".astro") ? [path] : [];
  });
}

// The compiler is Astro's own dependency, so resolve it from Astro.
const fromAstro = createRequire(createRequire(import.meta.url).resolve("astro/package.json"));
const { transform } = (await import(pathToFileURL(fromAstro.resolve("@astrojs/compiler-rs")).href)) as {
  transform: (source: string, options: { filename: string }) => Promise<{
    diagnostics?: { severity: string; text: string; labels?: { line?: number; column?: number }[] }[];
  }>;
};

describe("Astro's compiler", () => {
  const files = astroFiles(SRC);

  it("finds the shipped components", () => {
    assert.ok(files.some((file) => file.endsWith("SignIn.astro")), files.join(", "));
  });

  for (const file of files) {
    it(`compiles ${file.slice(SRC.length)}`, async () => {
      const result = await transform(readFileSync(file, "utf8"), { filename: file });
      const errors = (result.diagnostics ?? []).filter((d) => d.severity === "error");
      assert.deepEqual(
        errors.map((d) => `${d.text} at ${d.labels?.[0]?.line}:${d.labels?.[0]?.column}`),
        [],
      );
    });
  }
});
