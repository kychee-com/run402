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
const ADAPTER_MANIFEST_RELATIVE = path.join("run402", "adapter.json");
const CLIENT_DIR_RELATIVE = path.join("run402", "client");
const SERVER_DIR_RELATIVE = path.join("run402", "server");
const DEFAULT_ENTRYPOINT_REL = "entry.mjs";

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
  routes: { replace: RouteSpec[] };
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
 * - `routes.replace` emits one `{ type: "static", file }` alias per
 *   prerendered route, followed by a final wildcard `/* → function:ssr`
 *   catchall. Order matters at the gateway: explicit > prefix > catchall.
 */
export async function buildAstroReleaseSlice(
  distDir: string,
  opts: BuildAstroReleaseSliceOptions = {},
): Promise<AstroReleaseSlice> {
  const manifest = await loadAstroAdapterManifest(distDir);
  const functionName = opts.functionName ?? DEFAULT_FUNCTION_NAME;
  const cacheClass = opts.cacheClass ?? DEFAULT_HTML_CACHE_CLASS;

  const clientDirAbs = path.resolve(distDir, CLIENT_DIR_RELATIVE);
  const siteDir: LocalDirRef = {
    __source: "local-dir",
    path: clientDirAbs,
  };

  const site: SiteSpec = { replace: siteDir };

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
    source: bundle.code,
  };

  if (opts.requireAuth !== undefined) functionSpec.requireAuth = opts.requireAuth;
  if (opts.requireRole !== undefined) functionSpec.requireRole = opts.requireRole;

  const functions: AstroReleaseSlice["functions"] = {
    replace: { [functionName]: functionSpec },
  };

  // No explicit routes are emitted by default. The gateway (v1.52+,
  // capability `astro-ssr-runtime`) routes every unmatched-path request
  // to the project's single class:'ssr' function automatically — so
  // the helper does not need to declare a /* catchall (which the route
  // validator rejects anyway: "prefix wildcard must include a path
  // segment before /*"). Prerendered routes are reachable via the
  // gateway's implicit public-paths mode against the static manifest;
  // we do not emit static-route aliases, which previously conflicted
  // with the implicit-mode declaration for the same path.
  //
  // Callers who want explicit prefix routes (e.g. `/api/*` → a dedicated
  // function) can still declare them on top of the slice; the slice's
  // own `routes.replace: []` is intentionally empty so it doesn't
  // clobber that pattern.
  const routes: RouteSpec[] = [];

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

  return { site, functions, routes: { replace: routes } };
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

