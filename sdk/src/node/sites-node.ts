/**
 * Node-only augmentation of the `sites` namespace.
 *
 * Adds a `deployDir(dir)` helper that walks a directory on disk, reads
 * each file, detects text vs. binary, and assembles the inline
 * `SiteFile[]` manifest the isomorphic `Sites.deploy()` expects.
 *
 * This file imports `node:fs/promises` and so cannot run in a V8 isolate.
 * It is only wired into the SDK via the `@run402/sdk/node` entry point.
 */

import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { Sites, type SiteFile, type SiteDeployResult } from "../namespaces/sites.js";
import { LocalError } from "../errors.js";

const DEFAULT_IGNORE = new Set([".git", "node_modules", ".DS_Store"]);
const CONTEXT = "deploying directory";

export interface DeployDirOptions {
  /** Project ID the deployment is linked to. */
  project: string;
  /** Local directory to walk. Paths in the manifest are relative to this root. */
  dir: string;
  /** When true, unchanged files are copied from the previous deployment server-side. */
  inherit?: boolean;
  /** Deployment target label, e.g. `"production"`. */
  target?: string;
}

/**
 * Sites namespace enriched with the Node-only `deployDir` convenience.
 * All existing `Sites` methods are inherited unchanged.
 */
export class NodeSites extends Sites {
  /**
   * Deploy every file under `dir` as a static site. Equivalent to calling
   * {@link Sites.deploy} with a manifest you assembled by hand, but the
   * walk, binary detection, and encoding are handled for you.
   *
   * Files named `.git`, `node_modules`, or `.DS_Store` are skipped at every
   * depth. Symlinks cause a {@link LocalError} — they are not followed.
   */
  async deployDir(opts: DeployDirOptions): Promise<SiteDeployResult> {
    const files = await collectSiteFiles(opts.dir);
    if (files.length === 0) {
      throw new LocalError(
        `directory ${opts.dir} contains no deployable files`,
        CONTEXT,
      );
    }
    return this.deploy(opts.project, {
      files,
      inherit: opts.inherit,
      target: opts.target,
    });
  }
}

/**
 * Walk `root` and return a `SiteFile[]` with POSIX-style relative paths.
 * Exported for tests; not part of the public SDK API.
 */
export async function collectSiteFiles(root: string): Promise<SiteFile[]> {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (err) {
    throw new LocalError(
      `cannot read directory ${root}: ${(err as Error).message}`,
      CONTEXT,
      err,
    );
  }
  if (rootStat.isSymbolicLink()) {
    throw new LocalError(
      `symlink found at ${root} (following symlinks is not supported)`,
      CONTEXT,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new LocalError(
      `path ${root} is not a directory`,
      CONTEXT,
    );
  }

  const out: SiteFile[] = [];
  await walkInto(root, root, out);
  return out;
}

async function walkInto(
  root: string,
  current: string,
  out: SiteFile[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (err) {
    throw new LocalError(
      `cannot read directory ${current}: ${(err as Error).message}`,
      CONTEXT,
      err,
    );
  }
  for (const entry of entries) {
    if (DEFAULT_IGNORE.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new LocalError(
        `symlink found at ${fullPath} (following symlinks is not supported)`,
        CONTEXT,
      );
    }
    if (entry.isDirectory()) {
      await walkInto(root, fullPath, out);
      continue;
    }
    if (entry.isFile()) {
      let bytes;
      try {
        bytes = await readFile(fullPath);
      } catch (err) {
        throw new LocalError(
          `cannot read file ${fullPath}: ${(err as Error).message}`,
          CONTEXT,
          err,
        );
      }
      const rel = normalizeRelPath(relative(root, fullPath));
      out.push(encodeSiteFile(rel, bytes));
    }
  }
}

/**
 * Normalize a relative path to POSIX forward slashes. Exposed for tests;
 * not part of the public SDK API.
 */
export function normalizeRelPath(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

function encodeSiteFile(path: string, bytes: Buffer): SiteFile {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { file: path, data: text, encoding: "utf-8" };
  } catch {
    return { file: path, data: bytes.toString("base64"), encoding: "base64" };
  }
}
