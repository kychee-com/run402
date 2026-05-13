import { readFileSync } from "fs";
import { resolve, extname } from "path";

const TEXT_EXTS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".json", ".svg", ".xml", ".txt", ".md", ".yaml", ".yml", ".toml", ".csv",
]);

/**
 * Resolve `path` fields in a manifest's files array.
 *
 * For each entry that has `path` instead of `data`, reads the file from disk
 * and sets `data` + `encoding`. Paths are resolved relative to `baseDir`.
 *
 * Entries with `data` already set are left untouched.
 *
 * On read failure, re-throws the underlying fs error with additional context
 * attached:
 *   err.field = `files[<i>].path`
 *   err.absPath = <absolute path that was attempted>
 * (the original Error.code / Error.message / Error.path are preserved).
 *
 * @param {object} manifest  Parsed manifest JSON (mutated in place)
 * @param {string} baseDir   Directory to resolve relative paths from
 * @returns {object}         The same manifest object
 */
export function resolveFilePathsInManifest(manifest, baseDir) {
  if (!Array.isArray(manifest.files)) return manifest;

  for (let i = 0; i < manifest.files.length; i++) {
    const entry = manifest.files[i];
    if (!entry.path || entry.data !== undefined) continue;

    const abs = resolve(baseDir, entry.path);
    const ext = extname(abs).toLowerCase();
    const isText = TEXT_EXTS.has(ext);

    try {
      if (isText) {
        entry.data = readFileSync(abs, "utf-8");
      } else {
        entry.data = readFileSync(abs).toString("base64");
        entry.encoding = "base64";
      }
    } catch (err) {
      err.field = `files[${i}].path`;
      err.absPath = abs;
      throw err;
    }

    // If no explicit file (deploy target name), use the path value
    if (!entry.file) entry.file = entry.path;

    delete entry.path;
  }

  return manifest;
}
