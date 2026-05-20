/**
 * Build cache for resolved AssetRefs.
 *
 * Lives at `<project-root>/node_modules/.run402/assetMap.json`. The file is
 * gitignored on first write — we append `node_modules/.run402/` to the
 * project's root `.gitignore` (or create it) so the cache never accidentally
 * ships in CI artifacts.
 *
 * Cache hits require BOTH the absolute path AND the source's current SHA-256
 * to match the cached entry. A rename invalidates the OLD path's entry on
 * the next build (when no `<Image>` reference points at it anymore); a content
 * change at the same path invalidates the entry via the sha mismatch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import type { AssetRef, CacheEntry, CacheFile } from "./types.js";

const CACHE_DIR_REL = "node_modules/.run402";
const CACHE_FILE_REL = "node_modules/.run402/assetMap.json";
const CACHE_SCHEMA_VERSION = 1;
const GITIGNORE_LINE = "node_modules/.run402/";

export class BuildCache {
  private readonly cacheDir: string;
  private readonly cacheFile: string;
  private readonly gitignorePath: string;
  private entries: Map<string, CacheEntry>;
  private gitignoreChecked = false;

  constructor(projectRoot: string) {
    this.cacheDir = pathResolve(projectRoot, CACHE_DIR_REL);
    this.cacheFile = pathResolve(projectRoot, CACHE_FILE_REL);
    this.gitignorePath = pathResolve(projectRoot, ".gitignore");
    this.entries = this.load();
  }

  /**
   * Look up a cached AssetRef. Returns null if absent or if the source's
   * current sha differs from the cached entry's sha (i.e., the source
   * content changed since the cache was written).
   */
  get(absolutePath: string, currentSha: string): AssetRef | null {
    const entry = this.entries.get(absolutePath);
    if (!entry) return null;
    if (entry.sha256 !== currentSha) return null;
    return entry.assetRef;
  }

  /**
   * Store an AssetRef in the cache. First call per process ensures the cache
   * directory exists, the cache file is writable, and `.gitignore` excludes
   * the cache dir.
   */
  set(absolutePath: string, sha256: string, assetRef: AssetRef): void {
    this.entries.set(absolutePath, { sha256, assetRef, cachedAt: Date.now() });
    this.ensureCacheDir();
    this.ensureGitignore();
    this.flush();
  }

  /**
   * Drop a single entry from the cache. Used when an absolute path is no
   * longer referenced AND a follow-up cleanup pass wants to keep the cache
   * tidy. Not currently invoked automatically — stale entries are harmless
   * because lookups are keyed by both path AND sha.
   */
  delete(absolutePath: string): void {
    if (this.entries.delete(absolutePath)) {
      this.flush();
    }
  }

  /** Test-only: snapshot the current entry set. */
  size(): number {
    return this.entries.size;
  }

  /** Test-only: dump the cache for inspection. */
  dump(): { [absolutePath: string]: CacheEntry } {
    return Object.fromEntries(this.entries);
  }

  private load(): Map<string, CacheEntry> {
    if (!existsSync(this.cacheFile)) return new Map();
    try {
      const raw = readFileSync(this.cacheFile, "utf-8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== CACHE_SCHEMA_VERSION) return new Map();
      return new Map(Object.entries(parsed.entries));
    } catch {
      // Corrupt cache → treat as empty. Next write will overwrite.
      return new Map();
    }
  }

  private flush(): void {
    const file: CacheFile = {
      version: CACHE_SCHEMA_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    writeFileSync(this.cacheFile, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  }

  private ensureCacheDir(): void {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Append `node_modules/.run402/` to `<project-root>/.gitignore` on first
   * use, creating the file if absent. Idempotent: re-runs detect the
   * existing line and no-op.
   */
  private ensureGitignore(): void {
    if (this.gitignoreChecked) return;
    this.gitignoreChecked = true;

    let existing = "";
    if (existsSync(this.gitignorePath)) {
      try {
        existing = readFileSync(this.gitignorePath, "utf-8");
      } catch {
        return;
      }
    }

    const lines = existing.split(/\r?\n/);
    const hasLine = lines.some(
      (line) =>
        line.trim() === GITIGNORE_LINE ||
        line.trim() === GITIGNORE_LINE.replace(/\/$/, "") ||
        line.trim() === `${GITIGNORE_LINE}assetMap.json`,
    );
    if (hasLine) return;

    // Ensure the file ends with a newline before appending.
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const updated = `${existing}${sep}${GITIGNORE_LINE}\n`;
    try {
      // Make sure parent dir exists for the rare case where the user runs
      // an Astro build inside an unusual directory layout.
      mkdirSync(dirname(this.gitignorePath), { recursive: true });
      writeFileSync(this.gitignorePath, updated, "utf-8");
    } catch {
      // Non-fatal: surface a warning later in the integration if needed,
      // but don't block the build. The cache still works.
    }
  }
}
