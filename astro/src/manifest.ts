/**
 * `@run402/astro/manifest` — runtime helpers for data-driven consumers.
 *
 * The static `<Image>` component handles images whose `src` is a
 * compile-time string literal — great for hero sections in `.astro`
 * templates. But the much larger class of Astro consumers stores image
 * URLs in a CMS, a database, JSON content, or a typed seed file, and
 * renders `<img>` from runtime values. None of those references show up
 * in the build-time scan; v0.1.x couldn't help them at all.
 *
 * v0.2 adds the `assetsDir` integration option, which walks a directory
 * of source images at build time, uploads each via `r.assets.put`, and
 * emits a manifest JSON to `dist/_assets-manifest.json` (or a custom
 * path). This module provides the runtime helpers that consumers use to
 * query the manifest and emit CLS-safe `<picture>` markup that matches
 * what the static `<Image>` component produces.
 *
 * Both static `<Image>` users and runtime-manifest users hit the same
 * upload pipeline, the same v1.49 variants, the same CDN — they just
 * differ in WHERE the image references live.
 *
 * Closes kychee-com/run402-private#406.
 */

import { buildPictureHtml } from "./picture-builder.js";
import type { AssetRef, ImageProps } from "./types.js";

/**
 * Shape of the JSON manifest emitted to `dist/_assets-manifest.json`
 * (or the configured `manifestPath`). Keyed by the asset's path
 * relative to the configured `assetsDir`.
 */
export interface AssetManifest {
  /** Schema version. Bumped on incompatible shape changes. */
  version: 1;
  /** Run402 project ID this manifest was emitted for. */
  project_id: string;
  /** The asset prefix used when uploading (key under blobs). */
  asset_prefix: string;
  /** ISO 8601 timestamp of when the manifest was written. */
  generated_at: string;
  /**
   * Map from relative-to-assetsDir path → full AssetRef. The AssetRef
   * carries the same v1.49 fields the SDK returns from `assets.put`:
   * `cdn_url`, `width_px`, `height_px`, `blurhash`, `variants`, etc.
   */
  assets: { [key: string]: AssetRef };
}

/**
 * Look up an AssetRef in the manifest by key.
 *
 * Returns `null` for unknown keys — useful for admin-edited /
 * post-deploy references where the manifest hasn't been regenerated
 * yet. Callers should fall back to a plain `<img>` for null results.
 *
 * Key matching is exact. If the consumer's runtime URL is
 * `/assets/hero.jpg` and the assetsDir was `demo/eagles/assets`, the
 * caller strips the `/assets/` prefix before calling: pass `hero.jpg`.
 */
export function resolveVariants(
  manifest: AssetManifest,
  key: string,
): AssetRef | null {
  if (!manifest || typeof manifest !== "object") return null;
  if (manifest.version !== 1) return null;
  return manifest.assets[key] ?? null;
}

/** Options accepted by `renderPicture`. Subset of ImageProps that makes sense at runtime. */
export interface RenderPictureOptions {
  /** Required alt text. */
  alt: string;
  /** Browser-side sizes attribute. Default: `"100vw"`. */
  sizes?: string;
  /** Above-the-fold opt-in: `loading="eager"` + `fetchpriority="high"`. */
  priority?: boolean;
  /** Override default `loading="lazy"`. Ignored when `priority` is set. */
  loading?: "lazy" | "eager";
  /** Manual width override; height auto-recomputed. */
  width?: number;
  /** Manual height override; width auto-recomputed. */
  height?: number;
  /** Passthrough class for the rendered `<img>`. */
  class?: string;
  /** LQIP placeholder strategy. Default: `"blurhash"`. */
  placeholder?: "blurhash" | "color" | "none";
  /**
   * Extra attributes spliced onto the outer wrapper element (`<picture>`,
   * or the fallback `<img>` when the source has no variants). Useful for
   * app-specific hooks the integration doesn't model: `data-*`
   * instrumentation, custom `id`, `role`, etc. Keys must match
   * `[a-zA-Z][a-zA-Z0-9-]*`; invalid keys are dropped. Values are
   * HTML-attribute-escaped.
   */
  pictureAttrs?: Record<string, string>;
}

/**
 * Emit the same `<picture>` HTML the static `<Image>` component
 * produces, given an AssetRef and runtime options. Intended for
 * consumers that render image markup from string templates
 * (`blocks.ts:renderHeroBlock`, CMS HTML emitters, etc.).
 *
 * The output is a single string — no Astro / Vite / Node dependencies
 * at runtime. Safe to import from any JS / TS module, including
 * SSR-only paths, server middleware, or static-site generators that
 * post-process HTML.
 *
 * For HEIC sources, the `<img>` fallback automatically uses
 * `variants.display_jpeg`. For sub-320 sources (no `variants`),
 * emits a single `<img>` element with `display_url`. Same behavior
 * matrix as the `<Image>` component.
 *
 * @example
 * ```ts
 * import { resolveVariants, renderPicture } from '@run402/astro/manifest';
 * import manifest from '../dist/_assets-manifest.json';
 *
 * function heroImageHtml(url: string, alt: string): string {
 *   const key = url.replace(/^\/assets\//, '');
 *   const ref = resolveVariants(manifest, key);
 *   if (!ref) return `<img src="${escAttr(url)}" alt="${escAttr(alt)}">`;
 *   return renderPicture(ref, { alt, sizes: '100vw', priority: true });
 * }
 * ```
 */
export function renderPicture(ref: AssetRef, options: RenderPictureOptions): string {
  // Render-time path: same logic as the .astro component's
  // buildPictureHtml, but takes runtime options instead of ImageProps
  // (which include `src`). We re-route through buildPictureHtml by
  // synthesizing the missing `src` field — it isn't used in the
  // output, only in warning messages.
  const props: ImageProps = {
    src: "(manifest)",
    alt: options.alt,
    ...(options.sizes !== undefined && { sizes: options.sizes }),
    ...(options.priority !== undefined && { priority: options.priority }),
    ...(options.loading !== undefined && { loading: options.loading }),
    ...(options.width !== undefined && { width: options.width }),
    ...(options.height !== undefined && { height: options.height }),
    ...(options.class !== undefined && { class: options.class }),
    ...(options.placeholder !== undefined && { placeholder: options.placeholder }),
    ...(options.pictureAttrs !== undefined && { pictureAttrs: options.pictureAttrs }),
  };
  return buildPictureHtml({ ref, props }).html;
}
