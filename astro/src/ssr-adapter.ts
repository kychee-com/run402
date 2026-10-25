/**
 * Run402 Astro adapter — capability `astro-ssr-runtime`.
 *
 * The adapter is an `AstroIntegration` that:
 *
 *   1. Registers itself as the Astro adapter via `setAdapter` in the
 *      `astro:config:done` hook (`serverEntrypoint` points at the
 *      installed `runtime/server.js` file).
 *   2. Runs build-time detectors for unsupported Astro features
 *      (dynamic `<Image>`, server islands, sessions API).
 *   3. Emits `dist/run402/adapter.json` in `astro:build:done` —
 *      a manifest the Run402 CLI's `run402 deploy` consumes to
 *      assemble the multi-slice ReleaseSpec (site + functions + routes).
 *   4. Keeps the SSR server output deterministic in `astro:build:done`:
 *      sorts Astro's racy manifest `assets` list and warns when
 *      `ASTRO_KEY` is unset (see ssr-determinism.ts), so an unchanged
 *      commit does not redeploy the ssr function.
 *
 * The adapter declares itself as supporting:
 *   - `staticOutput: 'stable'`
 *   - `serverOutput: 'stable'`
 *   - `hybridOutput: 'stable'`
 *   - `assets`: edge-middleware-style asset serving via the static fallback path
 *
 * @see the astro-ssr-runtime OpenSpec change
 */

import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";

import { detectDynamicImage, detectServerIslands, detectSessionsApi } from "./ssr-detectors.js";
import { astroKeyWarning, normalizeServerOutput } from "./ssr-determinism.js";
import { shouldInstallDevSession } from "./dev-session.js";

/**
 * Lambda settings for the `ssr` function the pages render in. Omitted
 * values take the gateway default: the tier's SSR memory cap (on team,
 * 1,769 MB, one vCPU) and the tier's timeout cap. Lambda gives CPU in
 * proportion to memory, so memory is also how fast a page renders.
 */
export interface Run402SsrFunctionOptions {
  /** Memory in MB, a whole number from 128 to the tier's SSR cap. */
  memoryMb?: number;
  /** Timeout in seconds, a whole number from 1 to the tier's cap. */
  timeoutSeconds?: number;
}

export interface CreateRun402AdapterOptions {
  /** Project id override (normally read from `RUN402_PROJECT_ID`). */
  projectId?: string;
  /** The `ssr` function's memory and timeout, recorded in `adapter.json`. */
  ssr?: Run402SsrFunctionOptions;
}

/** Lambda's own bounds; the tier caps are the gateway's to enforce. */
const SSR_MEMORY_MB_RANGE = [128, 10_240] as const;
const SSR_TIMEOUT_SECONDS_RANGE = [1, 900] as const;

/**
 * Check `run402({ ssr: { ... } })` when the config loads and return the
 * settings to record, or `undefined` when none are set. Throws a
 * `TypeError` naming the field for anything but a whole number in range.
 */
export function normalizeSsrFunctionOptions(
  ssr: Run402SsrFunctionOptions | undefined,
): Run402SsrFunctionOptions | undefined {
  if (ssr === undefined) return undefined;
  if (ssr === null || typeof ssr !== "object" || Array.isArray(ssr)) {
    throw new TypeError("@run402/astro: `ssr` must be true, false, or { memoryMb?, timeoutSeconds? }.");
  }
  for (const key of Object.keys(ssr)) {
    if (key !== "memoryMb" && key !== "timeoutSeconds") {
      throw new TypeError(`@run402/astro: unknown \`ssr.${key}\`; the ssr function takes memoryMb and timeoutSeconds.`);
    }
  }
  const out: Run402SsrFunctionOptions = {};
  const check = (field: "memoryMb" | "timeoutSeconds", [min, max]: readonly [number, number], unit: string): void => {
    const value = ssr[field];
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new TypeError(
        `@run402/astro: \`ssr.${field}\` must be a whole number of ${unit} from ${min} to ${max} (got ${String(value)}).`,
      );
    }
    out[field] = value;
  };
  check("memoryMb", SSR_MEMORY_MB_RANGE, "MB");
  check("timeoutSeconds", SSR_TIMEOUT_SECONDS_RANGE, "seconds");
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Run402 SSR adapter manifest — written to `dist/run402/adapter.json`
 * after build. The Run402 CLI (`run402 deploy`) and the
 * `@run402/astro/release-slice` SDK helper read this file to assemble
 * the multi-slice ReleaseSpec.
 */
export interface Run402AdapterManifest {
  /** Manifest version — bumped on breaking changes. */
  version: "1.0";
  /** Astro version this build was produced against. */
  astroVersion: string;
  /** Astro `output` mode at build time. */
  output: "server" | "hybrid" | "static";
  /** Path (relative to the Astro project root) of the SSR Lambda
   *  bundle's entry file. */
  serverEntrypoint: string;
  /** Path of the client-assets directory (CSS, JS, public/). */
  clientDir: string;
  /** Per-route metadata — which routes are prerendered (static site
   *  slice) vs which go through the SSR catchall.
   *
   *  `pattern` is Astro's route definition (e.g. `/about`, `/[slug]`).
   *  `pathname` is the materialized URL path for prerendered routes
   *  (populated by Astro from `pages[]`); absent for SSR-only routes.
   *  `prerender` is the truth from Astro's RouteData — the release-slice
   *  helper maps `prerender: true` routes into `site` slice static
   *  aliases and lets `prerender: false` routes fall through the SSR
   *  catchall.
   *
   *  For redirect/fallback route types (rare), `type` is set so the
   *  helper can skip them when emitting routes. */
  routes: Array<{
    pattern: string;
    prerender: boolean;
    pathname?: string;
    type?: "page" | "endpoint" | "redirect" | "fallback";
  }>;
  /** The `ssr` function's Lambda settings from `run402({ ssr: { ... } })`;
   *  the release-slice helper puts them in its `config`. Absent when the
   *  project set none (the gateway default applies). */
  ssr?: Run402SsrFunctionOptions;
  /** `process.env.NODE_ENV` while Astro built the project. Astro sets
   *  `production` unless the environment already set a value; Vite
   *  compiles JSX for production only when it is `production`. The
   *  release-slice helper defines the SSR bundle's
   *  `process.env.NODE_ENV` as this value. Absent in manifests from
   *  adapters that did not record it. */
  nodeEnv?: string;
  /** Astro feature support assessment captured at build time. */
  features: {
    middleware: boolean;
    serverIslands: boolean;
    sessions: boolean;
    mdx: boolean;
  };
}

function resolveAstroVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("astro/package.json") as { version?: unknown };
    if (pkg && typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through
  }
  return "unknown";
}

export function createRun402Adapter(options: CreateRun402AdapterOptions = {}): AstroIntegration {
  const ssrFunction = normalizeSsrFunctionOptions(options.ssr);
  let manifest: Partial<Run402AdapterManifest> = {};
  let resolvedRoutes: ResolvedRoute[] | undefined;
  let buildOutputDir = "";
  let serverDir = "";
  const runtimeServerEntrypoint = fileURLToPath(new URL("./runtime/server.js", import.meta.url));
  const devSessionMiddlewareEntrypoint = fileURLToPath(new URL("./dev-session-middleware.js", import.meta.url));

  return {
    name: "@run402/astro/adapter",
    hooks: {
      "astro:config:setup": ({ config, addRenderer, updateConfig, addMiddleware, command, logger }) => {
        logger.info("Run402 adapter active (output=" + (config.output ?? "static") + ")");

        // `run402 dev --as <label>`: serve every request signed in as the
        // test user it minted. `astro dev` only, so no build contains it.
        if (shouldInstallDevSession(command, process.env)) {
          addMiddleware({ entrypoint: devSessionMiddlewareEntrypoint, order: "pre" });
          logger.info("Run402 dev: requests run signed in as the `run402 dev --as` test user");
        }

        // Tell Astro to use a server build. The actual adapter
        // registration happens in astro:config:done because that's
        // where setAdapter is available.
        updateConfig({
          build: {
            // Place server output under a Run402-namespaced subdir so
            // `run402 deploy` can find it without ambiguity.
            server: new URL("./run402/server/", config.outDir),
            client: new URL("./run402/client/", config.outDir),
            serverEntry: "entry.mjs",
          },
        });

        manifest.output = (config.output as "server" | "hybrid" | "static" | undefined) ?? "static";
      },

      "astro:config:done": ({ setAdapter, config }) => {
        // Register as the deploy adapter so Astro emits a server build
        // pointing at our runtime entry shim. Astro 6+ contract:
        //   - entrypointResolution: "auto" — runtime/server.ts directly
        //     exports `handler` + `default`, so Astro resolves the
        //     module by import (no legacy createExports/exports list).
        //   - no adapterFeatures.buildOutput force: let Astro derive
        //     the shape from `output` + per-page `prerender`. Static
        //     sites stay static; routes that opt into `prerender = false`
        //     pull the build into server shape.
        setAdapter({
          name: "@run402/astro",
          entrypointResolution: "auto",
          serverEntrypoint: runtimeServerEntrypoint,
          supportedAstroFeatures: {
            staticOutput: "stable",
            serverOutput: "stable",
            hybridOutput: "stable",
            i18nDomains: "experimental",
            envGetSecret: "stable",
            sharpImageService: "stable",
          },
        });

        manifest.astroVersion = resolveAstroVersion();
        buildOutputDir = fileURLToPath(config.outDir);
        serverDir = fileURLToPath(new URL("./run402/server/", config.outDir));
      },

      "astro:build:setup": ({ logger }) => {
        // Run build-time detectors. They scan the project's source
        // tree for unsupported Astro features and throw structured
        // R402_* errors if found.
        const detectorErrors: Array<{ code: string; message: string; file?: string; line?: number }> = [];

        try {
          detectDynamicImage();
        } catch (err) {
          detectorErrors.push(toEnvelope(err));
        }
        try {
          detectServerIslands();
        } catch (err) {
          detectorErrors.push(toEnvelope(err));
        }
        try {
          detectSessionsApi();
        } catch (err) {
          detectorErrors.push(toEnvelope(err));
        }

        if (detectorErrors.length > 0) {
          for (const e of detectorErrors) {
            logger.error(`[${e.code}] ${e.message}${e.file ? ` (${e.file}${e.line ? `:${e.line}` : ""})` : ""}`);
          }
          throw new Error(
            `Run402 build aborted: ${detectorErrors.length} unsupported Astro feature(s) detected. ` +
              `See log lines tagged with R402_ASTRO_* for details.`,
          );
        }
      },

      "astro:routes:resolved": ({ routes }: { routes: ResolvedRouteLike[] }) => {
        // Astro 5+ replacement for the `routes` param `astro:build:done`
        // no longer receives (gone entirely by Astro 6/7). Fires before
        // the build; keep the latest snapshot for `astro:build:done`.
        resolvedRoutes = routes.map((r) => ({
          pattern: r.pattern,
          prerender: r.isPrerendered === true,
          pathname: r.pathname,
          type: r.type,
          origin: r.origin,
        }));
      },

      "astro:build:done": async (args: {
        logger?: { warn(message: string): void };
        pages: Array<{ pathname: string }>;
        routes?: Array<{
          route?: string;
          pathname?: string;
          prerender?: boolean;
          type?: string;
        }>;
      }) => {
        const { pages, routes, logger } = args;
        manifest.serverEntrypoint = path.join(serverDir, "entry.mjs");
        manifest.clientDir = path.join(buildOutputDir, "run402/client/");
        manifest.routes = adapterManifestRoutes({ pages, routes, resolvedRoutes });
        // Astro has already settled NODE_ENV for this build (it fills
        // `production` when unset), and Vite compiled the server code
        // under it.
        const nodeEnv = process.env.NODE_ENV;
        if (nodeEnv !== undefined) manifest.nodeEnv = nodeEnv;
        // Determinism: only matters when an SSR function ships, i.e.
        // when Astro emitted a server entry. (Not keyed off `routes`:
        // a fully-prerendered site can still emit one.)
        if (existsSync(manifest.serverEntrypoint)) {
          await normalizeServerOutput(serverDir);
          const keyWarning = astroKeyWarning();
          if (keyWarning) logger?.warn(keyWarning);
          const envWarning = nodeEnvWarning(nodeEnv);
          if (envWarning) logger?.warn(envWarning);
        }

        manifest.features = {
          middleware: true,
          serverIslands: false,
          sessions: false,
          mdx: true,
        };
        manifest.version = "1.0";
        if (ssrFunction) manifest.ssr = ssrFunction;

        const outDir = path.join(buildOutputDir, "run402");
        await mkdir(outDir, { recursive: true });
        await writeFile(
          path.join(outDir, "adapter.json"),
          JSON.stringify(manifest, null, 2),
          "utf-8",
        );
      },
    },
  };
}

/**
 * Warning for an SSR build that did not run as `production`. The `ssr`
 * function then ships the development builds of React and other
 * packages that branch on `NODE_ENV`: larger, slower, and possibly over
 * the tier's code-size cap. Returns null for a production build.
 */
export function nodeEnvWarning(nodeEnv: string | undefined): string | null {
  if (nodeEnv === undefined || nodeEnv === "production") return null;
  return (
    `NODE_ENV is "${nodeEnv}" for this build, so the ssr function ships development builds ` +
    `of React and other packages that check NODE_ENV. Deploy a build made with NODE_ENV unset ` +
    `or set to "production".`
  );
}

/** The subset of Astro's `IntegrationResolvedRoute` the adapter reads. */
interface ResolvedRouteLike {
  pattern: string;
  isPrerendered?: boolean;
  pathname?: string;
  type?: string;
  origin?: string;
}

interface ResolvedRoute {
  pattern: string;
  prerender: boolean;
  pathname?: string;
  type?: string;
  origin?: string;
}

type ManifestRoute = Run402AdapterManifest["routes"][number];

const MANIFEST_ROUTE_TYPES = new Set(["page", "endpoint", "redirect", "fallback"]);

function manifestRouteType(type: string | undefined): ManifestRoute["type"] | undefined {
  return type && MANIFEST_ROUTE_TYPES.has(type) ? (type as ManifestRoute["type"]) : undefined;
}

function isServableRouteType(type: string | undefined): boolean {
  return type === undefined || type === "page" || type === "endpoint";
}

/** `/about/`, `about/`, `about` → `about`; `/`, `""` → `""`. */
function pathKey(pathname: string): string {
  return pathname.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Build `adapter.json`'s `routes[]`, newest Astro shape first:
 *
 * 1. `astro:routes:resolved` (Astro 5+): SSR routes come from the resolved
 *    RouteData (`prerender: false`); prerendered routes come from
 *    `pages[]`, the build's concrete output (a dynamic prerendered route
 *    like `/blog/[slug]` has no pathname of its own), typed by the
 *    resolved route that produced each page.
 * 2. `routes` on `astro:build:done` (Astro 4, deprecated in 5).
 * 3. `pages[]` only: every entry is a materialized prerendered page.
 */
function adapterManifestRoutes(input: {
  pages: Array<{ pathname: string }>;
  routes?: Array<{ route?: string; pathname?: string; prerender?: boolean; type?: string }>;
  resolvedRoutes?: ResolvedRoute[];
}): ManifestRoute[] {
  const { pages, routes, resolvedRoutes } = input;

  if (resolvedRoutes && resolvedRoutes.length > 0) {
    const userRoutes = resolvedRoutes.filter(
      (r) => r.origin !== "internal" && isServableRouteType(r.type),
    );
    const out: ManifestRoute[] = [];
    for (const r of userRoutes) {
      if (r.prerender) continue;
      const entry: ManifestRoute = { pattern: r.pattern, prerender: false };
      const type = manifestRouteType(r.type);
      if (type) entry.type = type;
      out.push(entry);
    }
    const prerenderedByPath = new Map<string, ResolvedRoute>();
    for (const r of userRoutes) {
      if (r.prerender && r.pathname !== undefined) prerenderedByPath.set(pathKey(r.pathname), r);
    }
    const emitted = new Set<string>();
    for (const p of pages) {
      const source = prerenderedByPath.get(pathKey(p.pathname));
      emitted.add(pathKey(p.pathname));
      out.push({
        pattern: source?.pattern ?? p.pathname,
        prerender: true,
        pathname: p.pathname,
        type: source?.type === "endpoint" ? "endpoint" : "page",
      });
    }
    // Astro 7 leaves prerendered endpoints (`/rss.xml`) out of `pages[]`
    // even though it emits them; a static route's own pathname covers it.
    for (const [key, r] of prerenderedByPath) {
      if (emitted.has(key)) continue;
      out.push({
        pattern: r.pattern,
        prerender: true,
        pathname: r.pathname,
        type: r.type === "endpoint" ? "endpoint" : "page",
      });
    }
    return out;
  }

  if (Array.isArray(routes) && routes.length > 0) {
    return routes
      .filter((r) => isServableRouteType(r.type))
      .map((r) => {
        const entry: ManifestRoute = {
          pattern: r.route ?? r.pathname ?? "/",
          prerender: r.prerender === true,
        };
        if (r.pathname) entry.pathname = r.pathname;
        const type = manifestRouteType(r.type);
        if (type) entry.type = type;
        return entry;
      });
  }

  return pages.map((p) => ({
    pattern: p.pathname,
    prerender: true,
    pathname: p.pathname,
    type: "page" as const,
  }));
}

function toEnvelope(err: unknown): { code: string; message: string; file?: string; line?: number } {
  if (err && typeof err === "object") {
    const e = err as { code?: string; message?: string; file?: string; line?: number };
    return {
      code: e.code ?? "R402_ASTRO_BUILD_FAILED",
      message: e.message ?? String(err),
      file: e.file,
      line: e.line,
    };
  }
  return { code: "R402_ASTRO_BUILD_FAILED", message: String(err) };
}
