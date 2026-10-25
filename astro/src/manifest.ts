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
 * upload pipeline, the same variants, the same CDN — they just
 * differ in WHERE the image references live.
 */

import { buildPictureHtml } from "./picture-builder.js";
import type { AssetRef, AssetVariant, ImageProps } from "./types.js";

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
  /**
   * ISO 8601 build timestamp. Deterministic: `SOURCE_DATE_EPOCH` when set,
   * otherwise the Unix epoch (`1970-01-01T00:00:00.000Z`) — never the wall
   * clock, because the manifest is baked into the SSR bundle and a
   * changing timestamp would redeploy the SSR function on every build.
   */
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

/** The encoded variants of a stored image, as `AssetRef.variants` names them. */
export type AssetVariantKind = "thumb" | "medium" | "large" | "display_jpeg";

/** One URL a signer mints: the original of `key`, or one encoded variant. */
export interface AssetSignRequestItem {
  key: string;
  variant?: AssetVariantKind;
}

/** A signer's answer to one item: `signed_url`, or `error` when the
 *  project has no such key or variant. */
export interface AssetSignAnswer {
  signed_url?: string | undefined;
  error?: { code: string; message: string } | undefined;
}

/**
 * Mints signed GET URLs for many items in one request and answers them in
 * order. `assets.signMany` from `@run402/functions` is one as it stands;
 * outside a function, `(items) => r.assets.signMany(projectId, items)` from
 * `@run402/sdk`.
 */
export type AssetBatchSigner = (items: AssetSignRequestItem[]) => Promise<{ items: readonly AssetSignAnswer[] }>;

/** An encoded variant whose URLs may be `null`, as they are for a private key. */
export type SignableAssetVariant = Omit<AssetVariant, "url" | "cdn_url"> & {
  url?: string | null;
  cdn_url?: string | null;
};

/** A stored `AssetRef` whose URL fields may be `null`, as they are for a
 *  private key. Only `key`, the image intrinsics and the variant set are read. */
export type SignableAssetRef = Omit<AssetRef, "url" | "cdn_url" | "display_url" | "variants"> & {
  url?: string | null;
  cdn_url?: string | null;
  display_url?: string | null;
  variants?: Partial<Record<AssetVariantKind, SignableAssetVariant>> | undefined;
};

/** Most items one signer call carries: the sign route's own limit. */
const SIGN_BATCH_MAX_ITEMS = 1000;

const SIGNABLE_KINDS = ["thumb", "medium", "large", "display_jpeg"] as const;

/**
 * Fill a private `AssetRef`'s URL fields with signed URLs, so `renderPicture`,
 * `<Run402Picture>` and `<Run402Image>` render it exactly as they render a
 * public one. The original and every encoded variant are signed in ONE
 * `signMany` call; `url` / `cdn_url` become the original's signed URL,
 * `display_url` the HEIC `display_jpeg`'s (else the original's), and each
 * `variants.<kind>.url` / `.cdn_url` its own signed URL. Immutable URLs stay
 * absent: a signed URL expires. Throws when the signer could not sign one of
 * them. For a page of images use `signAssetRefs`, one request for all.
 *
 * The page that renders the result carries short-lived URLs, so render it per
 * request (a members-only page already is: reading the session taints the ISR
 * cache) and sign with a TTL longer than a visit.
 *
 * @example
 * ```astro
 * ---
 * import { assets } from "@run402/functions";
 * import { signAssetRef } from "@run402/astro/manifest";
 * import { Run402Picture } from "@run402/astro/components";
 * const photo = await signAssetRef(row.photo, assets.signMany);
 * ---
 * <Run402Picture asset={photo} alt={row.caption} />
 * ```
 */
export async function signAssetRef(ref: SignableAssetRef, signMany: AssetBatchSigner): Promise<AssetRef> {
  return (await signAssetRefs([ref], signMany))[0]!;
}

/**
 * `signAssetRef` for many refs at once: every original and variant of every
 * ref goes into one `signMany` call (more only past 1000 URLs), so a page of
 * private photos costs one round trip. Returns the signed refs in order.
 * Throws naming the first item the signer could not sign.
 *
 * @example
 * ```astro
 * ---
 * const photos = await signAssetRefs(rows.map((r) => r.photo), (items) =>
 *   assets.signMany(items, { ttl_seconds: 3600 }));
 * ---
 * {photos.map((p, i) => <Run402Picture asset={p} alt={rows[i].caption} />)}
 * ```
 */
export async function signAssetRefs(refs: readonly SignableAssetRef[], signMany: AssetBatchSigner): Promise<AssetRef[]> {
  const plans = refs.map((ref) => {
    if (!ref || typeof ref !== "object" || typeof ref.key !== "string" || ref.key === "") {
      throw new Error("signAssetRef: ref must be an AssetRef with a key");
    }
    return { ref, kinds: SIGNABLE_KINDS.filter((k) => ref.variants?.[k]) };
  });
  const items: AssetSignRequestItem[] = plans.flatMap(({ ref, kinds }) => [
    { key: ref.key },
    ...kinds.map((variant) => ({ key: ref.key, variant })),
  ]);
  const chunks: AssetSignRequestItem[][] = [];
  for (let i = 0; i < items.length; i += SIGN_BATCH_MAX_ITEMS) chunks.push(items.slice(i, i + SIGN_BATCH_MAX_ITEMS));
  const answers = (await Promise.all(chunks.map(async (chunk) => {
    const result = await signMany(chunk);
    if (!result || !Array.isArray(result.items) || result.items.length !== chunk.length) {
      throw new Error(`signAssetRef: the signer answered ${result?.items?.length ?? 0} items for ${chunk.length}`);
    }
    return result.items;
  }))).flat();
  const urls = answers.map((answer, i) => {
    if (typeof answer.signed_url === "string") return answer.signed_url;
    const item = items[i]!;
    const why = answer.error ? `${answer.error.code}: ${answer.error.message}` : "no signed_url";
    throw new Error(`signAssetRef: could not sign ${item.key}${item.variant ? ` (${item.variant})` : ""}: ${why}`);
  });
  let next = 0;
  return plans.map(({ ref, kinds }) => {
    const original = urls[next++]!;
    const variants: NonNullable<AssetRef["variants"]> = {};
    for (const kind of kinds) {
      const url = urls[next++]!;
      variants[kind] = { ...ref.variants![kind]!, url, cdn_url: url };
    }
    const { immutable_url: _i, cdn_immutable_url: _ci, display_immutable_url: _di, ...rest } = ref;
    return {
      ...rest,
      url: original,
      cdn_url: original,
      display_url: variants.display_jpeg?.cdn_url ?? original,
      ...(kinds.length > 0 ? { variants } : {}),
    } as AssetRef;
  });
}
