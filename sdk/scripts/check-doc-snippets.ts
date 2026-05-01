#!/usr/bin/env -S tsx
/**
 * check-doc-snippets — type-check every TypeScript fenced block in the SDK's
 * agent-facing documentation against the SDK's published types.
 *
 * Implements the `sdk-docs-fidelity` capability:
 *   - Extracts ```ts / ```typescript / ```tsx fenced blocks from the input docs
 *     (default: `sdk/README.md`, `sdk/llms-sdk.txt`, plus the top-level
 *     `README.md`)
 *   - Wraps each behind a stub preamble (Node entry by default; isomorphic
 *     entry when the doc places `<!-- snippet-mode: isomorphic -->`
 *     immediately above the fence)
 *   - Compiles them all in a single TypeScript program against `@run402/sdk`
 *     and `@run402/sdk/node` (resolved via the workspace's `node_modules` /
 *     local SDK build under `sdk/dist/`)
 *   - Prints agent-readable failures (file:line-range header, the synthesized
 *     snippet, the verbatim `tsc` diagnostic) and exits non-zero on any error.
 *
 * Files in the gate:
 *   - sdk/README.md               (Node-entry examples)
 *   - sdk/llms-sdk.txt            (Node-entry examples; some isomorphic)
 *   - README.md                   (top-level project README; mostly Node)
 *   The top-level Chinese translation `README.zh-CN.md` is intentionally
 *   excluded — translated prose only, no executable TypeScript.
 *
 * Schema: see `openspec/changes/fix-sdk-doc-drift-and-ci-gate/specs/sdk-docs-fidelity/spec.md`
 * (in run402-private). Design rationale: see `design.md` in the same change.
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ─── Paths ───────────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SDK_DIR, "..");

/**
 * Default file list when the script is invoked with no arguments. The Chinese
 * translation `README.zh-CN.md` is intentionally excluded — translated prose
 * with no executable TypeScript fences (verified at the time this list was
 * authored). If a future edit adds TS fences there, include it explicitly.
 */
const DEFAULT_FILES = [
  resolve(SDK_DIR, "README.md"),
  resolve(SDK_DIR, "llms-sdk.txt"),
  resolve(REPO_ROOT, "README.md"),
];

// ─── Stub preambles ──────────────────────────────────────────────────────────

/**
 * Names a snippet may reference without explicit construction. The list grew
 * organically — when CI fails with `Cannot find name 'X'.`, either declare X
 * inside the snippet or add it to the appropriate preamble below.
 */
/**
 * Names declared in the preamble. When CI fails with `Cannot find name 'X'.`
 * either declare X inside the snippet or add it here.
 *
 * Value imports come first (they double as types and as runtime values for
 * `instanceof` checks); type-only imports follow. Names absent from the
 * SDK's exports (e.g. `AssetRef`, which lives in `blobs.types.ts` but isn't
 * re-exported) MUST NOT appear here — surface them as snippet-local
 * `declare const x: ReturnType<typeof r.blobs.put>` instead.
 */

const NODE_PREAMBLE = `
import {
  run402,
  fileSetFromDir,
  files,
  Run402,
  Run402Error,
  PaymentRequired,
  ProjectNotFound,
  Unauthorized,
  ApiError,
  NetworkError,
  LocalError,
  Run402DeployError,
  Deploy,
} from "@run402/sdk/node";
import type {
  ApplyOptions,
  Client,
  CommitResponse,
  ContentRef,
  ContentSource,
  CredentialsProvider,
  DatabaseSpec,
  DeployDiff,
  DeployEvent,
  DeployOperation,
  DeployResult,
  ExposeManifest,
  FileSet,
  FsFileSource,
  FunctionSpec,
  FunctionsSpec,
  MigrationSpec,
  PaymentRequiredHint,
  PlanRequest,
  PlanResponse,
  ProjectKeys,
  ReleaseSpec,
  Run402Options,
  SecretsSpec,
  SiteSpec,
  StartOptions,
  SubdomainsSpec,
} from "@run402/sdk/node";

/// <reference types="node" />

declare const r: ReturnType<typeof run402>;
declare const projectId: string;
declare const operationId: string;
declare const planId: string;
declare const expectedSha: string;
declare const bytes: Uint8Array;
declare const pngBytes: Uint8Array;
declare const jsSource: string;
declare const css: string;
declare const session: { token: string; projects: Record<string, ProjectKeys> };
declare const spec: ReleaseSpec;
declare const wallet: { address: string };
`.trim();

const ISOMORPHIC_PREAMBLE = `
import {
  Run402,
  run402,
  files,
  Run402Error,
  PaymentRequired,
  ProjectNotFound,
  Unauthorized,
  ApiError,
  NetworkError,
  LocalError,
  Run402DeployError,
  Deploy,
} from "@run402/sdk";
import type {
  ApplyOptions,
  Client,
  CommitResponse,
  ContentRef,
  ContentSource,
  CredentialsProvider,
  DatabaseSpec,
  DeployDiff,
  DeployEvent,
  DeployOperation,
  DeployResult,
  ExposeManifest,
  FileSet,
  FsFileSource,
  FunctionSpec,
  FunctionsSpec,
  MigrationSpec,
  PaymentRequiredHint,
  PlanRequest,
  PlanResponse,
  ProjectKeys,
  ReleaseSpec,
  Run402Options,
  SecretsSpec,
  SiteSpec,
  StartOptions,
  SubdomainsSpec,
} from "@run402/sdk";

/// <reference types="node" />

declare const r: Run402;
declare const projectId: string;
declare const operationId: string;
declare const planId: string;
declare const expectedSha: string;
declare const bytes: Uint8Array;
declare const pngBytes: Uint8Array;
declare const jsSource: string;
declare const css: string;
declare const session: { token: string; projects: Record<string, ProjectKeys> };
declare const spec: ReleaseSpec;
declare const wallet: { address: string };
`.trim();

/**
 * Used for snippets that import `@run402/sdk*` or `@run402/functions`
 * themselves, or construct `r = run402()` themselves. Provides only the
 * supporting `declare const`s for variables snippets routinely REFERENCE
 * but rarely DECLARE (`projectId`, byte buffers, source-text fixtures).
 * Names commonly produced by the snippet itself (`project`, `release`,
 * `op`, `url`, `html`, …) are intentionally NOT declared — they would
 * trigger TS2451 "Cannot redeclare block-scoped variable" the moment a
 * snippet does `const project = await r.projects.provision(...)`.
 *
 * Triple-slash reference pulls in `@types/node` (which is installed at the
 * repo root) so snippets can reference Node globals like `process`. DOM
 * globals (`Request`, `Response`, `fetch`) come from the `lib` config.
 */
const STANDALONE_PREAMBLE = `
/// <reference types="node" />

// Standalone snippets construct their own \`r\` (or import the SDK).
// The preamble only declares supporting fixtures the snippet REFERENCES
// without DECLARING — \`projectId\`, byte buffers, source-text fixtures,
// \`session\` for the iso-credentials example. Anything the snippet
// produces (\`r\`, \`spec\`, \`project\`, \`release\`, \`url\`, \`html\`, …)
// is intentionally absent here so it can be redeclared without collision.
declare const projectId: string;
declare const bytes: Uint8Array;
declare const pngBytes: Uint8Array;
declare const jsSource: string;
declare const css: string;
declare const session: { token: string; projects: Record<string, { anon_key: string; service_key: string }> };
`.trim();

// ─── Snippet extraction ──────────────────────────────────────────────────────

type SnippetMode = "node" | "isomorphic" | "standalone";

interface Snippet {
  /** Source doc path (absolute). */
  sourceFile: string;
  /** 1-based line in the source file where the opening fence appears. */
  startLine: number;
  /** 1-based line in the source file where the closing fence appears. */
  endLine: number;
  /** Raw snippet body (between the fences, no preamble). */
  body: string;
  /** Determined by the `<!-- snippet-mode: isomorphic -->` directive. */
  mode: SnippetMode;
  /** Synthesized in-memory file path for the TS compiler. */
  virtualPath: string;
  /**
   * Number of lines in the preamble (including the trailing newline that
   * separates preamble from body). Used to map diagnostic line numbers back
   * to the source doc.
   */
  preambleLines: number;
}

const TS_INFO_STRINGS = new Set(["ts", "typescript", "tsx"]);
const ISO_DIRECTIVE = /<!--\s*snippet-mode:\s*isomorphic\s*-->/i;

/**
 * Extract every TypeScript fenced block from a doc. Treats only fences whose
 * info-string starts with `ts`, `typescript`, or `tsx` as TypeScript. Ignores
 * indented-code blocks, inline code, and other languages.
 *
 * The lookup for the isomorphic directive walks backwards from the opening
 * fence past blank lines until it sees a non-blank line; if that non-blank
 * line is the directive comment, the snippet is tagged isomorphic.
 */
function extractSnippets(sourceFile: string): Snippet[] {
  const text = readFileSync(sourceFile, "utf8");
  const lines = text.split(/\r?\n/);
  const snippets: Snippet[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fenceMatch = line.match(/^(\s*)(```+)([^\s`]*)\s*(.*?)\s*$/);
    if (!fenceMatch) {
      i += 1;
      continue;
    }
    const [, leadingWs, fenceMarker, infoFirst /* infoRest */] = fenceMatch;

    // We treat indented-code-block fences (4+ leading spaces) as prose.
    if ((leadingWs ?? "").length >= 4) {
      i += 1;
      continue;
    }

    const info = (infoFirst ?? "").trim().toLowerCase();
    const isTs = TS_INFO_STRINGS.has(info);

    // Find the matching closing fence (same marker length, no trailing info).
    const startLine = i + 1; // 1-based
    let j = i + 1;
    let closeLine = -1;
    while (j < lines.length) {
      const candidate = lines[j] ?? "";
      const closeMatch = candidate.match(/^(\s*)(```+)\s*$/);
      if (closeMatch && (closeMatch[2] ?? "").length === (fenceMarker ?? "").length) {
        closeLine = j + 1; // 1-based
        break;
      }
      j += 1;
    }
    if (closeLine === -1) {
      // Unterminated fence — bail on this fence and resume scanning.
      i += 1;
      continue;
    }

    if (isTs) {
      // Look up for the isomorphic directive. Walk back through blank lines.
      let k = i - 1;
      while (k >= 0 && (lines[k] ?? "").trim() === "") k -= 1;
      const previousNonBlank = k >= 0 ? (lines[k] ?? "") : "";

      const body = lines.slice(i + 1, j).join("\n");

      // A snippet that has its own top-level `import` from `@run402/sdk*` or
      // `@run402/functions` is "standalone": its imports would conflict with
      // the preamble's identical imports, producing TS2300 ("Duplicate
      // identifier") errors. Standalone preamble strips all SDK imports and
      // leaves only the supporting fixtures (`projectId`, `bytes`, etc.).
      // Same applies to snippets that construct `r` themselves.
      const importsFromRun402 =
        /\bimport\b[^;]*?from\s*["']@run402\/(sdk(?:\/node)?|functions)["']/.test(body);
      const constructsR = /\bconst\s+r\s*=\s*(run402\b|new\s+Run402\b)/.test(body);

      let mode: SnippetMode;
      if (ISO_DIRECTIVE.test(previousNonBlank)) {
        mode = "isomorphic";
      } else if (importsFromRun402 || constructsR) {
        mode = "standalone";
      } else {
        mode = "node";
      }

      // Anchor virtual paths inside REPO_ROOT so TypeScript's module
      // resolver can walk up and find `node_modules/@run402/sdk*` when
      // snippets `import { run402 } from "@run402/sdk/node"`.
      const virtualPath = `${REPO_ROOT}/__doc-snippets__/${pathKey(sourceFile)}/${startLine}-${closeLine}.${
        info === "tsx" ? "tsx" : "ts"
      }`;

      const preamble =
        mode === "isomorphic"
          ? ISOMORPHIC_PREAMBLE
          : mode === "standalone"
          ? STANDALONE_PREAMBLE
          : NODE_PREAMBLE;
      // Synthesized text is `preamble + "\n" + body`. If preamble splits into
      // N lines, body's first line lands on synth-line N (0-indexed).
      const preambleLines = preamble.split("\n").length;

      snippets.push({
        sourceFile,
        startLine,
        endLine: closeLine,
        body,
        mode,
        virtualPath,
        preambleLines,
      });
    }

    i = j + 1;
  }

  return snippets;
}

function pathKey(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).replace(/[/\\]/g, "_");
}

// ─── Compilation ─────────────────────────────────────────────────────────────

interface SnippetSource {
  snippet: Snippet;
  /** Full synthesized source: preamble + "\n" + body. */
  text: string;
}

function synthesize(snippet: Snippet): SnippetSource {
  const preamble =
    snippet.mode === "isomorphic"
      ? ISOMORPHIC_PREAMBLE
      : snippet.mode === "standalone"
      ? STANDALONE_PREAMBLE
      : NODE_PREAMBLE;
  return {
    snippet,
    text: `${preamble}\n${snippet.body}`,
  };
}

/**
 * Build an in-memory TypeScript program over all synthesized snippet files,
 * resolving `@run402/sdk` and `@run402/sdk/node` from disk normally so we hit
 * the workspace's `sdk/dist/`.
 */
function compile(sources: SnippetSource[]): readonly ts.Diagnostic[] {
  const fileMap = new Map<string, string>();
  for (const s of sources) fileMap.set(s.snippet.virtualPath, s.text);

  // Read SDK tsconfig for the parent compiler options (target, module,
  // strict, moduleResolution). Override only what we need to change for an
  // in-memory snippet bundle.
  const sdkTsconfigPath = resolve(SDK_DIR, "tsconfig.json");
  const parsed = readTsconfig(sdkTsconfigPath);

  const compilerOptions: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    rootDir: undefined,
    outDir: undefined,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    composite: false,
    incremental: false,
    // Ensure snippets resolve `@run402/sdk` and `@run402/sdk/node` against
    // the workspace's local install; baseUrl + paths would shadow that.
    baseUrl: undefined,
    paths: undefined,
    // Bundler resolution lets snippets use bare specifiers without `.js`.
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowJs: false,
    isolatedModules: false,
    types: [],
    lib: ["ES2022", "DOM", "DOM.Iterable"].map(lib => `lib.${lib.toLowerCase()}.d.ts`),
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile?.bind(host);
  const originalFileExists = host.fileExists.bind(host);

  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const synthesized = fileMap.get(fileName);
    if (synthesized !== undefined) {
      return ts.createSourceFile(fileName, synthesized, languageVersionOrOptions, true);
    }
    return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
  };
  host.readFile = (fileName) => {
    const synthesized = fileMap.get(fileName);
    if (synthesized !== undefined) return synthesized;
    return originalReadFile ? originalReadFile(fileName) : undefined;
  };
  host.fileExists = (fileName) => {
    if (fileMap.has(fileName)) return true;
    return originalFileExists(fileName);
  };
  // The default writeFile would write to disk; we forbid it.
  host.writeFile = () => {
    /* noop — we never emit. */
  };

  const program = ts.createProgram({
    rootNames: Array.from(fileMap.keys()),
    options: compilerOptions,
    host,
  });

  return ts.getPreEmitDiagnostics(program);
}

function readTsconfig(path: string): ts.ParsedCommandLine {
  const raw = ts.readConfigFile(path, ts.sys.readFile);
  if (raw.error) {
    throw new Error(formatDiagnostic(raw.error));
  }
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(path));
}

function formatDiagnostic(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, "\n");
}

// ─── Failure formatting ──────────────────────────────────────────────────────

interface SnippetFailure {
  snippet: Snippet;
  text: string;
  diagnostics: ts.Diagnostic[];
}

function groupDiagnosticsBySnippet(
  diagnostics: readonly ts.Diagnostic[],
  sources: SnippetSource[],
): SnippetFailure[] {
  const byPath = new Map<string, SnippetFailure>();
  for (const s of sources) {
    byPath.set(s.snippet.virtualPath, {
      snippet: s.snippet,
      text: s.text,
      diagnostics: [],
    });
  }
  const orphans: ts.Diagnostic[] = [];
  for (const d of diagnostics) {
    const path = d.file?.fileName;
    if (path && byPath.has(path)) {
      byPath.get(path)!.diagnostics.push(d);
    } else {
      orphans.push(d);
    }
  }
  if (orphans.length > 0) {
    // Surface orphan diagnostics — usually module-resolution or config errors.
    process.stderr.write("\n# Project-level diagnostics (not tied to a snippet):\n");
    for (const d of orphans) {
      process.stderr.write(`  ${formatDiagnostic(d)}\n`);
    }
  }
  return Array.from(byPath.values()).filter((f) => f.diagnostics.length > 0);
}

function formatFailure(f: SnippetFailure): string {
  const rel = relative(REPO_ROOT, f.snippet.sourceFile);
  const header = `${rel}:${f.snippet.startLine}-${f.snippet.endLine}  (mode: ${f.snippet.mode})`;
  const out: string[] = [header];
  out.push("─".repeat(Math.min(80, header.length)));
  out.push(indent(f.snippet.body, "  | "));
  out.push("");
  out.push("  Diagnostics:");
  for (const d of f.diagnostics) {
    const { line, column } = mapDiagnosticToSource(d, f.snippet);
    const msg = formatDiagnostic(d);
    const code = `TS${d.code}`;
    out.push(`    ${rel}:${line}:${column}  ${code}  ${msg.split("\n").join(" ")}`);
  }
  return out.join("\n");
}

function mapDiagnosticToSource(
  d: ts.Diagnostic,
  snippet: Snippet,
): { line: number; column: number } {
  if (!d.file || d.start === undefined) {
    return { line: snippet.startLine, column: 1 };
  }
  const pos = d.file.getLineAndCharacterOfPosition(d.start);
  // Diagnostic line is 0-based within the synthesized file. Subtract the
  // preamble's lines, then add the source file's opening-fence line + 1
  // (snippet body begins on the line *after* the fence).
  const synthZeroBased = pos.line;
  const bodyZeroBased = synthZeroBased - snippet.preambleLines;
  if (bodyZeroBased < 0) {
    // Diagnostic landed inside the preamble — surface against the fence.
    return { line: snippet.startLine, column: 1 };
  }
  return {
    line: snippet.startLine + 1 + bodyZeroBased,
    column: pos.character + 1,
  };
}

function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function main(argv: string[]): number {
  const skipBuild = argv.includes("--skip-build");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const docPaths = positional.length > 0 ? positional.map((a) => resolve(a)) : DEFAULT_FILES;

  // Validate inputs.
  const missing = docPaths.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    for (const p of missing) {
      process.stderr.write(`error: doc not found: ${p}\n`);
    }
    return 2;
  }

  // Ensure sdk/dist is fresh — the snippets resolve `@run402/sdk` and
  // `@run402/sdk/node` against the workspace's local install + built dist.
  // Run the build unless explicitly skipped.
  if (!skipBuild) {
    const buildExit = ensureSdkBuilt();
    if (buildExit !== 0) {
      process.stderr.write(
        `error: sdk build failed (exit ${buildExit}); aborting doc-snippet check.\n`,
      );
      return buildExit;
    }
  }

  // Extract.
  const allSnippets: Snippet[] = [];
  for (const p of docPaths) {
    const snippets = extractSnippets(p);
    allSnippets.push(...snippets);
  }
  if (allSnippets.length === 0) {
    process.stderr.write(
      `note: no TypeScript fenced blocks found in ${docPaths.length} doc(s).\n`,
    );
    return 0;
  }

  // Synthesize + compile.
  const sources = allSnippets.map(synthesize);
  const diagnostics = compile(sources);
  const failures = groupDiagnosticsBySnippet(diagnostics, sources);

  if (failures.length === 0) {
    process.stdout.write(
      `ok: ${allSnippets.length} TypeScript snippet(s) across ${docPaths.length} doc(s) compiled cleanly.\n`,
    );
    return 0;
  }

  process.stderr.write(
    `\nFAIL: ${failures.length} of ${allSnippets.length} snippet(s) had compile errors.\n\n`,
  );
  for (const f of failures) {
    process.stderr.write(formatFailure(f));
    process.stderr.write("\n\n");
  }
  return 1;
}

// ─── SDK build helper ────────────────────────────────────────────────────────

/**
 * Ensure `sdk/dist/` is fresh by running the SDK's build pipeline from the
 * repo root. Returns the build's exit code (0 on success). Cross-platform —
 * uses `spawnSync` with the workspace npm CLI rather than shell substitution.
 *
 * Skipped if the caller passes `--skip-build` (useful for fast iterations
 * when the dist tree was just built by a parent process — e.g. CI's
 * `npm run build` step that runs ahead of tests).
 */
function ensureSdkBuilt(): number {
  const distIndex = resolve(SDK_DIR, "dist", "index.d.ts");
  const distNodeIndex = resolve(SDK_DIR, "dist", "node", "index.d.ts");

  // Heuristic: if the .d.ts files exist and are newer than every src/*.ts
  // file, the previous build is fresh enough — skip.
  if (existsSync(distIndex) && existsSync(distNodeIndex) && distIsFresh()) {
    return 0;
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Run from the repo root so the root scripts (`build:core`, `build:sdk`,
  // `build:functions`) resolve. We need build:functions because the
  // top-level README references `@run402/functions` and snippets that
  // import it must resolve.
  for (const script of ["build:core", "build:sdk", "build:functions"]) {
    const result = spawnSync(npm, ["run", script], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

/**
 * True when every `dist/**\/*.d.ts` mtime is newer than every `src/**\/*.ts`
 * mtime (excluding `*.test.ts`). Conservative — any non-test source edited
 * after build returns false, triggering a rebuild.
 */
function distIsFresh(): boolean {
  const distRoot = resolve(SDK_DIR, "dist");
  const srcRoot = resolve(SDK_DIR, "src");
  let oldestDist = Infinity;
  let newestSrc = 0;
  const walk = (dir: string, predicate: (path: string) => boolean, cb: (mtime: number) => void): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p, predicate, cb);
      else if (entry.isFile() && predicate(p)) {
        cb(statSync(p).mtimeMs);
      }
    }
  };
  walk(distRoot, (p) => p.endsWith(".d.ts"), (m) => {
    if (m < oldestDist) oldestDist = m;
  });
  walk(srcRoot, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"), (m) => {
    if (m > newestSrc) newestSrc = m;
  });
  if (oldestDist === Infinity) return false;
  return oldestDist >= newestSrc;
}

process.exit(main(process.argv.slice(2)));
