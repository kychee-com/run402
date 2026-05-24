/**
 * Unit tests for the degradation-manifest accumulator + writer.
 *
 * Covers §6 of run402-image-component-impl/tasks.md (tasks 6.1 - 6.6).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  API_DEPRECATIONS_FILENAME,
  IMAGE_DEGRADATIONS_FILENAME,
  MANIFEST_SUBDIR,
  createApiDeprecationAccumulator,
  createDegradationAccumulator,
  flushApiDeprecationManifest,
  flushDegradationManifest,
  resolveManifestPath,
} from "./degradation-manifest.js";
import type { DegradationEntry } from "./types.js";

// =============================================================================
// Helpers
// =============================================================================

function entry(
  partial: Partial<DegradationEntry> = {},
): DegradationEntry {
  return {
    assetSha256: "abc1234",
    assetKey: "images/hero.jpg",
    missingFields: ["width_px"],
    occurrences: 1,
    firstSeenAt: "2026-05-24T12:00:00.000Z",
    ...partial,
  };
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "run402-manifest-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// 6.1 — Constants
// =============================================================================

describe("constants", () => {
  it("exports the manifest filenames + subdir", () => {
    assert.equal(IMAGE_DEGRADATIONS_FILENAME, "image-degradations.json");
    assert.equal(API_DEPRECATIONS_FILENAME, "api-deprecations.json");
    assert.equal(MANIFEST_SUBDIR, "run402");
  });
});

// =============================================================================
// 6.2 — Dedupe semantics
// =============================================================================

describe("createDegradationAccumulator — dedupe", () => {
  it("first record creates the entry; second with same dedupe key increments occurrences", () => {
    const acc = createDegradationAccumulator();
    acc.record(entry({ occurrences: 1 }));
    acc.record(entry({ occurrences: 1 }));
    const all = acc.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.occurrences, 2);
  });

  it("same asset, DIFFERENT missing-fields → two entries", () => {
    const acc = createDegradationAccumulator();
    acc.record(entry({ missingFields: ["width_px"] }));
    acc.record(entry({ missingFields: ["height_px"] }));
    const all = acc.getAll();
    assert.equal(all.length, 2);
  });

  it("DIFFERENT asset, same missing-fields → two entries", () => {
    const acc = createDegradationAccumulator();
    acc.record(entry({ assetSha256: "hero" }));
    acc.record(entry({ assetSha256: "card" }));
    assert.equal(acc.getAll().length, 2);
  });

  it("missing-fields order in input does not affect the dedupe key", () => {
    const acc = createDegradationAccumulator();
    acc.record(entry({ missingFields: ["a", "b", "c"] }));
    acc.record(entry({ missingFields: ["c", "a", "b"] }));
    const all = acc.getAll();
    assert.equal(all.length, 1, "different field orders should dedupe");
    assert.deepEqual(all[0]!.missingFields, ["a", "b", "c"]);
  });

  it("firstSeenAt is NOT updated on duplicate hits", () => {
    const acc = createDegradationAccumulator();
    acc.record(entry({ firstSeenAt: "2026-05-24T12:00:00.000Z" }));
    acc.record(entry({ firstSeenAt: "2026-05-24T13:00:00.000Z" })); // later
    const all = acc.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.firstSeenAt, "2026-05-24T12:00:00.000Z");
  });

  it("clear() empties the accumulator", () => {
    const acc = createDegradationAccumulator();
    acc.record(entry());
    acc.clear();
    assert.equal(acc.getAll().length, 0);
  });
});

// =============================================================================
// 6.2 — Stable ordering
// =============================================================================

describe("createDegradationAccumulator — stable iteration order", () => {
  it("getAll() returns entries sorted by dedupe key (deterministic for CI diffs)", () => {
    const acc = createDegradationAccumulator();
    // Insert in non-sorted order; expect stable sorted output.
    acc.record(entry({ assetSha256: "zzz" }));
    acc.record(entry({ assetSha256: "aaa" }));
    acc.record(entry({ assetSha256: "mmm" }));
    const all = acc.getAll();
    assert.deepEqual(
      all.map((e) => e.assetSha256),
      ["aaa", "mmm", "zzz"],
    );
  });
});

// =============================================================================
// 6.3 — Flush to file
// =============================================================================

describe("flushDegradationManifest", () => {
  it("writes a JSON array of entries to the given path", () => {
    withTmpDir((dir) => {
      const acc = createDegradationAccumulator();
      acc.record(entry({ assetSha256: "deadbeef", missingFields: ["width_px"] }));
      acc.record(entry({ assetSha256: "deadbeef", missingFields: ["height_px"] }));
      const path = join(dir, "run402", "image-degradations.json");
      flushDegradationManifest(acc, path);

      const written = readFileSync(path, "utf8");
      const parsed = JSON.parse(written) as DegradationEntry[];
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0]!.assetSha256, "deadbeef");
    });
  });

  it("creates parent directories if they don't exist", () => {
    withTmpDir((dir) => {
      const acc = createDegradationAccumulator();
      acc.record(entry());
      // Nested path that doesn't exist yet.
      const path = join(dir, "a", "b", "c", "manifest.json");
      flushDegradationManifest(acc, path);
      // No throw = directories were created.
      assert.ok(readFileSync(path, "utf8").length > 0);
    });
  });

  it("writes empty array `[]` when no entries (downstream CI sees a clean signal)", () => {
    withTmpDir((dir) => {
      const acc = createDegradationAccumulator();
      const path = join(dir, "manifest.json");
      flushDegradationManifest(acc, path);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual(parsed, []);
    });
  });

  it("output is human-readable with 2-space indent + trailing newline", () => {
    withTmpDir((dir) => {
      const acc = createDegradationAccumulator();
      acc.record(entry());
      const path = join(dir, "manifest.json");
      flushDegradationManifest(acc, path);
      const written = readFileSync(path, "utf8");
      assert.ok(written.includes('  "assetSha256"'), "2-space indent");
      assert.ok(written.endsWith("\n"), "trailing newline");
    });
  });
});

// =============================================================================
// 6.6 — Path resolution under outDir
// =============================================================================

describe("resolveManifestPath", () => {
  it("default Astro outDir (string `./dist`) → `./dist/run402/<filename>.json`", () => {
    const path = resolveManifestPath("./dist", IMAGE_DEGRADATIONS_FILENAME);
    assert.equal(path, "dist/run402/image-degradations.json");
  });

  it("Kychon's tenant-scoped outDir → `dist-tenant/<id>/run402/<filename>.json`", () => {
    const path = resolveManifestPath(
      "dist-tenant/tenant-abc",
      IMAGE_DEGRADATIONS_FILENAME,
    );
    assert.equal(path, "dist-tenant/tenant-abc/run402/image-degradations.json");
  });

  it("URL form (Astro passes a file:// URL for outDir) is normalized to a string path", () => {
    const path = resolveManifestPath(
      new URL("file:///app/dist/"),
      IMAGE_DEGRADATIONS_FILENAME,
    );
    assert.match(path, /\/app\/dist\/run402\/image-degradations\.json$/);
  });

  it("works for the API-deprecations filename too", () => {
    const path = resolveManifestPath("./dist", API_DEPRECATIONS_FILENAME);
    assert.equal(path, "dist/run402/api-deprecations.json");
  });
});

// =============================================================================
// 6.5 — Parallel api-deprecations machinery
// =============================================================================

describe("createApiDeprecationAccumulator — parallel machinery", () => {
  it("dedupes on (prop, value) pair", () => {
    const acc = createApiDeprecationAccumulator();
    acc.record({
      prop: "placeholder",
      value: "blurhash",
      replacement: "lqip",
      removeInVersion: "v2.0.0",
      occurrences: 1,
      firstSeenAt: "2026-05-24T12:00:00.000Z",
    });
    acc.record({
      prop: "placeholder",
      value: "blurhash",
      replacement: "lqip",
      removeInVersion: "v2.0.0",
      occurrences: 1,
      firstSeenAt: "2026-05-24T13:00:00.000Z",
    });
    const all = acc.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.occurrences, 2);
  });

  it("flushApiDeprecationManifest writes to disk like flushDegradationManifest", () => {
    withTmpDir((dir) => {
      const acc = createApiDeprecationAccumulator();
      acc.record({
        prop: "placeholder",
        value: "blurhash",
        replacement: "lqip",
        removeInVersion: "v2.0.0",
        occurrences: 1,
        firstSeenAt: "2026-05-24T12:00:00.000Z",
      });
      const path = join(dir, API_DEPRECATIONS_FILENAME);
      flushApiDeprecationManifest(acc, path);
      const written = readFileSync(path, "utf8");
      const parsed = JSON.parse(written);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].prop, "placeholder");
    });
  });
});

// =============================================================================
// Integration: accumulator → flush → re-read round trip
// =============================================================================

describe("round-trip: record → flush → parse JSON", () => {
  it("the written file's content matches getAll() byte-for-byte (modulo JSON formatting)", () => {
    withTmpDir((dir) => {
      const acc = createDegradationAccumulator();
      acc.record(entry({ assetSha256: "aaa", missingFields: ["width_px"], occurrences: 1 }));
      acc.record(entry({ assetSha256: "bbb", missingFields: ["height_px"], occurrences: 1 }));
      acc.record(entry({ assetSha256: "aaa", missingFields: ["width_px"], occurrences: 1 })); // dedupe hit

      const path = join(dir, "manifest.json");
      flushDegradationManifest(acc, path);

      const written = JSON.parse(readFileSync(path, "utf8")) as DegradationEntry[];
      const inMemory = acc.getAll();
      assert.deepEqual(written, inMemory);
      // After dedupe: 2 entries, the first has occurrences=2.
      assert.equal(written.length, 2);
      const aaaEntry = written.find((e) => e.assetSha256 === "aaa")!;
      assert.equal(aaaEntry.occurrences, 2);
    });
  });
});
