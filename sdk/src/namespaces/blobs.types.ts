/**
 * Request and response types for the `blobs` namespace.
 *
 * Covers the direct-to-S3 blob storage API: `PUT /storage/v1/uploads` +
 * multipart S3 uploads, `GET /storage/v1/blob/:key`, `GET /storage/v1/blobs`,
 * `DELETE /storage/v1/blob/:key`, `POST /storage/v1/blob/:key/sign`.
 */

export type BlobVisibility = "public" | "private";

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
   * Cost: one SHA-256 pass over the bytes on the client side. For small
   * assets (the typical case — images, JS, CSS, fonts, JSON < 1 MB) it's
   * a few ms dominated by network. Pass `false` to skip the SHA pass for
   * very large uploads where you specifically don't need a content-hashed
   * URL or SRI.
   *
   * When `false`, the returned `AssetRef` has `cdnUrl: null`, `sri: null`,
   * and the tag emitters throw with an "immutable: true required" hint.
   */
  immutable?: boolean;
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
   */
  imgTag(alt?: string): string;
}

/**
 * Return type of `client.blobs.put`. v1.45 widens this to AssetRef; the
 * legacy fields stay for back-compat.
 */
export type BlobPutResult = AssetRef;

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

export interface BlobLsOptions {
  /** Filter: only return blobs whose key starts with this prefix. */
  prefix?: string;
  /** Max results. Server default 100, max 1000. */
  limit?: number;
  /** Pagination cursor from a previous response's `next_cursor`. */
  cursor?: string;
}

export interface BlobSummary {
  key: string;
  size_bytes: number;
  content_type: string | null;
  visibility: BlobVisibility;
  created_at: string;
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
