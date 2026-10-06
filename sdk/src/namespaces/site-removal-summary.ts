/**
 * Client-side breakdown of the paths a `DESTRUCTIVE_SITE_BULK_REMOVAL`
 * warning lists in `affected`.
 *
 * The gateway counts every removed static path toward its bulk-removal
 * threshold. A framework rebuild renames every content-hashed bundle
 * (`_astro/Foo.Ds5BwtTY.js` → `_astro/Foo.<newhash>.js`), so a routine
 * redeploy can trip the warning without removing a single page. This
 * summary lets a reviewer tell the two cases apart without diffing
 * releases by hand. It is a heuristic and never changes whether the
 * warning blocks; the gateway stays authoritative.
 */

import type { WarningEntry } from "./deploy.types.js";

export const SITE_BULK_REMOVAL_WARNING_CODE = "DESTRUCTIVE_SITE_BULK_REMOVAL";

const PAGE_PATH_SAMPLE_LIMIT = 20;
const OTHER_PATH_SAMPLE_LIMIT = 20;

export interface SiteRemovalSummary {
  /** Number of removed paths the warning listed. */
  total: number;
  /** Removed `.html` / `.htm` files — pages that stop being served. */
  pages: number;
  /** Removed files whose name carries a build content hash (bundler output). */
  content_hashed_build_assets: number;
  /** Removed files that are neither pages nor content-hashed build assets. */
  other: number;
  /** True when every removed path is a content-hashed build asset. */
  only_content_hashed_build_assets: boolean;
  /** Removed path count per top-level directory (`"."` for root files). */
  by_top_level_dir: Record<string, number>;
  /** Up to 20 removed page paths. */
  page_paths: string[];
  /** Up to 20 removed paths that are neither pages nor hashed assets. */
  other_paths: string[];
  confidence: "heuristic";
}

/**
 * A content hash is a `.`- or `-`-separated basename segment of at least
 * eight `[A-Za-z0-9_]` characters that contains a digit or mixes upper
 * and lower case (`Ds5BwtTY`, `CzEebLVq`, `a3f9c2e1`). Plain words such as
 * `component` or `profile` do not qualify.
 */
export function isContentHashedPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const stem = base.slice(0, dot);
  if (/\.html?$/i.test(base)) return false;
  for (const segment of stem.split(/[.-]/).slice(1)) {
    if (!/^[A-Za-z0-9_]{8,}$/.test(segment)) continue;
    if (/\d/.test(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment))) return true;
  }
  return false;
}

function isPagePath(path: string): boolean {
  return /\.html?$/i.test(path);
}

function topLevelDir(path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  const slash = trimmed.indexOf("/");
  return slash === -1 ? "." : trimmed.slice(0, slash);
}

export function summarizeSiteRemoval(paths: readonly string[]): SiteRemovalSummary {
  const byDir: Record<string, number> = {};
  const pagePaths: string[] = [];
  const otherPaths: string[] = [];
  let pages = 0;
  let hashed = 0;
  let other = 0;
  for (const path of paths) {
    const dir = topLevelDir(path);
    byDir[dir] = (byDir[dir] ?? 0) + 1;
    if (isPagePath(path)) {
      pages += 1;
      if (pagePaths.length < PAGE_PATH_SAMPLE_LIMIT) pagePaths.push(path);
    } else if (isContentHashedPath(path)) {
      hashed += 1;
    } else {
      other += 1;
      if (otherPaths.length < OTHER_PATH_SAMPLE_LIMIT) otherPaths.push(path);
    }
  }
  return {
    total: paths.length,
    pages,
    content_hashed_build_assets: hashed,
    other,
    only_content_hashed_build_assets: paths.length > 0 && hashed === paths.length,
    by_top_level_dir: byDir,
    page_paths: pagePaths,
    other_paths: otherPaths,
    confidence: "heuristic",
  };
}

/**
 * Adds `details.removed_paths_summary` to each bulk-removal warning that
 * lists its paths and does not already carry a summary. Other warnings
 * pass through untouched.
 */
export function withSiteRemovalSummaries(warnings: WarningEntry[]): WarningEntry[] {
  let changed = false;
  const next = warnings.map((warning) => {
    if (warning?.code !== SITE_BULK_REMOVAL_WARNING_CODE) return warning;
    if (!Array.isArray(warning.affected) || warning.affected.length === 0) return warning;
    if (warning.details && "removed_paths_summary" in warning.details) return warning;
    changed = true;
    return {
      ...warning,
      details: {
        ...(warning.details ?? {}),
        removed_paths_summary: summarizeSiteRemoval(warning.affected.filter((p): p is string => typeof p === "string")),
      },
    } as WarningEntry;
  });
  return changed ? next : warnings;
}
