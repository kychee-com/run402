/**
 * Request and response types for the `blobs` namespace.
 *
 * Covers the direct-to-S3 blob storage API: `PUT /storage/v1/uploads` +
 * multipart S3 uploads, `GET /storage/v1/blob/:key`, `GET /storage/v1/blobs`,
 * `DELETE /storage/v1/blob/:key`, `POST /storage/v1/blob/:key/sign`.
 */

export type BlobVisibility = "public" | "private";

/**
 * v1.50: caller-provided asset metadata. Flat, scalar-or-string-array leaves
 * only; total serialized size ≤ 4 KB. Nested objects / unknown leaf shapes are
 * rejected client-side with `INVALID_ASSET_METADATA` before any HTTP call.
 */
export type AssetMetadataValue = string | number | boolean | string[];
export type AssetMetadata = Record<string, AssetMetadataValue>;

/**
 * v1.50: EXIF retention policy applied to image uploads. `"keep"` preserves
 * caller-supplied EXIF (default; same as historical behavior); `"strip"`
 * directs the gateway to discard EXIF from the stored bytes and the
 * `image_exif` field returned by `assets.ls` / `assets.put`.
 */
export type ExifPolicy = "keep" | "strip";

/**
 * v1.50: extracted intrinsic image format. `null` for non-image uploads. The
 * gateway populates this only when the source MIME (or sniffed signature)
 * matches a known image codec. Unknown formats fail the upload with HTTP 422
 * `IMAGE_DECODE_FAILED` (no partial row is written).
 */
export type AssetImageFormat =
  | "jpeg"
  | "png"
  | "webp"
  | "avif"
  | "heic"
  | "tiff"
  | "svg"
  | "bmp";

/**
 * Source for an upload.
 *
 * Polymorphic — pass any of:
 *   - a bare `string` (UTF-8) — shorthand for `{ content: <string> }`
 *   - a bare `Uint8Array` — shorthand for `{ bytes: <u8> }`
 *   - `{ content: <string> }` — explicit UTF-8 form (≤ 1 MB)
 *   - `{ bytes: <u8> }` — explicit binary form (no size cap on this end)
 *
 * The shorthand forms exist because every other `ContentSource`-shaped
 * surface in the SDK accepts bare strings/Uint8Arrays — `{ content: ... }`
 * was an outlier that surprised callers (GH-126).
 */
export type BlobPutSource =
  | string
  | Uint8Array
  | { content: string; bytes?: never }
  | { bytes: Uint8Array; content?: never };

export interface BlobPutOptions {
  /** MIME type. Auto-detected from `key`'s extension when omitted. */
  contentType?: string;
  /** Default: `"public"`. Public blobs get a CDN URL; private requires auth. */
  visibility?: BlobVisibility;
  /**
   * Default (v1.45+): `true`. Returns an `AssetRef` with `cdnUrl` populated
   * and the `scriptTag()` / `linkTag()` / `imgTag()` emitters working —
   * this is the agent-DX flow (paste-and-go HTML with SRI baked in).
   *
   * Cost: `immutable` no longer controls hashing; the upload API requires
   * a SHA-256 digest for every blob. Pass `false` only when you specifically
   * don't need a content-hashed URL or SRI.
   *
   * When `false`, the returned `AssetRef` has `cdnUrl: null`, `sri: null`,
   * and the tag emitters throw with an "immutable: true required" hint.
   */
  immutable?: boolean;
  /**
   * v1.50: caller-provided metadata stored alongside the asset row. Flat
   * object with `string | number | boolean | string[]` leaves; ≤4 KB
   * serialized. Nested objects, undefined-leaf values, or non-allowed leaf
   * types are rejected client-side with `INVALID_ASSET_METADATA` before any
   * HTTP call. The same `code` is returned by the gateway if a server-side
   * check rejects a structurally valid value (HTTP 400).
   */
  metadata?: AssetMetadata;
  /**
   * v1.50: EXIF retention policy. Default `"keep"`. Invalid values are
   * rejected client-side with `INVALID_EXIF_POLICY` before any HTTP call.
   */
  exifPolicy?: ExifPolicy;
}

/** One presigned upload part returned by the Run402 blob upload session API. */
export interface BlobUploadPart {
  part_number: number;
  url: string;
  byte_start: number;
  byte_end: number;
}

/** Options for initializing a low-level resumable blob upload session. */
export interface BlobUploadInitOptions {
  key: string;
  size_bytes: number;
  content_type: string;
  visibility?: BlobVisibility;
  immutable?: boolean;
  sha256: string;
}

/** Active upload session returned by `blobs.initUploadSession(...)`. */
export interface BlobUploadInitResult {
  upload_id: string;
  mode: "single" | "multipart";
  parts: BlobUploadPart[];
  part_count: number;
  part_size_bytes?: number;
}

/** Upload-session status returned by `blobs.getUploadSession(...)`. */
export interface BlobUploadStatusResult extends Partial<BlobUploadInitResult> {
  upload_id: string;
  status: "active" | "completed" | "aborted" | "expired" | (string & {});
  key?: string;
}

/** Completed part metadata sent to the gateway when finishing a multipart upload. */
export interface BlobUploadCompletedPart {
  part_number: number;
  etag: string;
  sha256: string;
}

/** Options for completing a low-level blob upload session. */
export interface BlobUploadCompleteOptions {
  parts?: BlobUploadCompletedPart[];
}

/**
 * Cache-kind hint for a blob URL. Mirrors the gateway's
 * `X-Run402-Blob-Cache-Kind` response header. Agents key on this when
 * deciding whether they need to wait for CDN freshness after an upload.
 */
export type BlobCacheKind = "immutable" | "mutable" | "private";

/**
 * CloudFront invalidation status for a mutable URL. Returned by the gateway's
 * upload-completion response when an invalidation was triggered (e.g. a
 * re-upload to an existing public mutable key). `ready: true` is the
 * immutable-URL signal — no waiting needed.
 */
export interface BlobCdnEnvelope {
  /** Blob CDN config version. Currently `"blob-gateway-v2"`. */
  version: string;
  /** CloudFront invalidation ID for the mutable URL, when one was triggered. */
  invalidationId: string | null;
  /** Status of the invalidation at the time of the upload response. */
  invalidationStatus: "InProgress" | "Completed" | "Failed" | null;
  /** `true` for immutable URLs (always ready); omitted/false for mutable. */
  ready?: boolean;
  /** Human-readable nudge ("Use immutableUrl or call wait_for_cdn_freshness."). */
  hint: string | null;
}

/**
 * Stable URL reference returned by `client.blobs.put`.
 *
 * **The recommended agent-DX fields are `cdnUrl` + the tag emitters
 * (`scriptTag`, `linkTag`, `imgTag`).** These give you a paste-and-go HTML
 * tag with content-addressed URL + SRI + `crossorigin` already wired. No
 * decisions about mutable vs. immutable, no `wait_for_cdn_freshness` polls,
 * no manual integrity attribute construction — the URL is bound to a SHA at
 * upload time, served from `pr-<public_id>.run402.com` (the host that
 * always works through the v1.33 CDN), and never invalidated.
 *
 * The other fields are present for compatibility / advanced use:
 *   - `url` / `immutable_url` (snake_case): legacy v1.0+ fields. May be on
 *     a claimed-subdomain or custom-domain host (which is "prettier" but
 *     currently can NOT serve `/_blob/*` through the CDN — those subdomains'
 *     KVS values lack a `project_id`. Fix tracked separately).
 *   - `immutableUrl`: same value as `immutable_url`, camelCase.
 *   - `cdnMutableUrl`: mutable form of the auto-subdomain URL — useful only
 *     when you need a stable URL that always reflects the latest content.
 *     Comes with eventual-consistency caveats (CloudFront invalidation is
 *     async); prefer `cdnUrl` for generated code.
 *   - `etag`, `sri`, `contentDigest`: integrity values derived from the
 *     SHA-256.
 *   - `cdn`: CloudFront invalidation envelope.
 *
 * Tag emitters require the SHA-256 (only computed when uploaded with
 * `immutable: true`). On non-immutable uploads, calling them throws.
 */
/**
 * One image variant generated by the gateway (v1.49+) on `assets.put` for
 * image MIMEs. Three sizes are produced (`thumb` 320w, `medium` 800w,
 * `large` 1920w) plus a full-resolution `display_jpeg` for HEIC/HEIF
 * sources. WebP-only in v1; AVIF is deferred (see `imgTagWithSrcSet`'s
 * JSDoc for the `<picture>` type-precedence footgun).
 */
export interface AssetVariant {
  /** Mutable URL of the variant (preferred-host form). */
  url: string;
  /** Content-addressed CDN URL of the variant. Recommended for HTML/CSS. */
  cdn_url: string;
  /** Pixel width of the variant in display orientation. */
  width_px: number;
  /** Pixel height of the variant in display orientation. */
  height_px: number;
  /** Encoded format of the variant. */
  format: "webp" | "jpeg";
  /** Hex SHA-256 of the variant bytes. */
  sha256: string;
}

export interface AssetRef {
  // ---- v1.0+ legacy fields (back-compat) -----------------------------------
  key: string;
  size_bytes: number;
  sha256: string | null;
  visibility: BlobVisibility;
  url: string | null;
  immutable_url: string | null;
  // ---- v1.45+ agent-DX fields ---------------------------------------------
  /** Same value as `size_bytes`, camelCase form. */
  size: number;
  /** Hex SHA-256 of the bytes. Same as `sha256` (camelCase alias). */
  contentSha256: string | null;
  /** Effective Content-Type (auto-detected from the key extension when not
   *  set explicitly via `BlobPutOptions.contentType`). */
  contentType: string;
  /** Same value as `immutable_url` (preferred-host form), camelCase. */
  immutableUrl: string | null;
  /** **The recommended URL for generated HTML/CSS/JS.** Content-addressed
   *  (immutable), served from the auto-subdomain
   *  (`pr-<public_id>.run402.com/_blob/<key-with-suffix>.<ext>`) which is
   *  guaranteed to work through the v1.33 CDN path. Pair with `sri` for
   *  Subresource Integrity. Null on non-immutable uploads (the SHA isn't
   *  computed) and on private uploads. */
  cdnUrl: string | null;
  /** Mutable form of the auto-subdomain URL. Use only when a stable URL
   *  must always reflect the latest content (eventual consistency on
   *  re-upload). Prefer `cdnUrl` for generated code. */
  cdnMutableUrl: string | null;
  /** Strong ETag of the form `"sha256-<hex>"`. Null when `sha256` is null. */
  etag: string | null;
  /** Browser SRI form: `sha256-<base64>`. Use as the `integrity` attribute
   *  value in `<script>`/`<link>` tags. */
  sri: string | null;
  /** RFC 9530 `Content-Digest` value, `sha-256=:<base64>:`. */
  contentDigest: string | null;
  /** Semantic cache-kind hint matching the gateway's response header. */
  cacheKind: BlobCacheKind;
  /** CloudFront invalidation envelope. For immutable uploads `cdn.ready ===
   *  true` and no further action is needed. */
  cdn: BlobCdnEnvelope;

  // ---- v1.49+ image-variant fields ----------------------------------------
  // Present only for image MIMEs uploaded against a v1.49+ gateway.
  // All optional — undefined for non-images, sub-320 images, and pre-v1.49
  // uploads. TypeScript narrows accordingly; consumer code should null-check.

  /** Display-oriented width (post-EXIF rotation) of the source image, in
   *  pixels. Present only for image MIMEs against a v1.49+ gateway. */
  width_px?: number;
  /** Display-oriented height (post-EXIF rotation) of the source image, in
   *  pixels. Present only for image MIMEs against a v1.49+ gateway. */
  height_px?: number;
  /** Blurhash string suitable for a low-quality image placeholder (LQIP).
   *  Present only for image MIMEs against a v1.49+ gateway. */
  blurhash?: string;
  /** Variant spec version. v1 in the v1.49 gateway release. Future
   *  spec-version bumps produce different variant bytes at different URLs. */
  variant_spec_version?: string;
  /** Browser-renderable URL for the source. For jpeg/png/webp/avif this
   *  equals `cdn_url`. For HEIC/HEIF this points to a generated JPEG
   *  display variant so apps render correctly without HEIC-aware code. */
  display_url?: string;
  /** Immutable (content-addressed) form of `display_url`. */
  display_immutable_url?: string;
  /** Generated variant set for image MIMEs ≥320×320. Sub-320 images skip
   *  the WebP set (the source IS the thumbnail at that size). `display_jpeg`
   *  is present only for HEIC/HEIF sources (full-resolution JPEG transcode). */
  variants?: {
    thumb?: AssetVariant;
    medium?: AssetVariant;
    large?: AssetVariant;
    display_jpeg?: AssetVariant;
  };

  // ---- v1.49+ SDK convenience fields --------------------------------------
  // Computed during enhancement. Undefined for non-image AssetRefs so
  // TypeScript narrows correctly and a non-image ref can't accidentally be
  // rendered as a broken thumbnail or hero image.

  /** Convenience: `variants.thumb.cdn_url` if a thumb variant exists,
   *  else `display_url` (acts as the thumbnail for sub-320 images). **Undefined
   *  for non-image AssetRefs** — TypeScript narrows accordingly; see also
   *  `imgTag()`. */
  thumbUrl?: string;
  /** Convenience: `display_url` falling back to `cdn_url` for images.
   *  **Undefined for non-image AssetRefs** — TypeScript narrows accordingly;
   *  see also `imgTag()`. */
  displayUrl?: string;

  // ---- v1.45+ HTML tag emitters --------------------------------------------
  // These are inline methods (not network calls). They construct the
  // exact HTML tag an agent would otherwise have to assemble by hand.
  // Throw when `cdnUrl` is null (non-immutable upload); use `--immutable`
  // at upload time to guarantee these work.

  /**
   * Returns a ready-to-paste `<script>` tag with the content-addressed
   * URL + Subresource Integrity + `crossorigin`. The browser will refuse
   * to execute the script if the bytes don't match the SHA.
   *
   * **Defaults:** `defer: true`. Modern best practice — non-render-
   * blocking when placed in `<head>` and a no-op at end of `<body>`.
   * Pass `{ defer: false }` for the rare case requiring sync execution.
   * `async: true` overrides defer (the two are mutually exclusive).
   *
   * @example
   *   const asset = await client.blobs.put(p, "app.js", { content });
   *   html += asset.scriptTag();
   *   // → <script src="https://pr-abc.run402.com/_blob/app-3a7fc02e.js" defer integrity="sha256-…" crossorigin></script>
   *
   *   asset.scriptTag({ type: "module" });
   *   // → <script src="…" type="module" defer integrity="…" crossorigin></script>
   */
  scriptTag(opts?: { type?: "module" | "text/javascript"; defer?: boolean; async?: boolean }): string;

  /**
   * Returns a ready-to-paste `<link>` tag (default `rel="stylesheet"`)
   * with content-addressed URL + SRI + `crossorigin`. `crossorigin` is
   * always emitted — required for SRI to actually be enforced (also
   * required for rel="preload" to dedupe with the matching fetch).
   *
   * @example
   *   asset.linkTag();                            // stylesheet
   *   asset.linkTag({ rel: "preload", as: "font" });
   *   asset.linkTag({ rel: "modulepreload" });
   */
  linkTag(opts?: { rel?: string; as?: string }): string;

  /**
   * Returns a ready-to-paste `<img>` tag with the content-addressed URL.
   *
   * **Defaults:** `loading="lazy"` + `decoding="async"`. Modern best
   * practice — lazy loads below-fold images on demand, async decoding
   * moves the decode off the main thread. Both are baseline-supported
   * in all major browsers. Agents who specifically need an above-fold
   * eager image can wrap the result and override.
   *
   * Browsers don't support SRI on `<img>`, so no `integrity` attribute
   * is emitted. The URL is content-hashed so it's still stable across
   * re-deploys; for byte-level verification, read `Content-Digest`
   * server-side.
   *
   * `alt` is the image's accessibility text (default `""` for decorative
   * images). Pass a description when the image conveys information.
   *
   * @example
   *   asset.imgTag("Company logo")
   *   // → <img src="https://pr-abc.run402.com/_blob/logo-a1b2c3d4.png" alt="Company logo" loading="lazy" decoding="async">
   *
   * **v1.49+ HEIC handling:** when the source is HEIC/HEIF, the gateway sets
   * `display_url` to a generated JPEG transcode of the source and `cdn_url`
   * to the original HEIC bytes (which browsers can't render). `imgTag()`
   * defaults `<img src>` to `display_url ?? cdn_url`, so HEIC uploads render
   * correctly without HEIC-specific code in the caller. When the ref carries
   * `width_px` and `height_px`, the emitter also adds `width`/`height`
   * attributes to eliminate Cumulative Layout Shift. Non-image refs omit
   * those attributes silently — `imgTag()` never throws on absence.
   */
  imgTag(alt?: string): string;

  /**
   * Returns a `<picture>` element with a responsive WebP `<source>` (three
   * sizes: 320w / 800w / 1920w) and the gateway's `display_url` as the
   * `<img>` fallback. Designed for hero images and any layout where the
   * browser should pick the right resolution per viewport.
   *
   * **Both throw conditions fail loud — no silent fallbacks:**
   *
   * - **`opts.sizes` is required.** Without `sizes`, browsers conservatively
   *   download the largest candidate in `srcset` (defeating the variant
   *   set). The helper throws `LocalError` with a message that names the
   *   issue and gives a copy-pasteable example.
   * - **`variants` must be present.** This helper assumes the gateway
   *   generated the three WebP variants (image source ≥320×320, encoded
   *   successfully). On non-image refs, sub-320 images, or older gateway
   *   responses without variants, the helper throws `LocalError` and tells
   *   the caller to use `imgTag()` instead. Silent fallback would render a
   *   broken layout (no srcset, no responsive benefit) with no diagnostic.
   *
   * **AVIF footgun — why no `<source type="image/avif">`:** `<picture>`
   * browsers select sources by `type` precedence, not best size. A single
   * AVIF source at 1920w would be picked for thumbnails by AVIF-capable
   * browsers, defeating the variant set. AVIF support, if it returns, must
   * land at all three sizes simultaneously OR via a separate `imgTagHero()`
   * helper that opts in explicitly for above-the-fold heroes.
   *
   * @example
   *   ref.imgTagWithSrcSet({
   *     alt: "Hero",
   *     sizes: "(max-width: 800px) 100vw, 1920px",
   *   });
   *   // → <picture>
   *   //     <source type="image/webp"
   *   //             srcset="<thumb-cdn-url> 320w, <medium-cdn-url> 800w, <large-cdn-url> 1920w"
   *   //             sizes="(max-width: 800px) 100vw, 1920px">
   *   //     <img src="<display_url>"
   *   //          alt="Hero"
   *   //          width="4032" height="3024"
   *   //          loading="lazy"
   *   //          decoding="async">
   *   //   </picture>
   */
  imgTagWithSrcSet(opts: {
    alt?: string;
    /** REQUIRED. Browser `sizes` attribute (e.g. `"100vw"` or
     *  `"(max-width: 800px) 100vw, 1920px"`). Throws when missing/empty. */
    sizes: string;
    /** Default `"lazy"`. Pass `"eager"` for above-the-fold heroes. */
    loading?: "lazy" | "eager";
  }): string;

  // ---- v1.50+ metadata + EXIF policy + image intrinsics --------------------
  // Flat shape — NOT wrapped under `image: {}`. Same naming convention as the
  // v1.49 `width_px` / `height_px` / `blurhash` / `variants` additions. All
  // fields below are `null` (not undefined) for non-image uploads to keep
  // the JSON inventory wire-shape stable; only `metadata` is non-null when
  // the caller supplied one on a non-image upload.

  /** Caller-supplied flat metadata (≤4 KB serialized; leaves are
   *  `string | number | boolean | string[]`). `null` when no metadata was
   *  set on the upload. */
  metadata: AssetMetadata | null;
  /** Decoded image format (`jpeg`/`png`/`webp`/`avif`/`heic`/`tiff`/`svg`/
   *  `bmp`). `null` for non-image uploads. */
  image_format: string | null;
  /** Server-extracted intrinsic image info. Known keys: `has_alpha`,
   *  `color_space`, `animated`, `frame_count`, `bit_depth`, `orientation`.
   *  Future gateway versions may emit additional keys — treat as opaque. */
  image_info: Record<string, unknown> | null;
  /** Server-extracted EXIF block. `null` for non-image uploads, for images
   *  whose EXIF was stripped (`image_exif_policy: "strip"`), and for image
   *  formats that do not carry EXIF (e.g. SVG, BMP). */
  image_exif: Record<string, unknown> | null;
  /** Echo of the EXIF policy actually applied to the stored bytes. `null`
   *  for non-image uploads. */
  image_exif_policy: ExifPolicy | null;
}

/**
 * Return type of `client.blobs.put`. v1.45 widens this to AssetRef; the
 * legacy fields stay for back-compat.
 */
export type BlobPutResult = AssetRef;

/** Result of completing a low-level upload session. */
export type BlobUploadCompleteResult = BlobPutResult;

/** Response envelope from `client.blobs.diagnoseUrl(...)`. */
export interface BlobDiagnoseEnvelope {
  projectId: string;
  key: string;
  /** SHA the gateway DB believes is current for `(projectId, key)`. */
  expectedSha256: string | null;
  /** SHA actually returned by the probe (`X-Run402-Content-Sha256` header). */
  observedSha256: string | null;
  /** Probe vantage. The agent is told the probe is single-region. */
  vantage: "gateway-us-east-1";
  /** Probe method — `"GET_RANGE_0_0"` (NOT HEAD; HEAD can hit a different
   *  cached variant). */
  probeMethod: "GET_RANGE_0_0";
  /** Accept-Encoding used by the probe. */
  acceptEncoding: string;
  /** ISO timestamp of the probe. */
  observedAt: string;
  /** Always `true` — the probe itself populates the cache, so subsequent
   *  reads may differ. Agents are told this explicitly. */
  probeMayHaveWarmedCache: true;
  /** The URL the probe actually fetched (after URL normalization). */
  canonicalUrl: string;
  /** Which URL kind we resolved against (`'blob-immutable'` or
   *  `'blob-mutable'`). `/_cas/<sha>` is deferred from this change. */
  pathKind: "blob-mutable" | "blob-immutable";
  cache: {
    xCache: string | null;
    ageSeconds: number | null;
    cacheKind: BlobCacheKind | null;
  };
  invalidation: {
    id: string | null;
    status: "InProgress" | "Completed" | "Failed" | null;
  };
  /** Human-readable hint with actionable next-steps for the agent. */
  hint: string;
}

/**
 * Options for `client.blobs.waitFresh(projectId, opts)`. The URL is the
 * mutable public URL you want to wait on (typically `result.url` from a
 * preceding `blobs.put` call).
 *
 * **Mutable URLs only.** For immutable URLs (`immutableUrl`) no waiting is
 * needed — they are bound to a SHA at upload time and were never previously
 * cached.
 */
export interface BlobWaitFreshOptions {
  /** The mutable URL to poll (e.g. `https://app.run402.com/_blob/avatar.png`). */
  url: string;
  /** Expected hex SHA-256. Polling exits when `observedSha256 === sha256`. */
  sha256: string;
  /** Default 60_000 ms. */
  timeoutMs?: number;
}

/** Result of `client.blobs.waitFresh(...)`. */
export interface BlobWaitFreshResult {
  fresh: boolean;
  observedSha256: string | null;
  attempts: number;
  elapsedMs: number;
  vantage: "gateway-us-east-1";
}

/**
 * v1.50: sort key for {@link BlobLsOptions.sort}. Cursor semantics differ
 * per sort — the gateway returns a sort-pinned cursor that cannot be reused
 * with a different `sort` value (HTTP 400 `INVALID_CURSOR_FOR_SORT`).
 */
export type AssetSortKey = "key:asc" | "createdAt:asc" | "createdAt:desc";

/**
 * v1.50: media-picker filter keys for {@link BlobLsOptions.filter}. All
 * snake_case to match the wire-level query parameters. Unknown keys are
 * rejected client-side with `INVALID_FILTER_KEY` before any HTTP call.
 */
export interface AssetFilter {
  /** Match `uploaded_by` exactly. */
  uploaded_by?: string;
  /** Match a metadata `tags` array element (case-sensitive). */
  tag?: string;
  /** Match the decoded image format exactly (e.g. `"webp"`). */
  format?: string;
  /** Restrict to image uploads (`image_format` non-null) when true; to
   *  non-image uploads when false. Omit to include both. */
  is_image?: boolean;
  /** Width range filter, inclusive. */
  min_width?: number;
  max_width?: number;
  /** Height range filter, inclusive. */
  min_height?: number;
  max_height?: number;
}

/** v1.50: documented filter keys. Used by the client-side validator to
 *  reject unknown keys before any HTTP call. */
export const ASSET_FILTER_KEYS: ReadonlySet<string> = new Set([
  "uploaded_by",
  "tag",
  "format",
  "is_image",
  "min_width",
  "max_width",
  "min_height",
  "max_height",
]);

/** v1.50: documented sort keys. */
export const ASSET_SORT_KEYS: ReadonlyArray<AssetSortKey> = [
  "key:asc",
  "createdAt:asc",
  "createdAt:desc",
];

export interface BlobLsOptions {
  /** Filter: only return blobs whose key starts with this prefix. */
  prefix?: string;
  /** Max results. Server default 100, max 1000. */
  limit?: number;
  /** Pagination cursor from a previous response's `next_cursor`. Cursor
   *  is sort-pinned (v1.50): reusing a `createdAt:*` cursor with `key:asc`
   *  (or vice versa) returns HTTP 400 `INVALID_CURSOR_FOR_SORT`. */
  cursor?: string;
  /** v1.50: sort key. Default `"key:asc"` (legacy bare-key cursor). The
   *  `createdAt:*` variants use a base64url JSON cursor `{s, ts, key}`.
   *  Invalid values are rejected client-side with `INVALID_SORT`. */
  sort?: AssetSortKey;
  /** v1.50: media-picker filter. Unknown keys are rejected client-side
   *  with `INVALID_FILTER_KEY` before any HTTP call. */
  filter?: AssetFilter;
}

export interface BlobSummary {
  key: string;
  size_bytes: number;
  content_type: string | null;
  visibility: BlobVisibility;
  created_at: string;

  // v1.50+ metadata + EXIF policy + image intrinsics (flat shape; mirrors
  // AssetRef). `null` for non-image uploads (except `metadata`, which
  // tracks caller-provided values regardless of MIME).

  /** Caller-supplied flat metadata. `null` when no metadata was set. */
  metadata?: AssetMetadata | null;
  /** Decoded image format. `null` for non-image rows. */
  image_format?: string | null;
  /** Server-extracted intrinsic image info. `null` for non-image rows. */
  image_info?: Record<string, unknown> | null;
  /** Server-extracted EXIF block. `null` for non-image rows, stripped EXIF,
   *  and image formats that do not carry EXIF. */
  image_exif?: Record<string, unknown> | null;
  /** Echo of the EXIF policy actually applied. `null` for non-image rows. */
  image_exif_policy?: ExifPolicy | null;
  /** v1.49+: display-oriented pixel width when known. */
  width_px?: number;
  /** v1.49+: display-oriented pixel height when known. */
  height_px?: number;
  /** v1.49+: LQIP blurhash when known. */
  blurhash?: string;
}

export interface BlobLsResult {
  blobs: BlobSummary[];
  next_cursor: string | null;
}

export interface BlobSignOptions {
  /** URL lifetime in seconds. 60–604800 (7 days). Server default 3600. */
  ttl_seconds?: number;
}

export interface BlobSignResult {
  signed_url: string;
  expires_at: string;
  expires_in: number;
}
