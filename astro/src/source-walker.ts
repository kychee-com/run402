/**
 * Walks the project's source tree to find files that might contain
 * `<Image>` references.
 *
 * Extensions we scan: `.astro`, `.tsx`, `.jsx`, `.mdx`, `.md` (the last
 * because Astro lets `.md` files use components via MDX-style sections in
 * some configurations).
 *
 * Excluded directories: `node_modules`, `dist`, `.astro`, `.git`, anything
 * starting with `.` (hidden), `coverage`, `build`.
 *
 * We deliberately keep this self-contained (no `glob` / `fast-glob`
 * dependency) — Node 22's stdlib `readdir` with `recursive` + `withFileTypes`
 * gives us everything we need.
 */

import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const SCAN_EXTENSIONS = new Set([".astro", ".tsx", ".jsx", ".mdx", ".md"]);

const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  ".astro",
  ".git",
  ".github",
  "coverage",
  "build",
  ".vscode",
  ".idea",
  ".claude",
  ".turbo",
  ".vercel",
  ".netlify",
  ".output",
]);

/**
 * Recursively walk `rootDir` and return absolute paths of all files whose
 * extension matches SCAN_EXTENSIONS.
 *
 * Symlinks are not followed (Node's recursive readdir option doesn't follow
 * symlinks by default in current versions; we keep that conservative
 * default).
 */
export async function walkSourceFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, fullPath, rootDir)) continue;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const dotIdx = entry.name.lastIndexOf(".");
        if (dotIdx === -1) continue;
        const ext = entry.name.slice(dotIdx).toLowerCase();
        if (SCAN_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  return results;
}

function shouldSkipDir(name: string, fullPath: string, rootDir: string): boolean {
  if (EXCLUDE_DIRS.has(name)) return true;
  if (name.startsWith(".")) return true;
  // Skip nested package boundaries (a child node_modules).
  const rel = relative(rootDir, fullPath);
  if (rel.split(sep).some((p) => EXCLUDE_DIRS.has(p))) return true;
  return false;
}
