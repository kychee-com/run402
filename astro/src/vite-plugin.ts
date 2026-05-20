/**
 * Vite plugin that powers the `<Image>` integration.
 *
 * Responsibilities:
 *   1. `buildStart` — discover every `<Image src="literal" />` reference
 *      across the project, resolve sources, upload via the SDK, populate
 *      the registry.
 *   2. `transform` — rewrite each `<Image src="literal" />` in source code
 *      to `<Image src="<absolute-path>" />` so the component reads the
 *      resolved absolute path at render time (the component has no other
 *      mechanism for knowing its caller-file context).
 *   3. `closeBundle` — for any `<Image>` whose resolved source lives inside
 *      `<project-root>/public/`, delete the corresponding `dist/<rel>`
 *      file that Astro's public/ auto-copy step emitted, so the bytes
 *      don't ship in both `internal.deployment_files` AND `internal.blobs`.
 *
 * The plugin is `enforce: 'pre'` so our transform runs BEFORE Astro's
 * compiler sees the source — Astro's compiler is itself a Vite plugin that
 * runs at default priority.
 */

import { existsSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve as pathResolve, sep } from "node:path";
import { BuildCache } from "./cache.js";
import type { AliasConfig } from "./resolver.js";
import { loadAliasConfig, resolveImageSrc } from "./resolver.js";
import { setAssetRef } from "./registry.js";
import { scanForImageRefs, type ImageReference } from "./scanner.js";
import { walkSourceFiles } from "./source-walker.js";
import type { ProjectAssetsClient, UploadLogEvent } from "./uploader.js";
import { uploadAll } from "./uploader.js";

export interface VitePluginState {
  projectRoot: string;
  /** Lazily resolved on first need (alias config + SDK client). */
  aliases: AliasConfig | null;
  /** Project-scoped SDK client. Null until `astro:build:setup` runs. */
  client: ProjectAssetsClient | null;
  cache: BuildCache;
  /** Active prefix for uploaded asset keys. */
  prefix: string;
  /** When true, skip uploads, log discovered references only. */
  dryRun: boolean;
  /** When true, emit per-image AssetRef summary to stderr. */
  verbose: boolean;
  /**
   * Maps `${importingFile}::${src}` → resolved absolute path. Populated by
   * the discovery pass in `buildStart`. Consumed by `transform` to
   * substitute `src` attributes with absolute paths.
   */
  refMap: Map<string, { reference: ImageReference; absolutePath: string }>;
  /**
   * Set of absolute paths that resolved inside `<project>/public/`. These
   * receive special handling at `closeBundle` time.
   */
  publicDirRefs: Set<string>;
}

/**
 * Minimal Vite `Plugin` shape — inlined so the package doesn't depend on
 * `vite` directly for type-checking. The hook signatures here match
 * Vite 5+'s public API; user-side type errors would surface at the time
 * Astro composes our plugin into its Vite config, not here.
 */
export interface MinimalVitePlugin {
  name: string;
  enforce?: "pre" | "post";
  configResolved?(config: { root?: string }): void;
  buildStart?(): void | Promise<void>;
  transform?(code: string, id: string): null | { code: string; map: null };
  closeBundle?(): void | Promise<void>;
}

export function createVitePlugin(state: VitePluginState): MinimalVitePlugin {
  return {
    name: "run402-astro",
    enforce: "pre",

    configResolved(config) {
      state.projectRoot = config.root ?? state.projectRoot;
      // Lazily load aliases now that we have a definitive root.
      if (state.aliases === null) {
        state.aliases = loadAliasConfig(state.projectRoot);
      }
    },

    async buildStart() {
      if (state.client === null && !state.dryRun) {
        // The integration's `astro:build:setup` should have populated this.
        // Bail out — the integration will surface the real error.
        return;
      }

      const files = await walkSourceFiles(state.projectRoot);
      const discovery: ImageReference[] = [];
      for (const file of files) {
        let source: string;
        try {
          source = await readFile(file, "utf-8");
        } catch {
          continue;
        }
        const scan = scanForImageRefs(source, file);
        for (const warning of scan.warnings) {
          // Surface to stderr; Astro's logger may swallow these.
          process.stderr.write(
            `[run402-astro] WARN ${warning.importingFile}:${warning.line}:${warning.column} ${warning.message}\n`,
          );
        }
        discovery.push(...scan.references);
      }

      if (discovery.length === 0) {
        return;
      }

      // Resolve every reference. Resolver throws typed errors with file
      // + path context for any unrecoverable case (leading slash, missing
      // file, unsupported extension).
      const refMap = state.refMap;
      const publicDirRefs = state.publicDirRefs;
      const publicDir = pathResolve(state.projectRoot, "public");
      for (const ref of discovery) {
        const absolutePath = resolveImageSrc(ref.src, ref.importingFile, state.aliases);
        refMap.set(refKey(ref.importingFile, ref.src), { reference: ref, absolutePath });
        if (absolutePath.startsWith(publicDir + sep)) {
          publicDirRefs.add(absolutePath);
        }
      }

      const uniquePaths = new Set(Array.from(refMap.values()).map((v) => v.absolutePath));

      if (state.dryRun) {
        await emitDryRunReport(uniquePaths);
        return;
      }

      if (state.client === null) return;

      const summary = await uploadAll(uniquePaths, state.client, state.cache, {
        prefix: state.prefix,
        log: (e) => emitUploadEvent(e, state.verbose),
      });

      for (const [absPath, result] of summary.results) {
        setAssetRef(absPath, result.assetRef);
      }

      process.stderr.write(
        `[run402-astro] uploaded ${summary.uploaded} / cached ${summary.fromCache} / ` +
          `${summary.bytesUploaded} bytes uploaded, ${summary.bytesReused} bytes reused / ` +
          `${summary.durationMs}ms\n`,
      );
    },

    transform(code, id) {
      if (!shouldTransform(id)) return null;

      const fileRefs = collectRefsForFile(state.refMap, id);
      if (fileRefs.length === 0) return null;

      let modified = code;
      let didChange = false;
      for (const { reference, absolutePath } of fileRefs) {
        const next = rewriteImageSrc(modified, reference.src, absolutePath);
        if (next !== modified) {
          modified = next;
          didChange = true;
        }
      }
      return didChange ? { code: modified, map: null } : null;
    },

    closeBundle() {
      if (state.publicDirRefs.size === 0) return;

      const distDir = pathResolve(state.projectRoot, "dist");
      const publicDir = pathResolve(state.projectRoot, "public");
      if (!existsSync(distDir)) return;

      for (const absPath of state.publicDirRefs) {
        const rel = relative(publicDir, absPath);
        const distCopy = join(distDir, rel);
        if (existsSync(distCopy)) {
          try {
            unlinkSync(distCopy);
            process.stderr.write(`[run402-astro] excluded from dist: ${rel}\n`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[run402-astro] WARN could not exclude ${rel} from dist: ${msg}\n`,
            );
          }
        }
      }
    },
  };
}

function refKey(importingFile: string, src: string): string {
  return `${importingFile}::${src}`;
}

function collectRefsForFile(
  refMap: VitePluginState["refMap"],
  fileId: string,
): { reference: ImageReference; absolutePath: string }[] {
  const out: { reference: ImageReference; absolutePath: string }[] = [];
  for (const value of refMap.values()) {
    if (value.reference.importingFile === fileId) out.push(value);
  }
  return out;
}

function shouldTransform(id: string): boolean {
  // Vite passes IDs with a `?` suffix for sub-modules; strip those first.
  const cleanId = id.split("?")[0] ?? id;
  const dot = cleanId.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = cleanId.slice(dot).toLowerCase();
  return ext === ".astro" || ext === ".tsx" || ext === ".jsx" || ext === ".mdx" || ext === ".md";
}

/**
 * Find every occurrence of `<Image ... src="<src>" ... />` in `code`
 * (handling either-quote literals) and replace the src value with
 * `replacement`. We use the same matching strategy as the scanner: find
 * `<Image` openings, find the tag body end, then do attribute-aware
 * substitution within the body.
 */
function rewriteImageSrc(code: string, originalSrc: string, replacement: string): string {
  const opener = /<Image(?=[\s/>])/g;
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(code)) !== null) {
    const tagStart = match.index;
    const bodyStart = tagStart + match[0].length;
    const bodyEnd = findTagBodyEnd(code, bodyStart);
    if (bodyEnd === -1) {
      // Tag never closes; bail out — leave the rest of the code untouched.
      break;
    }
    const body = code.slice(bodyStart, bodyEnd);

    // src="literal" or src='literal'
    let rewrittenBody = body.replace(
      /(\bsrc\s*=\s*)("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g,
      (whole, prefix, _quoted, dbl, sgl) => {
        const literal = (dbl ?? sgl ?? "").replace(/\\(["'\\])/g, "$1");
        if (literal !== originalSrc) return whole;
        return `${prefix}"${escapeAttrLiteral(replacement)}"`;
      },
    );

    // src={"literal"} (JSX expression with string literal)
    rewrittenBody = rewrittenBody.replace(
      /(\bsrc\s*=\s*)\{\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\}/g,
      (whole, prefix, _quoted, dbl, sgl) => {
        const literal = (dbl ?? sgl ?? "").replace(/\\(["'\\])/g, "$1");
        if (literal !== originalSrc) return whole;
        return `${prefix}{"${escapeAttrLiteral(replacement)}"}`;
      },
    );

    result += code.slice(cursor, bodyStart) + rewrittenBody;
    cursor = bodyEnd;
  }

  result += code.slice(cursor);
  return result;
}

function findTagBodyEnd(source: string, start: number): number {
  let i = start;
  let inSingle = false;
  let inDouble = false;
  let braceDepth = 0;
  while (i < source.length) {
    const ch = source.charCodeAt(i);
    if (!inSingle && !inDouble) {
      if (ch === 123) {
        braceDepth++;
        i++;
        continue;
      }
      if (ch === 125) {
        braceDepth--;
        i++;
        continue;
      }
      if (braceDepth === 0) {
        if (ch === 39) {
          inSingle = true;
          i++;
          continue;
        }
        if (ch === 34) {
          inDouble = true;
          i++;
          continue;
        }
        if (ch === 62 || (ch === 47 && source.charCodeAt(i + 1) === 62)) {
          return i;
        }
      }
    } else if (inSingle && ch === 39) {
      inSingle = false;
    } else if (inDouble && ch === 34) {
      inDouble = false;
    }
    i++;
  }
  return -1;
}

function escapeAttrLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function emitDryRunReport(uniquePaths: Set<string>): Promise<void> {
  const ENCODER_SECONDS_PER_VARIANT = 10;
  const ENCODER_CONCURRENT = 2;
  const estimatedSec = (uniquePaths.size * ENCODER_SECONDS_PER_VARIANT) / ENCODER_CONCURRENT;
  process.stderr.write(`\n========================================\n`);
  process.stderr.write(`[run402-astro] DRY RUN: ${uniquePaths.size} unique image source(s)\n`);
  process.stderr.write(`========================================\n`);
  for (const absPath of uniquePaths) {
    try {
      const bytes = await readFile(absPath);
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(bytes).digest("hex");
      process.stderr.write(`  ${sha.slice(0, 12)} ${bytes.length.toString().padStart(8)} B ${absPath}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  (read failed) ${absPath} -- ${msg}\n`);
    }
  }
  process.stderr.write(
    `[run402-astro] estimated upload duration: ${estimatedSec.toFixed(0)}s ` +
      `(${uniquePaths.size} files × ${ENCODER_SECONDS_PER_VARIANT}s / ${ENCODER_CONCURRENT} concurrent)\n`,
  );
  process.stderr.write(`========================================\n\n`);
}

function emitUploadEvent(event: UploadLogEvent, verbose: boolean): void {
  if (!verbose && event.status !== "failed" && event.status !== "retry") return;
  const tag =
    event.status === "uploaded"
      ? "↑"
      : event.status === "cache_hit"
        ? "·"
        : event.status === "retry"
          ? "⟳"
          : "✗";
  const size = event.size !== undefined ? `${event.size}B` : "";
  const dur = event.durationMs !== undefined ? `${event.durationMs}ms` : "";
  process.stderr.write(
    `[run402-astro] ${tag} ${event.status} ${size} ${dur} ${event.absolutePath}\n`,
  );
}
