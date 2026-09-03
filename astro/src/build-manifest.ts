/**
 * `@run402/astro/build-manifest` — build-time access to the asset manifest.
 *
 * The integration writes `dist/_assets-manifest.json` at `closeBundle`,
 * which is AFTER Astro renders pages. Consumers that need the manifest
 * during page-render — to bake section content from a typed seed module,
 * to emit `<picture>` markup directly into static HTML for first-paint,
 * etc. — can't read the file from disk in `.astro` frontmatter because
 * it doesn't exist yet.
 *
 * `getBuildTimeManifest()` returns the same shape the file will hold,
 * sourced from the integration's `virtual:run402-assetmap` virtual
 * module. Safe to call from any `.astro` page's frontmatter or any
 * module imported transitively by an Astro page at build time.
 *
 * **Do NOT import this from `astro.config.mjs`.** The module imports
 * from a Vite virtual module that only exists after Vite is alive;
 * Astro CLI loads `astro.config.mjs` via vanilla Node before Vite
 * starts. Importing this module from the config file dies with "Unknown
 * file extension" or similar. Pages and lib modules used by pages are
 * fine.
 */

import type { AssetManifest } from "./manifest.js";
import {
  resolveManifestWithOptions,
  type GetBuildTimeManifestOptions,
} from "./build-manifest-resolver.js";

// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./virtual-modules.d.ts" />
import { manifest as virtualManifest } from "virtual:run402-assetmap";

export type { GetBuildTimeManifestOptions } from "./build-manifest-resolver.js";

/**
 * Return the build-time AssetManifest, or `null` if the integration
 * had no `assetsDir` configured (no manifest keys to emit).
 *
 * Distinct return values:
 *   - `null` — integration is not in data-driven mode (no `assetsDir`).
 *     Build-time-bake consumers should fall back to plain `<img>` or
 *     skip the bake entirely; no manifest means no variants are ready.
 *   - Empty `assets` — `assetsDir` is set but the walk found no files
 *     (typo in path, all files have unsupported extensions, dev build
 *     without the integration running fully). Rare; surface a warning
 *     if your build-time bake hits this case.
 *   - Populated `assets` — production case. Keys are paths relative to
 *     the configured `assetsDir`; values are the full AssetRef (cdn_url,
 *     width_px, height_px, blurhash, variants, etc.).
 *
 * Use with `resolveVariants` from `@run402/astro/manifest`:
 *
 * ```ts
 * // src/lib/your-bake.ts
 * import { getBuildTimeManifest } from '@run402/astro/build-manifest';
 * import { resolveVariants, renderPicture } from '@run402/astro/manifest';
 *
 * const manifest = getBuildTimeManifest();
 *
 * export function renderSeedSection(section) {
 *   if (!manifest) return `<img src="${section.image_url}" alt="...">`;
 *   const key = section.image_url.replace(/^\\/assets\\//, '');
 *   const ref = resolveVariants(manifest, key);
 *   return ref
 *     ? renderPicture(ref, { alt: section.image_alt, sizes: '100vw' })
 *     : `<img src="${section.image_url}" alt="${section.image_alt}">`;
 * }
 * ```
 */
export function getBuildTimeManifest(
  options: GetBuildTimeManifestOptions = {},
): AssetManifest | null {
  return resolveManifestWithOptions(virtualManifest as AssetManifest | null, options);
}
