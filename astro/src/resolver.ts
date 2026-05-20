/**
 * Source-path resolution for `<Image src="...">`.
 *
 * Three accepted shapes:
 *   - "./images/hero.jpg" / "../assets/logo.png" — relative to the importing
 *     file's directory.
 *   - "@/images/hero.jpg" — TypeScript-style path alias, resolved against the
 *     project's tsconfig.json `paths` config.
 *   - "package-name/...." — bare specifier, resolved via Node module
 *     resolution (rare for image references but supported for completeness).
 *
 * Leading-slash absolute paths ("/images/...") are REJECTED. They implicitly
 * refer to Astro's public/ directory, which would bypass the Run402 variant
 * pipeline — see design D3.
 *
 * Path-alias resolution is best-effort: we read tsconfig.json once at
 * integration-setup time and match `paths` patterns. We deliberately do NOT
 * pull in tsconfig-paths or @ts-morph/parse-tsconfig because the alias set
 * we need to handle is small (`@/*` style) and adding a transitive dep for
 * the rest of jsconfig.json's surface (extends, compilerOptions.baseUrl,
 * etc.) is more risk than the feature is worth in v0.1.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve as pathResolve, sep } from "node:path";
import {
  LeadingSlashSrcError,
  SourceNotFoundError,
  UnsupportedExtensionError,
} from "./errors.js";
import { SUPPORTED_EXTENSIONS, type SupportedExtension } from "./types.js";

/**
 * Path-alias configuration loaded from tsconfig.json. Pattern keys end in
 * `/*` (e.g., `"@/*"`); target values are an array of base-URL-relative
 * patterns (e.g., `["./src/*"]`).
 */
export interface AliasConfig {
  baseUrl: string; // absolute path
  paths: Map<string, string[]>; // pattern → expansion targets
}

/**
 * Read the project's tsconfig.json (if present) and extract path aliases.
 * Returns `null` if the file is missing or doesn't declare path mappings.
 *
 * Does not handle tsconfig `extends` — sites that split tsconfig should
 * inline their paths in the file the project root points at, OR pass them
 * via a future explicit option. v0.1 keeps this simple.
 */
export function loadAliasConfig(projectRoot: string): AliasConfig | null {
  const tsconfigPath = pathResolve(projectRoot, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(tsconfigPath, "utf-8");
  } catch {
    return null;
  }

  let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    // Strip line + block comments and trailing commas so tsconfig.json
    // files using JSONC syntax don't blow up JSON.parse.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n\r]*/g, "")
      .replace(/,(\s*[}\]])/g, "$1");
    parsed = JSON.parse(stripped) as typeof parsed;
  } catch {
    return null;
  }

  const co = parsed.compilerOptions;
  if (!co || !co.paths || Object.keys(co.paths).length === 0) return null;

  const baseUrl = co.baseUrl ? pathResolve(projectRoot, co.baseUrl) : projectRoot;
  const paths = new Map<string, string[]>();
  for (const [pattern, targets] of Object.entries(co.paths)) {
    if (Array.isArray(targets)) paths.set(pattern, targets);
  }
  return { baseUrl, paths };
}

/**
 * Resolve a `<Image src="...">` prop to an absolute filesystem path.
 *
 * @throws {LeadingSlashSrcError} if `src` begins with `/`
 * @throws {UnsupportedExtensionError} if `src` extension is not in the
 *         SUPPORTED_EXTENSIONS allowlist
 * @throws {SourceNotFoundError} if the resolved path doesn't exist on disk
 */
export function resolveImageSrc(
  src: string,
  importingFile: string,
  aliases: AliasConfig | null,
): string {
  if (typeof src !== "string" || src.length === 0) {
    throw new TypeError(`<Image src> must be a non-empty string (got ${typeof src})`);
  }

  if (src.startsWith("/") && !src.startsWith("//")) {
    throw new LeadingSlashSrcError(src, importingFile);
  }

  let resolved: string;
  if (src.startsWith("./") || src.startsWith("../")) {
    resolved = pathResolve(dirname(importingFile), src);
  } else if (aliases && src.includes("/")) {
    resolved = resolveViaAlias(src, aliases) ?? pathResolve(dirname(importingFile), src);
  } else if (isAbsolute(src)) {
    resolved = src;
  } else {
    // Bare specifier without alias match — fall back to importing-file
    // relative resolution (handles cases like `src="images/hero.jpg"`).
    resolved = pathResolve(dirname(importingFile), src);
  }

  assertSupportedExtension(src, importingFile, resolved);

  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new SourceNotFoundError(src, importingFile, resolved);
  }

  return resolved;
}

/**
 * Match `src` against the alias `paths` map. Returns the resolved absolute
 * path or null if no pattern matches.
 *
 * Pattern matching follows TypeScript semantics: a `*` in the pattern stands
 * for any path segment(s); the same captured value is substituted into the
 * target pattern.
 */
function resolveViaAlias(src: string, aliases: AliasConfig): string | null {
  for (const [pattern, targets] of aliases.paths) {
    const match = matchAliasPattern(pattern, src);
    if (match === null) continue;
    for (const target of targets) {
      const expanded = target.replace("*", match);
      const abs = pathResolve(aliases.baseUrl, expanded);
      if (existsSync(abs)) return abs;
    }
    // Pattern matched but no target file exists — return the first
    // candidate so the SourceNotFoundError below names the expected path.
    if (targets[0]) {
      return pathResolve(aliases.baseUrl, targets[0].replace("*", match));
    }
  }
  return null;
}

function matchAliasPattern(pattern: string, src: string): string | null {
  const starIdx = pattern.indexOf("*");
  if (starIdx === -1) {
    return pattern === src ? "" : null;
  }
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (!src.startsWith(prefix)) return null;
  if (!src.endsWith(suffix)) return null;
  return src.slice(prefix.length, src.length - suffix.length);
}

function assertSupportedExtension(src: string, importingFile: string, resolved: string): void {
  const dotIdx = resolved.lastIndexOf(".");
  const sepIdx = resolved.lastIndexOf(sep);
  if (dotIdx === -1 || dotIdx < sepIdx) {
    throw new UnsupportedExtensionError(src, importingFile, "(none)", SUPPORTED_EXTENSIONS);
  }
  const ext = resolved.slice(dotIdx).toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new UnsupportedExtensionError(src, importingFile, ext, SUPPORTED_EXTENSIONS);
  }
}

/** Test-friendly: extract the lowercased extension of a path. */
export function extensionOf(absPath: string): SupportedExtension | null {
  const dotIdx = absPath.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const ext = absPath.slice(dotIdx).toLowerCase();
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as SupportedExtension)
    : null;
}
