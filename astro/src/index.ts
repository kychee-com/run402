/**
 * `@run402/astro` — Astro integration for Run402 image variants.
 *
 * Exports from this module (pure JS, safe to import from astro.config.mjs):
 *   - `run402(options?)` — the Astro integration factory. Add to
 *     `astro.config.mjs` `integrations: [run402()]`.
 *   - Types: `Run402AstroOptions`, `ImageProps`, `AssetRef`, `AssetVariant`.
 *
 * The `<Image>` Astro component is shipped as a separate subpath:
 *
 *     import Image from '@run402/astro/Image.astro';
 *
 * Why subpath: this entry point must evaluate cleanly under vanilla
 * Node (Astro CLI loads `astro.config.mjs` BEFORE Vite is alive, so
 * any top-level `.astro` reference from here dies with "Unknown file
 * extension"). The component file is reached only by Vite/Astro's
 * plugin pipeline once Vite is running, which knows how to compile
 * `.astro` source.
 *
 * The integration itself is intentionally small. The real work lives
 * in the Vite plugin (image discovery, upload, source rewriting,
 * public/ exclusion); this module just wires the plugin into Astro's
 * lifecycle and validates configuration up front.
 */

import path from "node:path";
import { BuildCache } from "./cache.js";
import { MissingProjectIdError } from "./errors.js";
import { loadAliasConfig } from "./resolver.js";
import type { VitePluginState } from "./vite-plugin.js";
import { createVitePlugin } from "./vite-plugin.js";
import type { Run402AstroOptions } from "./types.js";

// Astro's integration type lives at `astro` (peer dep). We import via a
// `type` import so the package can be type-checked without astro being
// resolvable — the runtime never touches it.
type AstroIntegration = {
  name: string;
  hooks: {
    "astro:config:setup"?: (params: {
      config: { root: URL | string };
      updateConfig: (cfg: { vite?: { plugins?: unknown[] } }) => void;
      command: "dev" | "build" | "preview";
      logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
    }) => void | Promise<void>;
    "astro:build:setup"?: (params: unknown) => void | Promise<void>;
    "astro:server:setup"?: (params: unknown) => void | Promise<void>;
  };
};

const DEFAULT_PREFIX = "astro/";
const DEFAULT_MANIFEST_PATH = "dist/_assets-manifest.json";
const DEFAULT_ASSET_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
];

function resolveAssetsDirs(
  projectRoot: string,
  spec: string | string[] | undefined,
): { absolutePath: string; baseDir: string }[] {
  if (!spec) return [];
  const list = Array.isArray(spec) ? spec : [spec];
  return list.map((rel) => {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel);
    return { absolutePath: abs, baseDir: abs };
  });
}

function resolveManifestPath(projectRoot: string, spec: string | undefined): string {
  const rel = spec ?? DEFAULT_MANIFEST_PATH;
  return path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel);
}

export function run402(options: Run402AstroOptions = {}): AstroIntegration {
  const projectId = options.projectId ?? process.env.RUN402_PROJECT_ID;
  const verbose = options.verbose ?? process.env.RUN402_ASTRO_VERBOSE === "true";
  const dryRun = options.dryRun ?? false;
  const prefix = options.assetPrefix ?? DEFAULT_PREFIX;

  return {
    name: "@run402/astro",
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        if (!projectId && !dryRun) {
          throw new MissingProjectIdError();
        }

        const projectRoot = configRootToPath(config.root);

        const state: VitePluginState = {
          projectRoot,
          aliases: loadAliasConfig(projectRoot),
          client: null,
          cache: new BuildCache(projectRoot),
          prefix,
          dryRun,
          verbose,
          refMap: new Map(),
          publicDirRefs: new Set(),
          virtualEntries: new Map(),
          // v0.2 data-driven path. Resolve assetsDir(s) to absolute paths
          // against the project root so the walker doesn't depend on cwd.
          assetsDirs: resolveAssetsDirs(projectRoot, options.assetsDir),
          manifestPath: resolveManifestPath(projectRoot, options.manifestPath),
          assetExtensions: options.assetExtensions ?? DEFAULT_ASSET_EXTENSIONS,
          manifestKeyByAbsPath: new Map(),
          projectId: projectId ?? "(unset)",
        };

        // Lazily initialize the SDK client at the moment we know we need it.
        // The client is real network I/O — we don't want to construct it
        // during config:setup if the user is in dry-run mode.
        if (!dryRun && projectId) {
          state.client = createClientLazy(projectId, options.credentials);
        }

        updateConfig({
          vite: {
            plugins: [createVitePlugin(state)],
          },
        });
      },
    },
  };
}

/**
 * Defer SDK construction until the first time the Vite plugin reads
 * `state.client`. The Vite plugin's `buildStart` is the only consumer; by
 * then npm has resolved `@run402/sdk` and the credential chain can run.
 *
 * **Credential resolution order** (v0.1.5):
 *   1. If `userCredentials` was passed via `run402({ credentials: ... })`
 *      → use it as-is. Power-user escape hatch for non-GitHub CI,
 *      vault-backed providers, or test fixtures.
 *   2. Else if `process.env.GITHUB_ACTIONS === "true"` → use
 *      `githubActionsCredentials({ projectId })`. This is what the
 *      README has always claimed; v0.1.5 makes the claim true.
 *      Closes kychee-com/run402-private#402.
 *   3. Else → bare `run402()`. The SDK's own `NodeCredentialsProvider`
 *      reads the developer's `~/.config/run402/projects.json` keystore
 *      (laptop / dev path).
 *
 * Using a Proxy lets us keep `state.client` typed as `ProjectAssetsClient`
 * without forcing the SDK import to resolve at config:setup time (which
 * matters in dry-run + in environments where the SDK install is slow).
 */
function createClientLazy(
  projectId: string,
  userCredentials: unknown,
): import("./uploader.js").ProjectAssetsClient {
  let real:
    | {
        projectAssets: { put: (...args: unknown[]) => Promise<unknown> };
        topAssets?: { putMany?: (...args: unknown[]) => Promise<unknown> };
      }
    | null = null;
  const get = async () => {
    if (real) return real;
    // The SDK is an optional peer dependency — type-resolved at the
    // consumer's install time, not ours. Using a variable specifier
    // keeps tsc from trying to resolve "@run402/sdk/node" against THIS
    // workspace's node_modules (which is sandbox-date-locked and can't
    // pull the v1.49-aware SDK).
    const sdkModuleId = "@run402/sdk/node";
    const sdk = (await import(/* @vite-ignore */ sdkModuleId)) as {
      run402?: (opts?: { credentials?: unknown }) => {
        project?: (id: string) => Promise<unknown>;
        assets?: { putMany?: (...args: unknown[]) => Promise<unknown> };
      };
      githubActionsCredentials?: (opts: { projectId: string }) => unknown;
    };
    const factory = sdk.run402;
    if (typeof factory !== "function") {
      throw new Error(
        "@run402/sdk/node does not export run402() — is the SDK installed and up to date?",
      );
    }

    // Resolve credentials per the documented order above.
    let credentials = userCredentials;
    if (credentials === undefined && process.env.GITHUB_ACTIONS === "true") {
      if (typeof sdk.githubActionsCredentials !== "function") {
        throw new Error(
          "@run402/sdk/node does not export githubActionsCredentials() — bump @run402/sdk to a version with GitHub Actions OIDC support (≥2.2).",
        );
      }
      credentials = sdk.githubActionsCredentials({ projectId });
      // Visible at the start of every CI run — lets operators verify the
      // OIDC path is being taken rather than the laptop-keystore path.
      process.stderr.write(
        `[run402-astro] GitHub Actions detected — using OIDC credentials for project ${projectId}\n`,
      );
    }

    const r =
      credentials !== undefined ? factory({ credentials }) : factory();
    const projectAccessor = (r as { project?: (id: string) => Promise<unknown> }).project;
    if (typeof projectAccessor !== "function") {
      throw new Error("@run402/sdk/node client missing `.project()` — bump @run402/sdk to ^2.3");
    }
    const project = (await projectAccessor.call(r, projectId)) as {
      assets: { put: (...args: unknown[]) => Promise<unknown> };
    };
    // v0.2.2: also keep a reference to the TOP-LEVEL r.assets — that's
    // where putMany lives (per `@run402/sdk/node` v2.3+; project-scoped
    // assets only exposes `put`). Used by the uploader's batched path
    // when `projectId` is supplied in UploaderOptions.
    const topAssets = (r as { assets?: { putMany?: (...args: unknown[]) => Promise<unknown> } }).assets;
    real = { projectAssets: project.assets, topAssets };
    return real;
  };
  return {
    assets: {
      put: (async (...args: unknown[]) => {
        const client = await get();
        return client.projectAssets.put(...args);
      }) as unknown as import("./uploader.js").ProjectAssetsClient["assets"]["put"],
      putMany: (async (...args: unknown[]) => {
        const client = await get();
        if (typeof client.topAssets?.putMany !== "function") {
          throw new Error(
            "@run402/sdk/node client missing `assets.putMany` — bump @run402/sdk to ^2.3 for batched uploads.",
          );
        }
        return client.topAssets.putMany(...args);
      }) as unknown as NonNullable<import("./uploader.js").ProjectAssetsClient["assets"]["putMany"]>,
    },
  };
}

function configRootToPath(root: URL | string | undefined): string {
  if (!root) return process.cwd();
  if (typeof root === "string") return root;
  if (root instanceof URL) return root.pathname;
  return String(root);
}

// <Image> is intentionally NOT re-exported from this module.
//
// We tried in v0.1.2 (kychee-com/run402-private#399):
//
//     export { default as Image } from "./Image.astro";
//
// That broke the entire package (kychee-com/run402-private#400). The
// Astro CLI loads `astro.config.mjs` via Node's ESM loader BEFORE Vite
// is alive. The user's config does `import { run402 } from
// '@run402/astro'`. Node evaluates this module top-to-bottom, hits the
// `export ... from "./Image.astro"` statement, has no loader for the
// `.astro` extension, and dies. Vite's `noExternal` / Astro's compiler
// plugin can't help because they aren't reachable yet — the config
// itself hasn't loaded.
//
// The correct boundary: the integration entry point (this file) must
// stay pure-JS so Node can evaluate it at config-load time. The Astro
// component is reached only after Vite is up, via the subpath import:
//
//     import Image from '@run402/astro/Image.astro';
//
// That subpath is declared in the package's `exports` map and resolved
// by Vite/Astro's plugin pipeline. `.astro` files have a single default
// export, so the `import Image` (default) form is the only correct
// shape regardless.
//
// If a future v0.2 pivots to the import-based pattern
// (`import hero from './hero.jpg'`), the integration entry point STILL
// stays pure-JS — the Vite plugin claims image imports in `load`,
// which is also after Vite is alive. The config-load constraint
// applies to anything imported from `'@run402/astro'`.

// Type re-exports for consumers.
export type { AssetRef, AssetVariant, ImageProps, Run402AstroOptions } from "./types.js";
