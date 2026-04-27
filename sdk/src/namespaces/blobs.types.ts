/**
 * Request and response types for the `blobs` namespace.
 *
 * Covers the direct-to-S3 blob storage API: `PUT /storage/v1/uploads` +
 * multipart S3 uploads, `GET /storage/v1/blob/:key`, `GET /storage/v1/blobs`,
 * `DELETE /storage/v1/blob/:key`, `POST /storage/v1/blob/:key/sign`.
 */

export type BlobVisibility = "public" | "private";

/** Source for an upload. Pass exactly one of `content` (UTF-8 string) or `bytes`. */
export interface BlobPutSource {
  content?: string;
  bytes?: Uint8Array;
}

export interface BlobPutOptions {
  /** MIME type. Auto-detected from `key`'s extension when omitted. */
  contentType?: string;
  /** Default: `"public"`. Public blobs get a CDN URL; private requires auth. */
  visibility?: BlobVisibility;
  /** When true, the returned URL includes a content-hash suffix — overwrites produce distinct URLs. Forces sha256 computation. */
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
 * Stable URL reference returned by `client.blobs.put`. Includes both the
 * legacy snake_case fields (back-compat with pre-v1.45 SDK) and the v1.45+
 * agent-DX fields:
 *
 *   - `immutableUrl` — content-addressed URL; correct from upload time, no
 *     wait. Prefer this in generated HTML/CSS/JS code.
 *   - `etag`, `sri`, `contentDigest` — strong integrity headers derived from
 *     the SHA-256, suitable for `<script integrity=...>` and Subresource
 *     Integrity verification.
 *   - `cdn` — CloudFront invalidation envelope (mostly meaningful for
 *     mutable overwrites; immutable URLs always have `cdn.ready = true`).
 *
 * The legacy fields (`size_bytes`, `sha256`, `immutable_url`) are kept for
 * back-compat — existing consumers that destructure those keys continue to
 * work unchanged.
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
  /** Same value as `size_bytes`, just the camelCase form used by the new
   *  agent-facing surface. */
  size: number;
  /** Hex SHA-256 of the bytes. Same as `sha256` (camelCase alias). */
  contentSha256: string | null;
  /** Effective Content-Type (auto-detected from the key extension when not
   *  set explicitly via `BlobPutOptions.contentType`). */
  contentType: string;
  /** Same value as `immutable_url`. Camel-case alias for the v1.45+ surface.
   *  **Prefer this in generated HTML/CSS/JS** — it never needs cache
   *  invalidation. */
  immutableUrl: string | null;
  /** Strong ETag of the form `"sha256-<hex>"`. Null when `sha256` is null
   *  (only computed when `--immutable` was passed at upload). */
  etag: string | null;
  /** Browser SRI form: `sha256-<base64>`. Use as the `integrity` attribute
   *  value in `<script>`/`<link>` tags. */
  sri: string | null;
  /** RFC 9530 `Content-Digest` value, `sha-256=:<base64>:`. */
  contentDigest: string | null;
  /** Semantic cache-kind hint matching the gateway's response header. */
  cacheKind: BlobCacheKind;
  /** CloudFront invalidation envelope for the mutable URL. Always populated;
   *  for immutable uploads `cdn.ready === true`. */
  cdn: BlobCdnEnvelope;
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
