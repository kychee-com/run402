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
 *
 * The adapter declares itself as supporting:
 *   - `staticOutput: 'stable'`
 *   - `serverOutput: 'stable'`
 *   - `hybridOutput: 'stable'`
 *   - `assets`: edge-middleware-style asset serving via the static fallback path
 *
 * @see the astro-ssr-runtime OpenSpec change
 */

import { writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";

import { detectDynamicImage, detectServerIslands, detectSessionsApi } from "./ssr-detectors.js";

export interface CreateRun402AdapterOptions {
  /** Project id override (normally read from `RUN402_PROJECT_ID`). */
  projectId?: string;
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
  let manifest: Partial<Run402AdapterManifest> = {};
  let buildOutputDir = "";
  let serverDir = "";
  const runtimeServerEntrypoint = fileURLToPath(new URL("./runtime/server.js", import.meta.url));

  return {
    name: "@run402/astro/adapter",
    hooks: {
      "astro:config:setup": ({ config, addRenderer, updateConfig, logger }) => {
        logger.info("Run402 adapter active (output=" + (config.output ?? "static") + ")");

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

      "astro:build:done": async (args: {
        pages: Array<{ pathname: string }>;
        routes?: Array<{
          route?: string;
          pathname?: string;
          prerender?: boolean;
          type?: string;
        }>;
      }) => {
        const { pages, routes } = args;
        manifest.serverEntrypoint = path.join(serverDir, "entry.mjs");
        manifest.clientDir = path.join(buildOutputDir, "run402/client/");

        if (Array.isArray(routes) && routes.length > 0) {
          // Astro 5+ — routes carry per-entry `prerender` truth.
          manifest.routes = routes
            .filter((r) => r.type === undefined || r.type === "page" || r.type === "endpoint")
            .map((r) => {
              const entry: Run402AdapterManifest["routes"][number] = {
                pattern: r.route ?? r.pathname ?? "/",
                prerender: r.prerender === true,
              };
              if (r.pathname) entry.pathname = r.pathname;
              if (r.type === "page" || r.type === "endpoint" || r.type === "redirect" || r.type === "fallback") {
                entry.type = r.type;
              }
              return entry;
            });
        } else {
          // Older Astro shape — `pages[]` only. Every entry in `pages`
          // is a materialized prerendered page (Astro doesn't emit
          // pages[] entries for SSR-only routes), so prerender:true
          // here is correct for this code path.
          manifest.routes = pages.map((p) => ({
            pattern: p.pathname,
            prerender: true,
            pathname: p.pathname,
            type: "page" as const,
          }));
        }
        manifest.features = {
          middleware: true,
          serverIslands: false,
          sessions: false,
          mdx: true,
        };
        manifest.version = "1.0";

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
