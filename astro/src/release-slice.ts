/**
 * `@run402/astro/release-slice` — SDK helper that turns `dist/run402/adapter.json`
 * into ReleaseSpec slice fragments for direct-SDK consumers.
 *
 * Pattern:
 *
 *   import { buildAstroReleaseSlice } from "@run402/astro/release-slice";
 *   import { run402 } from "@run402/sdk";
 *   import { dir } from "@run402/sdk/node";
 *
 *   const slice = await buildAstroReleaseSlice("./dist");
 *   const r = run402();
 *   await r.project(projectId).apply({
 *     database: { migrations: [...] },
 *     secrets:  { require: ["STRIPE_KEY"] },
 *     ...slice,
 *   });
 *
 * The same primitive backs the CLI's `run402 deploy apply --dir <build>` for
 * symmetry: direct-SDK and CLI callers produce byte-identical specs (modulo
 * idempotency key) from the same build output.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  FunctionSpec,
  LocalDirRef,
  RequireRoleSpec,
  RouteSpec,
  SiteSpec,
  StaticCacheClass,
} from "@run402/sdk";

import type { Run402AdapterManifest } from "./ssr-adapter.js";
import { bundleSsrEntry } from "./ssr-bundler.js";

const SUPPORTED_MANIFEST_VERSIONS = new Set<string>(["1.0"]);
const DEFAULT_FUNCTION_NAME = "ssr";
const DEFAULT_HTML_CACHE_CLASS: StaticCacheClass = "html";
const ASTRO_SSR_OUTPUT_CONTRACT_VERSION = "astro.ssr.v1";
const ADAPTER_MANIFEST_RELATIVE = path.join("run402", "adapter.json");
const CLIENT_DIR_RELATIVE = path.join("run402", "client");
const SERVER_DIR_RELATIVE = path.join("run402", "server");
const DEFAULT_ENTRYPOINT_REL = "entry.mjs";
/** Minimum `@run402/sdk` version where `FunctionSpec.class` is in the
 *  SDK's local strict-fields allowlist (`FUNCTION_SPEC_FIELDS` in
 *  `sdk/src/namespaces/deploy.ts`). Earlier SDKs reject `class: 'ssr'`
 *  LOCALLY via `validateKnownFields` before the spec ever reaches the
 *  gateway — the rejection looks like
 *  `Unknown ReleaseSpec field: functions.replace.<name>.class`. */
const MIN_SDK_VERSION_FOR_CLASS_FIELD = "2.18.0";

/**
 * Public-facing error envelope for `@run402/astro/release-slice` failures.
 * Matches the project-wide R402_* shape (`code`, `message`, `suggestedFix`,
 * `docs`) so downstream agent surfaces can render them uniformly.
 */
export class Run402AstroAdapterManifestError extends Error {
  readonly code:
    | "R402_ASTRO_ADAPTER_MANIFEST_MISSING"
    | "R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED";
  readonly file: string;
  readonly suggestedFix: string;
  readonly docs: string;
  readonly observedVersion?: string;

  constructor(opts: {
    code:
      | "R402_ASTRO_ADAPTER_MANIFEST_MISSING"
      | "R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED";
    message: string;
    file: string;
    suggestedFix: string;
    docs: string;
    observedVersion?: string;
  }) {
    super(opts.message);
    this.name = "Run402AstroAdapterManifestError";
    this.code = opts.code;
    this.file = opts.file;
    this.suggestedFix = opts.suggestedFix;
    this.docs = opts.docs;
    if (opts.observedVersion !== undefined) this.observedVersion = opts.observedVersion;
  }
}

/**
 * Thrown when the installed `@run402/sdk` is older than the version that
 * accepts `FunctionSpec.class: 'ssr'` in its local validator (≥2.18.0).
 * The release-slice helper always emits `class: 'ssr'` for the SSR
 * function — without that field, the gateway's v1.52 auto-fallback
 * doesn't route unmatched paths to the function, and hybrid mode breaks.
 * Older SDKs reject the field locally with `Unknown ReleaseSpec field:
 * functions.replace.<name>.class` before any network call.
 *
 * The remedy is always the same: upgrade `@run402/sdk` (and typically
 * `run402` CLI alongside, since the CLI bundles its own SDK).
 */
export class Run402AstroSdkVersionError extends Error {
  readonly code = "R402_ASTRO_SDK_VERSION_TOO_OLD" as const;
  readonly installedVersion: string;
  readonly requiredVersion: string;
  readonly suggestedFix: string;
  readonly docs: string;

  constructor(opts: { installedVersion: string; requiredVersion: string }) {
    super(
      `@run402/astro/release-slice produces specs with FunctionSpec.class: 'ssr' (gateway ` +
        `v1.52+ feature). The installed @run402/sdk version (${opts.installedVersion}) ` +
        `rejects this field locally before the spec reaches the gateway. Required: ` +
        `>=${opts.requiredVersion}.`,
    );
    this.name = "Run402AstroSdkVersionError";
    this.installedVersion = opts.installedVersion;
    this.requiredVersion = opts.requiredVersion;
    this.suggestedFix =
      "Upgrade with `npm install @run402/sdk@latest run402@latest`. " +
      "The CLI bundles its own SDK, so both packages need to be on a matching version.";
    this.docs = "https://docs.run402.com/errors#R402_ASTRO_SDK_VERSION_TOO_OLD";
  }
}

/**
 * Read the installed `@run402/sdk` package.json `version` field. Returns
 * `null` when the package isn't resolvable from the helper's import
 * context — e.g. some bundled test runners shim require() and the resolve
 * fails. A null return falls through to "skip the version check" rather
 * than throwing, so the helper never blocks on a self-inflicted lookup
 * failure. The downstream gateway / SDK validator still catches a real
 * mismatch.
 */
function readInstalledSdkVersion(): string | null {
  try {
    // Use createRequire to resolve relative to this module. The Vite /
    // esbuild build of @run402/astro keeps this as a runtime require —
    // package.json reads aren't statically inlined.
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    const pkg = req("@run402/sdk/package.json") as { version?: unknown };
    if (pkg && typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through
  }
  return null;
}

/** Lowest-common-denominator semver compare. Handles `MAJOR.MINOR.PATCH`
 *  and ignores pre-release / build suffixes (treats `2.18.0-alpha.1` as
 *  `2.18.0` — strictly less than `2.18.0` is the correct comparison since
 *  alphas are pre-releases of the final). Returns negative when a < b,
 *  positive when a > b, 0 on equal. */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [aa, ab, ac] = parse(a);
  const [ba, bb, bc] = parse(b);
  if ((aa ?? 0) !== (ba ?? 0)) return (aa ?? 0) - (ba ?? 0);
  if ((ab ?? 0) !== (bb ?? 0)) return (ab ?? 0) - (bb ?? 0);
  return (ac ?? 0) - (bc ?? 0);
}

function assertSdkSupportsClassField(): void {
  const installed = readInstalledSdkVersion();
  if (installed === null) return; // lookup failed → defer to runtime
  if (compareSemver(installed, MIN_SDK_VERSION_FOR_CLASS_FIELD) < 0) {
    throw new Run402AstroSdkVersionError({
      installedVersion: installed,
      requiredVersion: MIN_SDK_VERSION_FOR_CLASS_FIELD,
    });
  }
}

export interface BuildAstroReleaseSliceOptions {
  /** Materialized function name for the SSR Lambda. Defaults to `"ssr"`. */
  functionName?: string;
  /**
   * Static `cache_class` applied to prerendered HTML aliases. Defaults to
   * `"html"`. Set to a different known class
   * (`"immutable_versioned" | "revalidating_asset"`) or a future literal to
   * tune CDN cache behavior for a specific build.
   */
  cacheClass?: StaticCacheClass;
  /**
   * v1.51+ — when `true`, the gateway enforces a valid project user JWT
   * before invoking the SSR function. Flows through to
   * `functions.replace[functionName].requireAuth` verbatim.
   */
  requireAuth?: boolean;
  /**
   * v1.51+ — declarative application-role gate. Flows through to
   * `functions.replace[functionName].requireRole` verbatim. The gateway
   * resolves the caller's role and rejects callers not in `allowed` with
   * 403 before invoking the function body.
   */
  requireRole?: RequireRoleSpec | null;
}

/**
 * Slice fragments returned by {@link buildAstroReleaseSlice}. Spread into a
 * caller-built `ReleaseSpec`:
 *
 *   await r.project(id).apply({ database, secrets, ...slice });
 *
 * Each fragment is independently optional in `ReleaseSpec`, so consumers can
 * override or omit any of the three before applying.
 */
export interface AstroReleaseSlice {
  site: SiteSpec;
  functions: { replace: Record<string, FunctionSpec> };
  /**
   * Intentionally **omitted** by {@link buildAstroReleaseSlice} (the field is
   * optional, not `{ replace: [] }`). An Astro hybrid release needs no explicit
   * route table: prerendered pages resolve through the static manifest and
   * every other path falls through to the gateway's implicit `class: "ssr"`
   * fallback. Omitting `routes` carries forward any base-release routes (e.g. a
   * separately-declared `/api/*` function) instead of clearing them, and keeps
   * the slice safe to submit from a CI OIDC session that lacks route scopes.
   * Callers who need explicit routes declare them on top of the slice.
   */
  routes?: { replace: RouteSpec[] };
}

/**
 * Read and validate `<distDir>/run402/adapter.json`. Throws a structured
 * {@link Run402AstroAdapterManifestError} when the manifest is absent,
 * unreadable, malformed, or carries an unsupported `version`.
 */
export async function loadAstroAdapterManifest(
  distDir: string,
): Promise<Run402AdapterManifest> {
  const manifestPath = path.resolve(distDir, ADAPTER_MANIFEST_RELATIVE);

  let exists = false;
  try {
    const s = await stat(manifestPath);
    exists = s.isFile();
  } catch {
    // fall through to MISSING
  }
  if (!exists) {
    throw new Run402AstroAdapterManifestError({
      code: "R402_ASTRO_ADAPTER_MANIFEST_MISSING",
      message:
        `Run402 Astro adapter manifest not found at ${manifestPath}. ` +
        `Run \`astro build\` with \`@run402/astro\` registered in \`astro.config.mjs\` first.`,
      file: manifestPath,
      suggestedFix:
        "Run `astro build` with `@run402/astro` registered in `astro.config.mjs`.",
      docs: "https://docs.run402.com/errors#R402_ASTRO_ADAPTER_MANIFEST_MISSING",
    });
  }

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (err) {
    throw new Run402AstroAdapterManifestError({
      code: "R402_ASTRO_ADAPTER_MANIFEST_MISSING",
      message:
        `Run402 Astro adapter manifest at ${manifestPath} could not be read: ${
          err instanceof Error ? err.message : String(err)
        }.`,
      file: manifestPath,
      suggestedFix:
        "Re-run `astro build` so the adapter rewrites adapter.json from scratch.",
      docs: "https://docs.run402.com/errors#R402_ASTRO_ADAPTER_MANIFEST_MISSING",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Run402AstroAdapterManifestError({
      code: "R402_ASTRO_ADAPTER_MANIFEST_MISSING",
      message:
        `Run402 Astro adapter manifest at ${manifestPath} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }.`,
      file: manifestPath,
      suggestedFix:
        "Delete `dist/run402/adapter.json` and re-run `astro build`.",
      docs: "https://docs.run402.com/errors#R402_ASTRO_ADAPTER_MANIFEST_MISSING",
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Run402AstroAdapterManifestError({
      code: "R402_ASTRO_ADAPTER_MANIFEST_MISSING",
      message: `Run402 Astro adapter manifest at ${manifestPath} is not an object.`,
      file: manifestPath,
      suggestedFix: "Re-run `astro build` so the adapter rewrites adapter.json from scratch.",
      docs: "https://docs.run402.com/errors#R402_ASTRO_ADAPTER_MANIFEST_MISSING",
    });
  }

  const manifest = parsed as Run402AdapterManifest;
  if (!SUPPORTED_MANIFEST_VERSIONS.has(manifest.version)) {
    throw new Run402AstroAdapterManifestError({
      code: "R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED",
      message:
        `Run402 Astro adapter manifest at ${manifestPath} declares version ` +
        `"${String(manifest.version)}", which is not in the helper's supported set ` +
        `(${Array.from(SUPPORTED_MANIFEST_VERSIONS).join(", ")}).`,
      file: manifestPath,
      suggestedFix:
        "Upgrade `@run402/astro` and the release-slice helper to compatible versions, " +
        "or pin the adapter to a manifest version this helper accepts.",
      docs: "https://docs.run402.com/errors#R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED",
      observedVersion: String(manifest.version),
    });
  }

  return manifest;
}

/**
 * Compose `{ site, functions, routes }` slice fragments from a Run402-built
 * Astro project's `dist/`.
 *
 * Mechanics:
 *
 * - `site.replace.dir` points at `<distDir>/run402/client/` via a
 *   `LocalDirRef` so the SDK's deploy normalizer expands it into a content-
 *   addressed `FileSet` at submission time (no in-memory file slurp).
 * - `functions.replace[functionName]` describes the SSR Lambda entry from
 *   `manifest.serverEntrypoint` and carries `class: "ssr"` (gateway v1.52+)
 *   so the gateway enables SnapStart + ISR-cache routing.
 * - `routes` is intentionally **omitted** from the returned slice (not
 *   `{ replace: [] }`). An Astro hybrid release needs no explicit route table:
 *   prerendered pages resolve through the static manifest (implicit
 *   `public_paths`), and every unmatched path falls through to the gateway's
 *   implicit `class: "ssr"` fallback (v1.52+). Omitting `routes` carries
 *   forward any base-release routes (e.g. a separately-declared `/api/*`
 *   function) instead of clearing them, and keeps the slice CI-safe — a CI
 *   OIDC session without route scopes is rejected if the spec sets `routes`.
 */
export async function buildAstroReleaseSlice(
  distDir: string,
  opts: BuildAstroReleaseSliceOptions = {},
): Promise<AstroReleaseSlice> {
  // Fail fast on stale `@run402/sdk` installs. The helper always emits
  // `class: 'ssr'` on the SSR function; SDKs older than 2.18.0 reject
  // that field LOCALLY (in `validateKnownFields`) before the spec ever
  // reaches the gateway. Detecting this here means consumers see a
  // precise "upgrade @run402/sdk" message instead of a misleading
  // "Unknown ReleaseSpec field" error after the deploy script's
  // boilerplate runs.
  assertSdkSupportsClassField();
  const manifest = await loadAstroAdapterManifest(distDir);
  const functionName = opts.functionName ?? DEFAULT_FUNCTION_NAME;
  const cacheClass = opts.cacheClass ?? DEFAULT_HTML_CACHE_CLASS;

  const clientDirAbs = path.resolve(distDir, CLIENT_DIR_RELATIVE);
  const siteDir: LocalDirRef = {
    __source: "local-dir",
    path: clientDirAbs,
  };

  // Default public_paths mode: "implicit" — filename-derived reachability
  // from the new client dir. Critically, this OPTS OUT of the gateway's
  // base-release carry-forward semantics: when a prior release used
  // `mode: "explicit"` with declared paths (e.g., `.well-known/kychon.json`),
  // the gateway would otherwise inherit those paths into the new release
  // and reject if the asset isn't present in the new site dir, surfacing
  // as `site.public_paths.inherited.<path>` missing-asset errors.
  //
  // The Astro build's natural shape is filename-URL congruent (`/about` →
  // `<client>/about/index.html`; assets in `public/` → top-level paths in
  // the client dir), so implicit mode is semantically correct for an Astro
  // release. Consumers who need explicit per-path overrides pass `cacheClass`
  // and the helper switches to `mode: "explicit"` with a fully-declared map.
  const site: SiteSpec = {
    replace: siteDir,
    public_paths: { mode: "implicit" },
  };

  // Bundle the Astro server output into a single ESM source. The
  // gateway's `validateFunctionSpec` rejects multi-file function specs
  // ("multi-file function spec (files + entrypoint) is not yet supported
  // by the gateway; bundle locally with esbuild and pass `source`
  // instead"). esbuild collapses entry.mjs + chunks/ + reachable
  // node_modules into one string we can ship as `FunctionSpec.source`.
  const serverDirAbs = path.resolve(distDir, SERVER_DIR_RELATIVE);
  const entrypointRel = path
    .relative(serverDirAbs, path.resolve(manifest.serverEntrypoint))
    .split(path.sep)
    .join("/");
  const entrypoint =
    entrypointRel && !entrypointRel.startsWith("..") ? entrypointRel : DEFAULT_ENTRYPOINT_REL;

  const bundle = await bundleSsrEntry({
    serverDir: serverDirAbs,
    entrypoint,
  });

  const functionSpec: FunctionSpec = {
    runtime: "node22",
    class: "ssr",
    capabilities: [ASTRO_SSR_OUTPUT_CONTRACT_VERSION],
    source: bundle.code,
  };

  if (opts.requireAuth !== undefined) functionSpec.requireAuth = opts.requireAuth;
  if (opts.requireRole !== undefined) functionSpec.requireRole = opts.requireRole;

  const functions: AstroReleaseSlice["functions"] = {
    replace: { [functionName]: functionSpec },
  };

  // `routes` is intentionally OMITTED from the returned slice (see the doc
  // comment above) — not emitted as `{ replace: [] }`. The gateway (v1.52+,
  // capability `astro-ssr-runtime`) routes every unmatched-path request to the
  // project's single `class: "ssr"` function automatically, and prerendered
  // pages resolve through `site.public_paths`. Omitting `routes` (rather than
  // sending an empty replace, which CLEARS the route table) carries forward any
  // caller-declared base routes (e.g. `/api/*` → a dedicated function) and
  // keeps the slice safe to submit from a CI OIDC session without route scopes.
  // Callers who need explicit routes declare them on top of the slice.

  // `cacheClass` is plumbed into `site.public_paths` for prerendered routes
  // when a caller cares about overriding the default html cache class. The
  // default mode is implicit (filename-derived); when a custom class is
  // supplied we emit an explicit `public_paths.replace` map for the
  // prerendered set.
  if (opts.cacheClass !== undefined) {
    const replace: Record<string, { asset: string; cache_class?: StaticCacheClass }> = {};
    for (const r of manifest.routes ?? []) {
      if (r.type && r.type !== "page" && r.type !== "endpoint") continue;
      if (!r.prerender) continue;
      const raw = r.pathname ?? r.pattern;
      if (raw === undefined || raw === null) continue;
      const pattern = raw === "" ? "/" : raw.startsWith("/") ? raw : `/${raw}`;
      replace[pattern] = {
        asset: prerenderedHtmlPath(pattern),
        cache_class: cacheClass,
      };
    }
    (site as { public_paths?: unknown }).public_paths = {
      mode: "explicit",
      replace,
    };
  }

  return { site, functions };
}

/**
 * Derive the release-asset path of a prerendered HTML file from its public
 * URL pattern. Astro's default emit shape is `<dist>/<route>/index.html`,
 * with `/` becoming `index.html`. The release-asset path is relative to
 * `site.replace.dir`.
 */
function prerenderedHtmlPath(pattern: string): string {
  const p = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "") return "index.html";
  if (/\.html?$/i.test(p)) return p;
  return `${p}/index.html`;
}
