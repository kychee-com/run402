/**
 * `@run402/astro` — Astro integration for Run402 image variants.
 *
 * Exports:
 *   - `run402(options?)` — the Astro integration factory. Add to
 *     `astro.config.mjs` `integrations: [run402()]`.
 *   - `Image` — re-export of the `.astro` component file. Users import it
 *     via `import { Image } from '@run402/astro'` and use it directly in
 *     templates.
 *   - Types: `Run402AstroOptions`, `ImageProps`, `AssetRef`, `AssetVariant`.
 *
 * The integration is intentionally small. The real work lives in the Vite
 * plugin (image discovery, upload, source rewriting, public/ exclusion);
 * this module just wires the plugin into Astro's lifecycle and validates
 * configuration up front.
 */

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
        };

        // Lazily initialize the SDK client at the moment we know we need it.
        // The client is real network I/O — we don't want to construct it
        // during config:setup if the user is in dry-run mode.
        if (!dryRun && projectId) {
          state.client = createClientLazy(projectId);
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
 * Using a Proxy lets us keep `state.client` typed as `ProjectAssetsClient`
 * without forcing the SDK import to resolve at config:setup time (which
 * matters in dry-run + in environments where the SDK install is slow).
 */
function createClientLazy(projectId: string): import("./uploader.js").ProjectAssetsClient {
  let real: { assets: { put: (...args: unknown[]) => Promise<unknown> } } | null = null;
  const get = async () => {
    if (real) return real;
    // The SDK is an optional peer dependency — type-resolved at the
    // consumer's install time, not ours. Using a variable specifier
    // keeps tsc from trying to resolve "@run402/sdk/node" against THIS
    // workspace's node_modules (which is sandbox-date-locked and can't
    // pull the v1.49-aware SDK).
    const sdkModuleId = "@run402/sdk/node";
    const sdk = (await import(/* @vite-ignore */ sdkModuleId)) as {
      run402?: (opts?: unknown) => unknown;
    };
    const factory = sdk.run402;
    if (typeof factory !== "function") {
      throw new Error(
        "@run402/sdk/node does not export run402() — is the SDK installed and up to date?",
      );
    }
    const r = factory();
    const projectAccessor = (r as { project?: (id: string) => Promise<unknown> }).project;
    if (typeof projectAccessor !== "function") {
      throw new Error("@run402/sdk/node client missing `.project()` — bump @run402/sdk to ^2.3");
    }
    const project = (await projectAccessor.call(r, projectId)) as {
      assets: { put: (...args: unknown[]) => Promise<unknown> };
    };
    real = project;
    return project;
  };
  return {
    assets: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      put: (async (...args: unknown[]) => {
        const client = await get();
        return client.assets.put(...args);
      }) as unknown as import("./uploader.js").ProjectAssetsClient["assets"]["put"],
    },
  };
}

function configRootToPath(root: URL | string | undefined): string {
  if (!root) return process.cwd();
  if (typeof root === "string") return root;
  if (root instanceof URL) return root.pathname;
  return String(root);
}

// Type re-exports for consumers.
export type { AssetRef, AssetVariant, ImageProps, Run402AstroOptions } from "./types.js";
