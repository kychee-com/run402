/**
 * AVIF deferral guard — §10 of run402-image-component-impl.
 *
 * Per spec §"AVIF is NOT emitted in v1.0 (deferred per the platform-wide
 * stance)": even when the gateway's image pipeline starts producing AVIF
 * variants in a future release, `<Run402Image>` v1.0 SHALL NOT emit
 * `<source type="image/avif">` elements in the rendered `<picture>`.
 *
 * The reason is the `<picture>` source-type-precedence footgun: browsers
 * pick by `type` before size, so a single AVIF source at full-res defeats
 * the variant ladder on mobile.
 *
 * This test is the CI floor that catches accidental AVIF emission. If
 * anyone adds `type="image/avif"` or a similar marker to any source file
 * in `Run402Image/`, this test fails with a pointer at the spec section
 * explaining the deferral.
 *
 * The grep targets:
 *
 *   - `type="image/avif"` — the literal output that would surface AVIF
 *   - `imageavif` / `image/avif` — anywhere in the component code that
 *     would suggest the component is producing AVIF-related logic
 *   - `kind: "avif"` — variant-set additions that would expand the
 *     `OrderedVariant` lineup beyond `thumb` / `medium` / `large`
 *
 * Exception: this file itself contains the literal strings (in the
 * grep patterns). The check filters out `avif-deferral.test.ts` from
 * the result set so the guard doesn't trip on its own contents.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// Forbidden-strings list (the actual deferral floor)
// =============================================================================

const FORBIDDEN_PATTERNS: RegExp[] = [
  /type="image\/avif"/,
  /image\/avif/,
  /imageavif/i,
  /kind:\s*["']avif["']/,
];

/** This guard is scoped to the component's source files specifically.
 *  Other parts of the codebase MAY reference AVIF (e.g., docs that
 *  explain the deferral), but Run402Image's own source MUST NOT. */
const SCOPE_DIR_NAME = "Run402Image";

/** This file's own basename — excluded from the grep result set so the
 *  patterns above (which appear as literals in this test) don't trip
 *  the guard on themselves. */
const SELF_BASENAME = "avif-deferral.test.ts";

// =============================================================================
// Walk + grep
// =============================================================================

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  pattern: string;
  line: number;
  text: string;
}

function grepForbidden(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    if (file.endsWith(SELF_BASENAME)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) {
          hits.push({ file, pattern: pattern.source, line: i + 1, text });
        }
      }
    }
  }
  return hits;
}

// =============================================================================
// Test
// =============================================================================

describe("AVIF deferral guard (§10)", () => {
  it("Run402Image/ source files contain ZERO AVIF emissions", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // `here` is `.../Run402Image`; walk it.
    assert.equal(
      here.endsWith(SCOPE_DIR_NAME),
      true,
      `expected this test to live in ${SCOPE_DIR_NAME}/, got ${here}`,
    );

    const files = walk(here);
    const hits = grepForbidden(files);
    if (hits.length > 0) {
      const summary = hits
        .map(
          (h) =>
            `  ${h.file}:${h.line}\n    pattern: /${h.pattern}/\n    text:    ${h.text.trim()}`,
        )
        .join("\n\n");
      assert.fail(
        `AVIF deferral guard tripped — Run402Image source files contain\n` +
          `AVIF references that would surface AVIF emission. v1.0 of the\n` +
          `component intentionally does NOT emit \`<source type="image/avif">\`\n` +
          `because browsers pick \`<picture>\` sources by \`type\` before\n` +
          `size; a full-resolution AVIF source would defeat the variant\n` +
          `ladder on mobile.\n\n` +
          `See: the run402-image-component OpenSpec change\n` +
          `     §"AVIF is NOT emitted in v1.0 (deferred per the platform-wide stance)"\n\n` +
          `Hits:\n${summary}`,
      );
    }
  });

  it("the FORBIDDEN_PATTERNS list itself is non-empty (defensive)", () => {
    // If someone empties the list as a "workaround," the test would
    // pass vacuously. Pin the patterns count + spot-check one entry.
    assert.ok(FORBIDDEN_PATTERNS.length >= 4);
    assert.ok(FORBIDDEN_PATTERNS.some((p) => p.source.includes("avif")));
  });
});
