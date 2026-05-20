/**
 * Shared types for `@run402/astro`.
 *
 * Mirrors the v1.49 AssetRef shape so the package doesn't have to deep-import
 * SDK internals (the SDK doesn't currently export `AssetRef` from `./node`,
 * only via `./` — but we want to stay self-contained so the package still
 * type-checks if the SDK refactors its public surface).
 *
 * Keep this file in lockstep with the v1.49 `internal.blob_image_variants`
 * shape and `services/asset-slice.ts` `ResolvedAssetRef`.
 */

/** A single pre-encoded variant entry returned by the gateway. */
export interface AssetVariant {
  url: string;
  cdn_url: string;
  width_px: number;
  height_px: number;
  format: "webp" | "jpeg";
  sha256: string;
}

/** The full v1.49 AssetRef including image-intrinsic fields. */
export interface AssetRef {
  key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  url: string;
  immutable_url?: string | undefined;
  cdn_url: string;
  cdn_immutable_url?: string | undefined;
  etag?: string | undefined;
  sri?: string | undefined;

  // v1.49 image-intrinsic fields (undefined for non-images / sub-320 / decode-failed)
  width_px?: number | undefined;
  height_px?: number | undefined;
  blurhash?: string | undefined;
  variant_spec_version?: string | undefined;
  display_url?: string | undefined;
  display_immutable_url?: string | undefined;
  variants?:
    | {
        thumb?: AssetVariant;
        medium?: AssetVariant;
        large?: AssetVariant;
        display_jpeg?: AssetVariant;
      }
    | undefined;
}

/** Options accepted by the `run402()` integration factory. */
export interface Run402AstroOptions {
  /** Run402 project ID. Defaults to `process.env.RUN402_PROJECT_ID`. */
  projectId?: string;
  /** Key prefix under which uploaded images are stored. Default: `"astro/"`. */
  assetPrefix?: string;
  /**
   * When true, the integration walks `<Image>` references and logs them but
   * skips all uploads and cache writes. Useful for previewing the upload set
   * before committing.
   */
  dryRun?: boolean;
  /**
   * When true, prints the resolved AssetRef summary per image to stderr.
   * Same effect as setting `RUN402_ASTRO_VERBOSE=true` in the environment.
   */
  verbose?: boolean;
  /**
   * Override the SDK's credential resolution. Pass a value compatible
   * with `@run402/sdk/node`'s `run402({ credentials })` option (typically
   * the result of one of the SDK's credential factories like
   * `githubActionsCredentials({ projectId })`).
   *
   * In v0.1.5+ the integration AUTO-DETECTS `GITHUB_ACTIONS=true` and
   * uses `githubActionsCredentials({ projectId })` so most users never
   * need to set this option. The escape hatch is here for power users
   * running in non-GitHub CI environments, with custom credential
   * providers (vault-backed, mTLS), or with test fixtures that need to
   * inject a stub client.
   *
   * Local (no `GITHUB_ACTIONS`) without this option set: the SDK falls
   * back to its own `NodeCredentialsProvider`, which reads the
   * developer's `~/.config/run402/projects.json` keystore.
   */
  credentials?: unknown;
}

/** Props accepted by the `<Image>` component. */
export interface ImageProps {
  /** Path to the source image, relative to the importing file. */
  src: string;
  /** Required alt text. */
  alt: string;
  /** Browser-side sizes attribute. Default: `"100vw"`. */
  sizes?: string;
  /** Above-the-fold opt-in: emits `loading="eager"` + `fetchpriority="high"`. */
  priority?: boolean;
  /** Override the default `loading="lazy"`. Ignored when `priority` is set. */
  loading?: "lazy" | "eager";
  /** Manual width override. Recomputes height preserving aspect ratio. */
  width?: number;
  /** Manual height override. Recomputes width preserving aspect ratio. */
  height?: number;
  /** Passthrough to the rendered `<img>`. */
  class?: string;
  /** LQIP placeholder strategy. Default: `"blurhash"`. */
  placeholder?: "blurhash" | "color" | "none";
}

/** Build-cache entry shape for `node_modules/.run402/assetMap.json`. */
export interface CacheEntry {
  sha256: string;
  assetRef: AssetRef;
  cachedAt: number;
}

/** Shape of the on-disk cache file. */
export interface CacheFile {
  /** Cache schema version — bump on incompatible AssetRef shape change. */
  version: 1;
  entries: { [absolutePath: string]: CacheEntry };
}

/** Image extensions accepted by the integration. */
export const SUPPORTED_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
] as const;

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

/** v1.49's fixed variant widths. */
export const VARIANT_WIDTHS = {
  thumb: 320,
  medium: 800,
  large: 1920,
} as const;
