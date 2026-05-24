/**
 * `<Run402Image>` — degradation manifest writer (§6 of the impl change).
 *
 * Build-time accumulator that collects `DegradationEntry` records (from
 * the shared core's `recordDegradation` callback) and writes them to
 * a JSON manifest at `<config.outDir>/run402/image-degradations.json`
 * when the Astro build completes.
 *
 * **Purpose** (spec §"Strict mode + visible build-time warnings"): the
 * manifest is a CI regression-gating artifact. A downstream CI job can
 * diff the build output against a checked-in golden manifest and fail
 * when a previously-clean asset starts degrading — catching the silent-
 * degradation failure mode (Kychon's "28 of 30 assets render correctly
 * and 2 silently degrade") before it reaches a tenant.
 *
 * **Dedupe key** (spec §6.2): `(asset.sha256, sorted-missing-fields-joined)`.
 * Two renders of the same AssetRef with the same missing-fields set
 * collapse into one entry with `occurrences += 1`. Distinct missing-
 * fields sets on the same asset land as distinct entries (lets the CI
 * regression-gate spot which exact field shape regressed).
 *
 * **Sibling: `api-deprecations.json`** (§6.5). v1.0 of the component
 * has no deprecated props, but the machinery ships so future versions
 * can record prop deprecations without a fresh round of plumbing. The
 * shape mirrors the degradation entry — same accumulator pattern,
 * different file name.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DegradationEntry } from "./types.js";

// =============================================================================
// Manifest filenames (§6.5)
// =============================================================================

/** The two manifest filenames written under `<outDir>/run402/`. v1.0 of
 *  the component only emits to the first; the second's machinery ships
 *  for v1.1+ prop-deprecation tracking. */
export const IMAGE_DEGRADATIONS_FILENAME = "image-degradations.json";
export const API_DEPRECATIONS_FILENAME = "api-deprecations.json";

/** Subdirectory under `config.outDir` for both manifests. Lives directly
 *  under `outDir/run402/` (NOT `outDir/run402/client/`) because manifests
 *  are build artifacts, not consumer-served files. */
export const MANIFEST_SUBDIR = "run402";

// =============================================================================
// 6.1, 6.2 — DegradationAccumulator
// =============================================================================

/**
 * Dedupe-aware accumulator. Construct once per Astro build (the
 * integration hook holds a module-level reference); `record` is called
 * from every `<Run402Image>` render that ends up degrading.
 *
 * Returns the accumulator's three operations as a closure-based API
 * rather than a class — easier to inject as a `recordDegradation`
 * callback into the shared core's RenderContext without `bind(this)`
 * gymnastics.
 */
export interface DegradationAccumulator {
  /** Add or merge a single entry. If an entry with the same dedupe key
   *  already exists, `occurrences` increments on the existing entry
   *  instead of adding a new one. */
  record(entry: DegradationEntry): void;
  /** Get all entries as an array (deterministic order: sorted by the
   *  dedupe key string). The CI golden-file diff relies on this stable
   *  ordering. */
  getAll(): DegradationEntry[];
  /** Empty the accumulator. Mostly for tests; production code creates
   *  one accumulator per build and lets the process exit clear it. */
  clear(): void;
}

export function createDegradationAccumulator(): DegradationAccumulator {
  const byKey = new Map<string, DegradationEntry>();

  function dedupeKey(entry: DegradationEntry): string {
    // Sorted missing-fields list joined with `,`. The entry already
    // arrives with `missingFields` sorted (the shared core's
    // maybeRecordDegradation calls `.sort()`); we re-sort defensively
    // in case a caller bypasses the core.
    const sortedFields = [...entry.missingFields].sort();
    return `${entry.assetSha256}|${sortedFields.join(",")}`;
  }

  return {
    record(entry: DegradationEntry): void {
      const key = dedupeKey(entry);
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences += 1;
        // Leave `firstSeenAt` untouched per spec §"Warnings emitted ONCE per
        // unique (asset.sha256, missing-fields-set) pair per build run".
      } else {
        // Defensive copy — the caller may reuse the entry object across
        // renders. We sort missingFields on entry to ensure the stored
        // value is canonical.
        byKey.set(key, {
          assetSha256: entry.assetSha256,
          assetKey: entry.assetKey,
          missingFields: [...entry.missingFields].sort(),
          occurrences: entry.occurrences,
          firstSeenAt: entry.firstSeenAt,
        });
      }
    },
    getAll(): DegradationEntry[] {
      // Sort by dedupe key for stable iteration order. CI golden-file
      // diffs need this to be deterministic.
      const keys = Array.from(byKey.keys()).sort();
      return keys.map((k) => byKey.get(k)!);
    },
    clear(): void {
      byKey.clear();
    },
  };
}

// =============================================================================
// 6.3, 6.4, 6.6 — Flush to JSON file
// =============================================================================

/**
 * Write the accumulator's entries to a JSON file. Used by the Astro
 * `astro:build:done` hook (which calls this with the resolved
 * `<outDir>/run402/image-degradations.json` path); also exposed as a
 * standalone helper for React-only contexts that don't get the Astro
 * lifecycle (task 6.4).
 *
 * The file format is a JSON array of `DegradationEntry` objects — flat
 * structure for trivial diffing. The CI regression-gate can `grep -c '"'`
 * to count entries, or use `jq` for richer queries.
 *
 * Side-effect: creates parent directories if they don't exist (via
 * `mkdirSync({ recursive: true })`). The Astro integration hook places
 * the manifest under `<outDir>/run402/`, which doesn't exist until the
 * build creates `outDir` itself.
 */
export function flushDegradationManifest(
  accumulator: DegradationAccumulator,
  filePath: string,
): void {
  const entries = accumulator.getAll();
  mkdirSync(dirname(filePath), { recursive: true });
  // 2-space indent matches the convention for human-readable JSON
  // artifacts in this repo (openspec/, site/openapi.json, etc.). Trailing
  // newline so POSIX tools and `git diff --check` are happy.
  writeFileSync(filePath, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/**
 * Resolve the canonical manifest path under an Astro build's outDir.
 *
 * Spec OQ-10 resolution: manifest path is `<config.outDir>/run402/<filename>.json`.
 *   - Default Astro outDir (`./dist`) → `./dist/run402/image-degradations.json`
 *   - Kychon's `outDir: dist-tenant/<id>` override →
 *     `dist-tenant/<id>/run402/image-degradations.json`
 *
 * The integration hook receives `config.outDir` (URL or string) from
 * Astro's `astro:config:done` payload; this helper normalizes to a
 * string path under `outDir/run402/<filename>` for the actual write.
 */
export function resolveManifestPath(
  outDir: string | URL,
  filename: string,
): string {
  const outDirStr = typeof outDir === "string" ? outDir : outDir.pathname;
  return join(outDirStr, MANIFEST_SUBDIR, filename);
}

// =============================================================================
// 6.5 — API deprecation accumulator (parallel machinery for v1.1+)
// =============================================================================

/**
 * Sibling shape for `api-deprecations.json`. v1.0 of the component has
 * no deprecated props, so this type + accumulator exist mostly as
 * scaffolding for v1.1+ where a deprecation could be recorded when a
 * caller passes a soon-to-be-removed prop.
 *
 * Example future use: if v1.1 deprecates `placeholder="blurhash"` in
 * favor of `placeholder="lqip"`, the component's validation step would
 * call `recordApiDeprecation({ prop: "placeholder", value: "blurhash",
 * replacement: "lqip", removeInVersion: "v2.0.0" })`.
 */
export interface ApiDeprecationEntry {
  prop: string;
  value: string;
  replacement: string;
  removeInVersion: string;
  occurrences: number;
  firstSeenAt: string;
}

export interface ApiDeprecationAccumulator {
  record(entry: ApiDeprecationEntry): void;
  getAll(): ApiDeprecationEntry[];
  clear(): void;
}

export function createApiDeprecationAccumulator(): ApiDeprecationAccumulator {
  const byKey = new Map<string, ApiDeprecationEntry>();

  function dedupeKey(e: ApiDeprecationEntry): string {
    return `${e.prop}|${e.value}`;
  }

  return {
    record(entry: ApiDeprecationEntry): void {
      const key = dedupeKey(entry);
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences += 1;
      } else {
        byKey.set(key, { ...entry });
      }
    },
    getAll(): ApiDeprecationEntry[] {
      const keys = Array.from(byKey.keys()).sort();
      return keys.map((k) => byKey.get(k)!);
    },
    clear(): void {
      byKey.clear();
    },
  };
}

/** Parallel flush helper for `api-deprecations.json`. */
export function flushApiDeprecationManifest(
  accumulator: ApiDeprecationAccumulator,
  filePath: string,
): void {
  const entries = accumulator.getAll();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(entries, null, 2) + "\n", "utf8");
}
