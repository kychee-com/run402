/**
 * Wrong-entry-point detection tests — §7 of run402-image-component-impl.
 *
 * Verifies that importing `Run402Image` from the wrong entry point is
 * caught at one of three layers:
 *
 *   1. **TypeScript compile-time** (the brand check) — covered by the
 *      `@ts-expect-error` patterns below. If the brand check stops
 *      working, the comment loses its expected error and the test file
 *      fails to compile.
 *
 *   2. **Runtime guard in the React FC** — `react.tsx` checks
 *      `typeof REACT_VERSION` and throws if undefined. Covered by the
 *      sibling `react.test.tsx` (already runs in CI).
 *
 *   3. **Runtime guard in the Astro frontmatter** — `Run402Image.astro`
 *      checks `typeof Astro === "undefined"`. Defense-in-depth; not
 *      practically reachable because `.astro` files won't load outside
 *      Astro. Covered by a code-presence assertion below (we can't
 *      execute the .astro file in a node:test context).
 *
 * The TS errors below are intentional. The test FILE compiles only when
 * TypeScript reports the expected errors at the `@ts-expect-error` sites.
 * If a future refactor accidentally widens the brand or drops the check,
 * the `@ts-expect-error` becomes "an error was expected but none was
 * reported" — which itself is a TS error and fails the build.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// React entry point — has the ReactComponent brand.
import { Run402Image as ReactRun402Image } from "./react.js";

import type { AstroComponent, ReactComponent, Run402ImageProps } from "./types.js";

// =============================================================================
// 7.1 — TypeScript brand check at compile time
// =============================================================================

describe("brand types — TypeScript catches mixed entry points at compile time", () => {
  it("the React entry's exported symbol carries the ReactComponent brand", () => {
    // The cast succeeds; the brand is on the type, not the runtime value.
    const _r: ReactComponent<Run402ImageProps> = ReactRun402Image;
    void _r;
    assert.ok(ReactRun402Image, "react entry exported");
  });

  it("assigning a React-branded value to an AstroComponent type is rejected", () => {
    // @ts-expect-error — ReactComponent is NOT assignable to AstroComponent.
    // If this line stops erroring, the brand has been weakened — likely
    // someone changed the unique-symbol declarations in types.ts.
    const _shouldFail: AstroComponent<Run402ImageProps> = ReactRun402Image;
    void _shouldFail;
    assert.ok(true);
  });

  // The reverse direction (assigning an Astro-branded value to a React
  // typed slot) can't be unit-tested here without importing the Astro
  // entry, which is a .astro file (not directly importable in a TS
  // context). The brand on the Astro side is enforced by Astro's own
  // type system + the AstroComponent type alias in types.ts. The
  // integration test at task 7.4 would exercise it via a sibling
  // `.astro` fixture (deferred — Astro's test infra doesn't run inside
  // node:test).
});

// =============================================================================
// 7.2 — Runtime guard (already covered in react.test.tsx + Run402Image.astro)
// =============================================================================

describe("runtime guards — code-presence assertions", () => {
  it("Run402Image.astro contains the typeof Astro === 'undefined' guard", () => {
    // We can't execute the .astro file from node:test (it requires
    // Astro's Vite plugin). Verify the guard's source code is present
    // — if a future refactor removes it accidentally, this test fails.
    const here = dirname(fileURLToPath(import.meta.url));
    const astroSrc = readFileSync(
      join(here, "..", "Run402Image.astro"),
      "utf8",
    );
    assert.match(
      astroSrc,
      /typeof Astro === ["']undefined["']/,
      "Astro entry's runtime guard is missing",
    );
    assert.match(
      astroSrc,
      /R402_ASTRO_IMAGE_WRONG_ENTRY_POINT/,
      "Astro entry's wrong-entry error code is missing",
    );
  });

  it("react.tsx contains the typeof REACT_VERSION !== 'string' guard", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const reactSrc = readFileSync(join(here, "react.tsx"), "utf8");
    assert.match(
      reactSrc,
      /typeof REACT_VERSION !== ["']string["']/,
      "React entry's runtime guard is missing",
    );
    assert.match(
      reactSrc,
      /R402_ASTRO_IMAGE_WRONG_ENTRY_POINT/,
      "React entry's wrong-entry error code is missing",
    );
  });
});

// =============================================================================
// 7.5 — Pure-JS consumer runtime-guard exercise (React side)
// =============================================================================

describe("runtime guard fires when a JS consumer bypasses TypeScript", () => {
  it("the React FC carries a runtime guard executable from JS context", () => {
    // Practical test: this is conceptually a JS consumer who bypassed TS.
    // We can't actually un-define `React.version` because that's the
    // module's exported constant. But we CAN verify the FC includes the
    // guard branch by inspecting the source for the throw statement.
    const here = dirname(fileURLToPath(import.meta.url));
    const reactSrc = readFileSync(join(here, "react.tsx"), "utf8");
    // Source contains both the guard predicate AND the throw.
    assert.match(
      reactSrc,
      /typeof REACT_VERSION !== ["']string["'][\s\S]+throw new Run402ImageError/,
      "React runtime guard is missing or restructured",
    );
  });
});
