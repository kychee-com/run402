/**
 * Node-only filesystem byte-source helpers for `deploy.apply`.
 *
 * `fileSetFromDir(path)` walks a directory and emits a path-keyed `FileSet`
 * of `FsFileSource` markers. The SDK normalizer reads each file's bytes
 * lazily during the plan/upload phases — never loaded into memory at
 * collection time. Suitable for multi-GB build outputs.
 */

import { readdir, lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { LocalError } from "../errors.js";
import type { FileSet, FsFileSource } from "../namespaces/deploy.types.js";

const DEFAULT_IGNORE = new Set([".git", "node_modules", ".DS_Store"]);
const CONTEXT = "collecting files for deploy";

export interface FileSetFromDirOptions {
  /** Additional names to skip at any depth. Merged with the default ignore
   *  list (`.git`, `node_modules`, `.DS_Store`). */
  ignore?: Iterable<string>;
}

/**
 * Walk a directory and return a `FileSet` whose values are `FsFileSource`
 * markers. Each marker holds an absolute path and an extension-derived
 * content-type; the deploy normalizer hashes and uploads each file from
 * disk on demand.
 *
 * Skips `.git`, `node_modules`, `.DS_Store` (plus any names in
 * `opts.ignore`) at every depth. Rejects symlinks. Throws `LocalError` if
 * the directory does not exist, is not a directory, or contains no
 * deployable files after the ignore list is applied.
 *
 * @example
 *   import { run402 } from "@run402/sdk/node";
 *   import { fileSetFromDir } from "@run402/sdk/node";
 *   const r = run402();
 *   await r.deploy.apply({
 *     project,
 *     site: { replace: fileSetFromDir("./dist") },
 *   });
 */
export async function fileSetFromDir(
  root: string,
  opts: FileSetFromDirOptions = {},
): Promise<FileSet> {
  const ignore = new Set<string>(DEFAULT_IGNORE);
  if (opts.ignore) for (const name of opts.ignore) ignore.add(name);

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
    throw new LocalError(`path ${root} is not a directory`, CONTEXT);
  }

  const out: Record<string, FsFileSource> = {};
  await walkInto(root, root, ignore, out);

  if (Object.keys(out).length === 0) {
    throw new LocalError(
      `directory ${root} contains no deployable files`,
      CONTEXT,
    );
  }
  return out;
}

async function walkInto(
  root: string,
  current: string,
  ignore: Set<string>,
  out: Record<string, FsFileSource>,
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
    if (ignore.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new LocalError(
        `symlink found at ${fullPath} (following symlinks is not supported)`,
        CONTEXT,
      );
    }
    if (entry.isDirectory()) {
      await walkInto(root, fullPath, ignore, out);
      continue;
    }
    if (entry.isFile()) {
      const rel = normalizeRelPath(relative(root, fullPath));
      out[rel] = { __source: "fs-file", path: fullPath };
    }
  }
}

/** Normalize a relative path to POSIX forward slashes. Exposed for tests. */
export function normalizeRelPath(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}
