/**
 * Build-time detectors — capability `astro-ssr-runtime`.
 *
 * Three detectors scan the Astro project's source tree at build time
 * and hard-fail with structured R402_ASTRO_* errors if they find
 * features that v1 doesn't support:
 *
 *   - `detectDynamicImage()` — fails on `<Image src={expr}>` where
 *     `expr` is NOT statically resolvable (DB-row access, function
 *     call, runtime variable). Static imports (`import hero from '...'`)
 *     ARE allowed.
 *
 *   - `detectServerIslands()` — fails on `<X server:defer>` /
 *     `<X server:only>` directives.
 *
 *   - `detectSessionsApi()` — fails on `Astro.session.*` access or
 *     `experimental.session` config.
 *
 * Each detector throws a structured error object with `code`, `message`,
 * `suggestedFix`, `docs`, `file`, and `line` when statically determinable.
 *
 * The actual file-system scan uses Astro's project root, walking
 * `src/pages/`, `src/components/`, `src/layouts/`. To avoid loading a
 * full Astro AST parser (heavy), v1 uses targeted regex scans — these
 * are best-effort and may produce occasional false positives. A v1.5
 * upgrade swaps the regex layer for a proper AST visitor (Astro
 * exposes `parseAstro` from `@astrojs/compiler`).
 *
 * @see the astro-ssr-runtime OpenSpec change
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SRC_DIRS = ["src/pages", "src/components", "src/layouts", "src/content"] as const;

export interface DetectorError {
  code: string;
  message: string;
  suggestedFix: string;
  docs: string;
  file?: string;
  line?: number;
}

export class Run402AstroDetectorError extends Error implements DetectorError {
  readonly code: string;
  readonly suggestedFix: string;
  readonly docs: string;
  readonly file?: string;
  readonly line?: number;

  constructor(opts: DetectorError) {
    super(opts.message);
    this.name = "Run402AstroDetectorError";
    this.code = opts.code;
    this.suggestedFix = opts.suggestedFix;
    this.docs = opts.docs;
    this.file = opts.file;
    this.line = opts.line;
  }
}

/**
 * Detect `<Image src={expr}>` where `expr` is NOT a static import
 * binding or a string literal. Throws on first hit.
 *
 * Allowed patterns:
 *   - `<Image src="./hero.jpg" />`              — string literal
 *   - `` <Image src={`./hero.jpg`} /> ``        — template literal (no interpolations)
 *   - `import hero from "./hero.jpg"; <Image src={hero} />` — static-import binding
 *
 * Failed patterns:
 *   - `<Image src={page.heroUrl} />`            — frontmatter variable from DB
 *   - `<Image src={getHero()} />`               — function call
 *   - `<Image src={process.env.HERO_URL} />`    — env variable
 */
export function detectDynamicImage(opts: { cwd?: string; srcDirs?: readonly string[] } = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const srcDirs = opts.srcDirs ?? DEFAULT_SRC_DIRS;

  const files = collectAstroFiles(cwd, srcDirs);
  // Match `<Image src={...}>`. We extract the expression and test it
  // against the "looks static" predicate.
  const imageSrcRegex = /<Image\s+[^>]*?src=\{([^}]+)\}/g;

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    // Collect static-import bindings declared in the frontmatter.
    const staticImports = collectStaticImageImports(content);

    let match: RegExpExecArray | null;
    while ((match = imageSrcRegex.exec(content)) !== null) {
      const expr = match[1].trim();
      if (isStaticImageExpression(expr, staticImports)) continue;

      // Compute file:line for the diagnostic.
      const lineNumber = computeLineNumber(content, match.index);
      throw new Run402AstroDetectorError({
        code: "R402_ASTRO_DYNAMIC_IMAGE_UNSUPPORTED",
        message: `Astro <Image> with runtime-resolved src is not supported. Found: <Image src={${expr}}> at ${path.relative(cwd, file)}:${lineNumber}`,
        suggestedFix:
          "Replace `<Image src={runtimeValue}>` with `<Run402Picture asset={page.hero_asset} />`. At admin upload time, use `assets.put(file, { variants: ['webp', 'display_jpeg', 'blurhash'] })` and store the returned AssetRef JSON in your DB.",
        docs: "https://docs.run402.com/astro/images#dynamic-cms-images",
        file: path.relative(cwd, file),
        line: lineNumber,
      });
    }
  }
}

/**
 * Detect Astro server-island directives (`server:defer` / `server:only`).
 * Throws on first hit.
 */
export function detectServerIslands(opts: { cwd?: string; srcDirs?: readonly string[] } = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const srcDirs = opts.srcDirs ?? DEFAULT_SRC_DIRS;

  const files = collectAstroFiles(cwd, srcDirs);
  // Match `server:defer` or `server:only` directive on any JSX element.
  const islandRegex = /\bserver:(?:defer|only)\b/g;

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const match = islandRegex.exec(content);
    if (match === null) continue;

    const lineNumber = computeLineNumber(content, match.index);
    throw new Run402AstroDetectorError({
      code: "R402_ASTRO_SERVER_ISLAND_UNSUPPORTED",
      message: `Astro server islands (\`${match[0]}\`) are not supported in this Run402 release. Found at ${path.relative(cwd, file)}:${lineNumber}`,
      suggestedFix:
        "Use client islands (`client:load`, `client:idle`, `client:visible`) or move the rendering into the page's frontmatter. Server islands are deferred to a future Run402 release (v1.5+).",
      docs: "https://docs.run402.com/astro/errors#server-islands-unsupported",
      file: path.relative(cwd, file),
      line: lineNumber,
    });
  }
}

/**
 * Detect Astro Sessions API usage (`Astro.session.*` access OR
 * `experimental.session` config). Throws on first hit.
 */
export function detectSessionsApi(opts: { cwd?: string; srcDirs?: readonly string[]; astroConfigPath?: string } = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const srcDirs = opts.srcDirs ?? DEFAULT_SRC_DIRS;

  // Astro.session.* in source files.
  const files = collectAstroFiles(cwd, srcDirs);
  const sessionRegex = /\bAstro\.session\b/g;
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const match = sessionRegex.exec(content);
    if (match === null) continue;

    const lineNumber = computeLineNumber(content, match.index);
    throw new Run402AstroDetectorError({
      code: "R402_ASTRO_SESSIONS_UNSUPPORTED",
      message: `Astro Sessions API (\`Astro.session\`) is not supported in this Run402 release. Found at ${path.relative(cwd, file)}:${lineNumber}`,
      suggestedFix:
        "Use signed HTTP-only cookies (Astro.cookies) or a custom DB-backed session via `db()`. Sessions API is deferred to a future Run402 release.",
      docs: "https://docs.run402.com/astro/errors#sessions-unsupported",
      file: path.relative(cwd, file),
      line: lineNumber,
    });
  }

  // experimental.session in astro.config.mjs/ts/js.
  const candidateConfigs = opts.astroConfigPath
    ? [opts.astroConfigPath]
    : ["astro.config.mjs", "astro.config.ts", "astro.config.js"].map((f) => path.join(cwd, f));
  for (const configPath of candidateConfigs) {
    if (!existsSync(configPath)) continue;
    const content = readFileSync(configPath, "utf-8");
    if (/\bexperimental\s*:[\s\S]{0,200}\bsession\s*:/.test(content)) {
      throw new Run402AstroDetectorError({
        code: "R402_ASTRO_SESSIONS_UNSUPPORTED",
        message: `Astro experimental.session config is not supported in this Run402 release. Found in ${path.relative(cwd, configPath)}`,
        suggestedFix:
          "Remove the `experimental: { session: ... }` config and use Astro.cookies + DB for session state.",
        docs: "https://docs.run402.com/astro/errors#sessions-unsupported",
        file: path.relative(cwd, configPath),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectAstroFiles(cwd: string, srcDirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const sub of srcDirs) {
    const dir = path.join(cwd, sub);
    if (!existsSync(dir)) continue;
    walkSync(dir, out);
  }
  return out;
}

function walkSync(dir: string, out: string[]): void {
  let entries: string[];
  try {
    // readdirSync exists in newer Node; we use sync for build-time tooling.
    entries = require("node:fs").readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walkSync(full, out);
    } else if (stat.isFile()) {
      if (
        entry.endsWith(".astro") ||
        entry.endsWith(".mdx") ||
        entry.endsWith(".ts") ||
        entry.endsWith(".tsx") ||
        entry.endsWith(".js") ||
        entry.endsWith(".jsx")
      ) {
        out.push(full);
      }
    }
  }
}

/**
 * Collect identifiers bound to static image imports in the frontmatter.
 * `import hero from "./hero.jpg"` → `["hero"]`
 * `import { hero } from "./assets.ts"` → currently ignored (named
 *   imports from non-image files might also be tagged; v1 keeps it
 *   conservative and only treats default imports of image-extensioned
 *   sources as image bindings).
 */
function collectStaticImageImports(content: string): Set<string> {
  const out = new Set<string>();
  const importRegex = /import\s+(?:default\s+|)?(\w+)\s+from\s+['"]([^'"]+\.(?:jpg|jpeg|png|gif|webp|avif|svg|heic|heif|tiff))['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    out.add(match[1]);
  }
  return out;
}

/**
 * Predicate: is this `src={...}` expression statically resolvable?
 *
 * Returns true for:
 *   - String literal (already filtered by the regex; defensive)
 *   - Template literal with no interpolations
 *   - Bare identifier where the identifier was declared via static image import
 */
function isStaticImageExpression(expr: string, staticImports: Set<string>): boolean {
  const trimmed = expr.trim();
  // String literal (defensive — the regex `\{([^}]+)\}` shouldn't
  // match a bare `"foo"`, but just in case).
  if (/^['"`].*['"`]$/.test(trimmed) && !trimmed.includes("${")) return true;
  // Template literal without interpolations.
  if (/^`[^`$]*`$/.test(trimmed)) return true;
  // Bare identifier matching a static import.
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && staticImports.has(trimmed)) return true;
  return false;
}

function computeLineNumber(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}
