/**
 * Shared types for `@run402/astro`.
 *
 * Mirrors the current AssetRef shape (v1.49 base + v1.50 metadata/EXIF +
 * v1.54 shape-contract fields) so the package doesn't have to deep-import
 * SDK internals (the SDK doesn't currently export `AssetRef` from `./node`,
 * only via `./` — but we want to stay self-contained so the package still
 * type-checks if the SDK refactors its public surface).
 *
 * **Lockstep + cache discipline:** keep this file in lockstep with the
 * gateway's `services/asset-slice.ts` `ResolvedAssetRef` shape. When you
 * add a field here, ALSO bump `CACHE_SCHEMA_VERSION` in `./cache.ts` —
 * the build cache stores AssetRefs verbatim by source SHA, so a forgotten
 * version bump means stale builds silently drop the new field (see the
 * cache.ts header for the full story).
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

/**
 * The full AssetRef returned by `r.assets.put` and stored verbatim in the
 * build cache + emitted into `dist/_assets-manifest.json`.
 *
 * Field generations:
 *   - core (v1.45): `key`, `sha256`, `size_bytes`, `content_type`, `url`,
 *     `cdn_url`, plus `immutable_url`, `cdn_immutable_url`, `etag`, `sri`.
 *   - v1.49 image-intrinsic: `width_px`, `height_px`, `blurhash`,
 *     `variant_spec_version`, `display_url`, `display_immutable_url`,
 *     `variants`.
 *   - v1.50 metadata + EXIF: `metadata`, `image_format`, `image_info`,
 *     `image_exif`, `image_exif_policy` — `null` on non-image uploads
 *     (the wire shape is widen-to-null, not omit), `null` for fields the
 *     pipeline couldn't compute.
 *   - v1.54 shape contract: `blurhash_data_url`, `asset_schema` — omitted
 *     entirely (not `null`) on pre-v1.54 uploads; the omit pattern is what
 *     `<Run402Image>` strict-mode keys off to skip legacy rows.
 *
 * Adding a field here? Bump `CACHE_SCHEMA_VERSION` in `./cache.ts`.
 */
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

  // v1.50 metadata + EXIF policy + image intrinsics. Wire shape is
  // widen-to-null on non-image uploads (NOT omit) — keeps the JSON inventory
  // wire-shape stable.
  metadata?: AssetMetadata | null;
  image_format?: string | null;
  image_info?: Record<string, unknown> | null;
  image_exif?: Record<string, unknown> | null;
  image_exif_policy?: ExifPolicy | null;

  // v1.54 shape-contract fields (omitted entirely — NOT null — on pre-v1.54
  // uploads). Surfaced so `<Run402Image>` placeholder rendering +
  // schema-filtered strict-mode work without a DB roundtrip.
  blurhash_data_url?: string | null;
  asset_schema?: "v1.49" | "v1.50" | "v1.54" | null;
}

/** Caller-supplied metadata block. ≤4 KB serialized; leaf values may be
 *  `string | number | boolean | string[]`. The gateway echoes this back
 *  verbatim on AssetRef. */
export type AssetMetadata = Record<string, string | number | boolean | string[]>;

/** EXIF retention policy applied to an image upload. `"strip"` removes
 *  the EXIF block at upload time; `"preserve"` keeps it; `"redact"` keeps
 *  the structural keys but blanks GPS / serial-number / lens-info fields. */
export type ExifPolicy = "strip" | "preserve" | "redact";

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
  /**
   * v0.2+: build-time directory uploader for data-driven consumers (CMS,
   * DB-backed sites, typed seed files). When set, the integration walks
   * the given directory (or directories) at `buildStart`, uploads every
   * image file via `r.assets.put`, and emits a manifest JSON that
   * runtime renderers can query by key.
   *
   * Pass a single absolute or project-root-relative path, or an array
   * for multiple sources:
   *
   *     assetsDir: 'demo/eagles/assets'
   *     assetsDir: ['demo/eagles/assets', 'src/cms-images']
   *
   * Files are walked recursively. The manifest key for each file is its
   * path relative to the assetsDir (e.g., 'demo/eagles/assets/hero.jpg'
   * → key 'hero.jpg'; nested 'avatars/01.jpg' → key 'avatars/01.jpg').
   *
   * The static-template `<Image>` scan continues to run alongside this;
   * both feed the same upload batch + the same registry. CAS dedup at the
   * gateway means an image referenced via BOTH paths uploads once.
   */
  assetsDir?: string | string[];
  /**
   * Where to emit the asset manifest JSON. Default:
   * `'dist/_assets-manifest.json'`. The path is resolved relative to
   * the project root.
   *
   * The manifest is written at `closeBundle` time, after Astro has
   * finished writing its own `dist/` output. Format: see
   * `@run402/astro/manifest` for the typed reader + the file shape.
   *
   * Only emitted when `assetsDir` is set. Static-`<Image>`-only
   * consumers don't need the manifest because their references are
   * resolved at build time via the source-rewrite + virtual-module
   * registry path.
   */
  manifestPath?: string;
  /**
   * File extensions accepted when walking `assetsDir`. Default:
   * `['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif']`
   * (the same set v1.49's encoder supports). Non-image extensions in
   * the directory are silently skipped.
   *
   * Case-insensitive; specify with the leading dot.
   */
  assetExtensions?: string[];
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
  /**
   * Extra attributes spliced onto the outer wrapper element (`<picture>`,
   * or the fallback `<img>` when no variants exist). Useful for app-specific
   * hooks the integration doesn't model: `data-*` instrumentation, custom
   * `id`, `role`, etc. Keys must match `[a-zA-Z][a-zA-Z0-9-]*`; invalid
   * keys are dropped. Values are HTML-attribute-escaped.
   */
  pictureAttrs?: Record<string, string>;
}

/** Build-cache entry shape for `node_modules/.run402/assetMap.json`. */
export interface CacheEntry {
  sha256: string;
  assetRef: AssetRef;
  cachedAt: number;
}

/** Shape of the on-disk cache file. */
export interface CacheFile {
  /** Cache schema version. Bump in lockstep with `CACHE_SCHEMA_VERSION` in
   *  `./cache.ts` whenever `AssetRef` gains a field — see that file's header
   *  for the full discipline. v1 → v2 bump: v1.50 + v1.54 AssetRef fields. */
  version: 2;
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
