/**
 * `blobs` namespace — direct-to-S3 blob storage.
 *
 * `put` encapsulates the 3-step upload flow (init → PUT parts to S3 →
 * complete). The S3 PUT uses `client.fetch` directly (not the gateway's
 * `request`) so it bypasses gateway auth and path-rewriting. The client's
 * configured fetch still flows through any wrappers (e.g. test mocks).
 */

import type { Client } from "../kernel.js";
import { ApiError, LocalError } from "../errors.js";
import { requireProjectCredentials } from "../project-credentials.js";
import { assertPositiveSafeInteger } from "../validation.js";
import type {
  BlobCacheKind,
  BlobCdnEnvelope,
  BlobDiagnoseEnvelope,
  BlobLsOptions,
  BlobLsResult,
  BlobPutOptions,
  BlobPutResult,
  BlobPutSource,
  BlobSignOptions,
  BlobSignResult,
  BlobUploadCompleteOptions,
  BlobUploadCompleteResult,
  BlobUploadInitOptions,
  BlobUploadInitResult,
  BlobUploadStatusResult,
  BlobWaitFreshOptions,
  BlobWaitFreshResult,
} from "./assets.types.js";
import {
  appendAssetFilterTo,
  assertAssetFilter,
  assertAssetMetadata,
  assertAssetSortKey,
  assertExifPolicy,
} from "./assets-validation.js";

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function guessContentType(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    pdf: "application/pdf",
    zip: "application/zip",
    tgz: "application/gzip",
    gz: "application/gzip",
  };
  return map[ext] ?? "application/octet-stream";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest typings disallow SharedArrayBuffer-backed views;
  // cast through BufferSource to accept the concrete Uint8Array instance.
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexAndBase64(bytes: Uint8Array): Promise<{ hex: string; base64: string }> {
  const hex = await sha256Hex(bytes);
  return { hex, base64: hexToBase64(hex) };
}

type WireBlobDiagnoseEnvelope = {
  project_id?: string;
  projectId?: string;
  key?: string;
  expected_sha256?: string | null;
  expectedSha256?: string | null;
  observed_sha256?: string | null;
  observedSha256?: string | null;
  vantage?: BlobDiagnoseEnvelope["vantage"];
  probe_method?: BlobDiagnoseEnvelope["probeMethod"];
  probeMethod?: BlobDiagnoseEnvelope["probeMethod"];
  accept_encoding?: string;
  acceptEncoding?: string;
  observed_at?: string;
  observedAt?: string;
  probe_may_have_warmed_cache?: true;
  probeMayHaveWarmedCache?: true;
  canonical_url?: string;
  canonicalUrl?: string;
  path_kind?: BlobDiagnoseEnvelope["pathKind"];
  pathKind?: BlobDiagnoseEnvelope["pathKind"];
  cache?: {
    x_cache?: string | null;
    xCache?: string | null;
    age_seconds?: number | null;
    ageSeconds?: number | null;
    cache_kind?: BlobCacheKind | null;
    cacheKind?: BlobCacheKind | null;
  };
  invalidation?: BlobDiagnoseEnvelope["invalidation"];
  hint?: string;
};

function normalizeBlobDiagnoseEnvelope(env: WireBlobDiagnoseEnvelope): BlobDiagnoseEnvelope {
  const cache = env.cache ?? {};
  return {
    projectId: env.projectId ?? env.project_id ?? "",
    key: env.key ?? "",
    expectedSha256: env.expectedSha256 ?? env.expected_sha256 ?? null,
    observedSha256: env.observedSha256 ?? env.observed_sha256 ?? null,
    vantage: env.vantage ?? "gateway-us-east-1",
    probeMethod: env.probeMethod ?? env.probe_method ?? "GET_RANGE_0_0",
    acceptEncoding: env.acceptEncoding ?? env.accept_encoding ?? "",
    observedAt: env.observedAt ?? env.observed_at ?? "",
    probeMayHaveWarmedCache: env.probeMayHaveWarmedCache ?? env.probe_may_have_warmed_cache ?? true,
    canonicalUrl: env.canonicalUrl ?? env.canonical_url ?? "",
    pathKind: env.pathKind ?? env.path_kind ?? "blob-mutable",
    cache: {
      xCache: cache.xCache ?? cache.x_cache ?? null,
      ageSeconds: cache.ageSeconds ?? cache.age_seconds ?? null,
      cacheKind: cache.cacheKind ?? cache.cache_kind ?? null,
    },
    invalidation: env.invalidation ?? { id: null, status: null },
    hint: env.hint ?? "",
  };
}

function validateSha256Hex(value: unknown, name: string, context: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new LocalError(`${name} must be a 64-character hex SHA-256 digest.`, context);
  }
}

function assertIntegerInRange(
  value: number,
  name: string,
  min: number,
  max: number,
  context: string,
): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new LocalError(`${name} must be a safe integer between ${min} and ${max}.`, context);
  }
}

function checksumHeadersForPresignedUrl(url: string, checksumBase64: string): Record<string, string> {
  let urlHasChecksum = false;
  try {
    urlHasChecksum = new URL(url).searchParams.has("x-amz-checksum-sha256");
  } catch {
    urlHasChecksum = false;
  }
  return urlHasChecksum ? {} : { "x-amz-checksum-sha256": checksumBase64 };
}

/**
 * Gateway upload-completion response shape (legacy snake_case fields plus
 * any new agent-DX fields the gateway emits). Used internally by `put` to
 * widen into the AssetRef return type the SDK exposes.
 */
interface UploadCompleteResponse {
  key: string;
  size_bytes: number;
  sha256: string | null;
  visibility: "public" | "private";
  content_type: string | null;
  immutable_suffix: string | null;
  etag?: string;
  url: string | null;
  immutable_url: string | null;
  /** v1.45+ agent-DX URLs from the gateway. Always on the auto-subdomain
   *  (`pr-<public_id>.run402.com`) which is guaranteed to work through the
   *  v1.33 CDN path. May be null on private uploads or older gateway
   *  versions that don't emit them. */
  cdn_url?: string | null;
  cdn_immutable_url?: string | null;
  /** Optional: future gateway versions emit a `cdn` envelope on completion
   *  with the CloudFront invalidation ID + status for mutable overwrites
   *  (and `ready: true` for immutable uploads). When absent (current
   *  gateway), the SDK fills in safe defaults from local information. */
  cdn?: Partial<BlobCdnEnvelope>;
  // v1.49+ image-variant fields. Present only for image MIMEs against a
  // v1.49+ gateway; absent for non-images, sub-320 images, and older
  // gateway versions.
  width_px?: number;
  height_px?: number;
  blurhash?: string;
  variant_spec_version?: string;
  display_url?: string;
  display_immutable_url?: string;
  variants?: BlobPutResult["variants"];
  // v1.50+ metadata + EXIF policy + image intrinsics. Optional on the
  // wire; absent for pre-v1.50 gateways. The SDK widens to `null` in the
  // public envelope so consumers do not have to distinguish "omitted"
  // from "explicitly null".
  metadata?: Record<string, string | number | boolean | string[]> | null;
  image_format?: string | null;
  image_info?: Record<string, unknown> | null;
  image_exif?: Record<string, unknown> | null;
  image_exif_policy?: "keep" | "strip" | null;
  // v1.54+ shape-contract fields. Absent for pre-v1.54 gateways and for
  // non-image uploads. Threaded through to AssetRef using the omit-when-
  // undefined pattern so the envelope stays bytewise-identical on older
  // gateway versions.
  blurhash_data_url?: string | null;
  asset_schema?: "v1.49" | "v1.50" | "v1.54" | null;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert hex (e.g. `"abcd…"`) to base64 in environments that have either
 * Buffer (Node) or `btoa` (browsers). The helper is here because Browser SDK
 * builds may run without `Buffer`.
 */
function hexToBase64(hex: string): string {
  const len = hex.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  // Prefer Buffer when available (faster on Node).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as unknown as { Buffer?: any; btoa?: (s: string) => string };
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return g.btoa ? g.btoa(s) : "";
}

/**
 * Widen the gateway's snake_case completion response into the AssetRef
 * shape (which adds camelCase aliases + locally-derived integrity fields
 * for any URL the consumer is about to embed in code). For non-immutable
 * uploads where the SHA is null, the integrity fields are null and the
 * agent guidance steers them to use `--immutable` before linking.
 */
function buildAssetRef(
  resp: UploadCompleteResponse,
  contentType: string,
): BlobPutResult {
  const sha = resp.sha256;
  const immutable = !!resp.immutable_url;
  const cacheKind: BlobCacheKind =
    resp.visibility === "private"
      ? "private"
      : immutable
      ? "immutable"
      : "mutable";
  const etag = sha ? `"sha256-${sha}"` : null;
  const sri = sha ? `sha256-${hexToBase64(sha)}` : null;
  const contentDigest = sha ? `sha-256=:${hexToBase64(sha)}:` : null;

  // v1.45 agent-DX URLs — guaranteed CDN-reachable on the auto-subdomain.
  // Older gateway versions don't emit them; null in that case (callers fall
  // back to the preferred-host `url` / `immutableUrl`).
  const cdnUrl = resp.cdn_immutable_url ?? null;
  const cdnMutableUrl = resp.cdn_url ?? null;

  // The cdn envelope: prefer what the gateway returns; fall back to
  // best-effort defaults so older gateway versions don't break the SDK
  // surface. immutable URLs are always-ready by definition.
  const cdnFromGw = resp.cdn ?? {};
  const cdn: BlobCdnEnvelope = {
    version: cdnFromGw.version ?? "blob-gateway-v2",
    invalidationId: cdnFromGw.invalidationId ?? null,
    invalidationStatus: cdnFromGw.invalidationStatus ?? null,
    ready: cdnFromGw.ready ?? immutable,
    hint:
      cdnFromGw.hint ??
      (immutable
        ? "Use cdnUrl + scriptTag()/linkTag()/imgTag() — paste-and-go."
        : "For mutable URLs, propagation is asynchronous. Prefer cdnUrl (immutable, content-hashed) for generated HTML/CSS/JS, or call wait_for_cdn_freshness."),
  };

  // Emitter helpers. Throw with an actionable hint when the SHA is null
  // (non-immutable upload) — the agent should re-upload with `immutable:
  // true` to get content-hashed URLs that pair with SRI.
  function requireImmutable(name: string): { url: string; sri: string } {
    if (!cdnUrl || !sri) {
      throw new LocalError(
        `${name}() requires an immutable upload (pass { immutable: true } to blobs.put). ` +
          `Without immutable, there is no content-addressed CDN URL to bind for SRI and the URL would change on re-upload.`,
        "rendering blob tag",
      );
    }
    return { url: cdnUrl, sri };
  }

  // v1.49+ image-variant convenience computation. The gateway signals
  // "this is an image" by populating `variant_spec_version` (always) or
  // `width_px` (always for image MIMEs, even sub-320). For non-images both
  // are absent. We thread this signal into `thumbUrl` / `displayUrl` so
  // TypeScript narrows correctly: non-image refs return `undefined` from
  // both getters and a picker can't accidentally `<img src={pdfRef.thumbUrl}>`.
  const isImage =
    resp.variant_spec_version !== undefined || resp.width_px !== undefined;
  // Source dimensions are display-oriented (gateway runs EXIF auto-rotate).
  const widthPx = resp.width_px;
  const heightPx = resp.height_px;
  const variants = resp.variants;
  // For non-HEIC images, gateway sets display_url === cdn_url. For HEIC it
  // points to the JPEG transcode. For sub-320 images that have no `variants`,
  // display_url is still populated.
  const displayUrl = isImage
    ? resp.display_url ?? resp.cdn_url ?? undefined
    : undefined;
  const thumbUrl = isImage
    ? variants?.thumb?.cdn_url ?? displayUrl
    : undefined;

  // v1.50: widen each new field to a nullable property. Pre-v1.50 gateways
  // omit them; widening to `null` (instead of optional `undefined`) keeps
  // the consumer JSON shape stable and lets callers branch on
  // `result.image_format === null` without an extra existence check.
  const metadataField = resp.metadata ?? null;
  const imageFormatField = resp.image_format ?? null;
  const imageInfoField = resp.image_info ?? null;
  const imageExifField = resp.image_exif ?? null;
  const imageExifPolicyField = resp.image_exif_policy ?? null;

  return {
    key: resp.key,
    size_bytes: resp.size_bytes,
    sha256: sha,
    visibility: resp.visibility,
    url: resp.url,
    immutable_url: resp.immutable_url,
    size: resp.size_bytes,
    contentSha256: sha,
    contentType,
    immutableUrl: resp.immutable_url,
    cdnUrl,
    cdnMutableUrl,
    etag,
    sri,
    contentDigest,
    cacheKind,
    cdn,

    // v1.49+ image-variant fields. Only set when present on the wire — we
    // intentionally omit (vs. setting to `undefined` explicitly) so the
    // shape is byte-identical to pre-v1.49 for non-images.
    ...(resp.width_px !== undefined ? { width_px: resp.width_px } : {}),
    ...(resp.height_px !== undefined ? { height_px: resp.height_px } : {}),
    ...(resp.blurhash !== undefined ? { blurhash: resp.blurhash } : {}),
    ...(resp.variant_spec_version !== undefined
      ? { variant_spec_version: resp.variant_spec_version }
      : {}),
    ...(resp.display_url !== undefined ? { display_url: resp.display_url } : {}),
    ...(resp.display_immutable_url !== undefined
      ? { display_immutable_url: resp.display_immutable_url }
      : {}),
    ...(variants !== undefined ? { variants } : {}),
    ...(thumbUrl !== undefined ? { thumbUrl } : {}),
    ...(displayUrl !== undefined ? { displayUrl } : {}),

    // v1.50: metadata + EXIF policy + image intrinsics (flat shape).
    // Always present in the envelope; `null` for non-image uploads (and
    // for pre-v1.50 gateway responses where the fields are absent on the
    // wire).
    metadata: metadataField,
    image_format: imageFormatField,
    image_info: imageInfoField,
    image_exif: imageExifField,
    image_exif_policy: imageExifPolicyField,

    // v1.54: shape-contract fields. Omit-when-undefined so pre-v1.54
    // envelopes stay bytewise-identical (no null injection).
    ...(resp.blurhash_data_url !== undefined
      ? { blurhash_data_url: resp.blurhash_data_url }
      : {}),
    ...(resp.asset_schema !== undefined
      ? { asset_schema: resp.asset_schema }
      : {}),

    scriptTag(opts) {
      // Default `defer: true` — modern best practice. Defer prevents
      // render-blocking when placed in <head> and is a no-op when placed
      // at the end of <body> (the script runs after DOMContentLoaded
      // either way). Pass `{ defer: false }` to opt out for the rare
      // case requiring synchronous execution. `async` and `defer` are
      // mutually exclusive; passing async overrides defer.
      const { url, sri } = requireImmutable("scriptTag");
      const attrs: string[] = [`src="${escapeHtmlAttr(url)}"`];
      if (opts?.type === "module") attrs.push(`type="module"`);
      const wantsAsync = opts?.async === true;
      const wantsDefer = opts?.defer ?? !wantsAsync;
      if (wantsAsync) attrs.push("async");
      else if (wantsDefer) attrs.push("defer");
      attrs.push(`integrity="${escapeHtmlAttr(sri)}"`);
      attrs.push("crossorigin");
      return `<script ${attrs.join(" ")}></script>`;
    },

    linkTag(opts) {
      // Always emit crossorigin — required for SRI to actually be
      // enforced. Without crossorigin the browser silently ignores the
      // integrity attribute (HTML spec). This applies to rel="preload"
      // too: matching crossorigin on the preload + the eventual fetch is
      // what lets the browser dedupe instead of double-fetching.
      const { url, sri } = requireImmutable("linkTag");
      const rel = opts?.rel ?? "stylesheet";
      const attrs: string[] = [`rel="${escapeHtmlAttr(rel)}"`];
      attrs.push(`href="${escapeHtmlAttr(url)}"`);
      if (opts?.as) attrs.push(`as="${escapeHtmlAttr(opts.as)}"`);
      attrs.push(`integrity="${escapeHtmlAttr(sri)}"`);
      attrs.push("crossorigin");
      return `<link ${attrs.join(" ")}>`;
    },

    imgTag(alt) {
      // Defaults: loading="lazy" + decoding="async" — modern best
      // practice. Lazy is harmless for above-fold images (browsers
      // handle the heuristic) and a flat win for the much more common
      // below-fold case. Async decoding moves the decode off the main
      // thread. Both are baseline-supported in all major browsers.
      // <img> doesn't accept SRI per HTML5; the URL is content-hashed
      // so it's still stable across re-deploys. Agents who need
      // byte-level integrity for images should verify Content-Digest
      // server-side.
      //
      // v1.49+ HEIC handling: when the source is HEIC/HEIF, `cdn_url`
      // serves the original (unrenderable) HEIC bytes and `display_url`
      // serves a generated JPEG transcode. We default `<img src>` to
      // `display_url ?? cdn_url` so HEIC uploads render without the
      // caller knowing about it. For non-HEIC images `display_url ===
      // cdn_url`, so this is a no-op there.
      const { url: immutableCdnUrl } = requireImmutable("imgTag");
      const src = displayUrl ?? immutableCdnUrl;
      const a = alt ?? "";
      const attrs: string[] = [`src="${escapeHtmlAttr(src)}"`, `alt="${escapeHtmlAttr(a)}"`];
      // v1.49+ width/height emission. When both dimensions are known
      // the browser reserves layout space and avoids Cumulative Layout
      // Shift. Skip silently when either is missing (non-image, sub-320
      // pre-v1.49 source, etc.) — `imgTag` never errors on absence.
      if (widthPx !== undefined && heightPx !== undefined) {
        attrs.push(`width="${widthPx}"`);
        attrs.push(`height="${heightPx}"`);
      }
      attrs.push(`loading="lazy"`, `decoding="async"`);
      return `<img ${attrs.join(" ")}>`;
    },

    imgTagWithSrcSet(opts) {
      // Hard guard #1: opts.sizes must be a non-empty string. Without
      // it, browsers conservatively download the largest candidate in
      // srcset (defeating the variant set). Default-to-100vw would be
      // wrong for any grid layout, so we throw and force the caller to
      // think about sizes once instead of shipping a silent footgun.
      if (
        !opts ||
        typeof opts.sizes !== "string" ||
        opts.sizes.trim() === ""
      ) {
        throw new LocalError(
          `imgTagWithSrcSet requires opts.sizes (e.g. '(max-width: 800px) 100vw, 1920px') — browsers over-fetch the largest srcset candidate without it.`,
          "rendering responsive image",
        );
      }
      // Hard guard #2: variants must include all three WebP sizes.
      // Non-image refs, sub-320 images, and pre-v1.49 uploads land here
      // with `variants` undefined or missing one of the three. Silent
      // fallback would render a busted layout (no srcset, no responsive
      // benefit) with no diagnostic, so we throw and tell the caller to
      // use `imgTag()` instead.
      const thumb = variants?.thumb;
      const medium = variants?.medium;
      const large = variants?.large;
      if (!thumb || !medium || !large) {
        throw new LocalError(
          `imgTagWithSrcSet called on an AssetRef without variants. Variants are generated only for image MIMEs ≥320×320 against a v1.49+ gateway. Use imgTag() instead for non-image refs, sub-320 images, or older gateway responses.`,
          "rendering responsive image",
        );
      }
      // The <img> fallback must use display_url for HEIC sources
      // (browsers can't render HEIC bytes). For non-HEIC images
      // display_url === cdn_url. cdnUrl from the AssetRef widening is
      // the immutable form; here we prefer display_url which the
      // gateway already pinned to the right variant.
      const fallbackSrc = displayUrl ?? cdnUrl ?? "";
      const altAttr = `alt="${escapeHtmlAttr(opts.alt ?? "")}"`;
      const loadingAttr = `loading="${opts.loading === "eager" ? "eager" : "lazy"}"`;
      const srcset = [
        `${thumb.cdn_url} ${thumb.width_px}w`,
        `${medium.cdn_url} ${medium.width_px}w`,
        `${large.cdn_url} ${large.width_px}w`,
      ].join(", ");
      const sizes = opts.sizes;
      const imgAttrs: string[] = [
        `src="${escapeHtmlAttr(fallbackSrc)}"`,
        altAttr,
      ];
      // AVIF deferred from v1: <picture> picks sources by type
      // precedence, not best size. A single 1920w AVIF would be picked
      // for thumbnails by AVIF-capable browsers, defeating the variant
      // set. AVIF, if it returns, will land at all three sizes or via
      // a dedicated imgTagHero() helper.
      if (widthPx !== undefined && heightPx !== undefined) {
        imgAttrs.push(`width="${widthPx}"`);
        imgAttrs.push(`height="${heightPx}"`);
      }
      imgAttrs.push(loadingAttr, `decoding="async"`);
      const sourceLine = `<source type="image/webp" srcset="${escapeHtmlAttr(srcset)}" sizes="${escapeHtmlAttr(sizes)}">`;
      const imgLine = `<img ${imgAttrs.join(" ")}>`;
      return `<picture>${sourceLine}${imgLine}</picture>`;
    },
  };
}

export class Assets {
  constructor(private readonly client: Client) {}

  /**
   * Upload a blob via the 3-step direct-to-S3 flow. The bytes are PUT to
   * presigned S3 URLs — they do NOT pass through the gateway, so uploads
   * are not double-billed as API calls and large files stream efficiently.
   *
   * Pass `immutable: true` to produce a content-addressed URL. The SDK always
   * computes the SHA-256 digest required by the upload API; `immutable` only
   * controls URL/cache semantics.
   *
   * @throws {ProjectNotFound} if `projectId` is not in the provider.
   */
  async put(
    projectId: string,
    key: string,
    source: BlobPutSource,
    opts: BlobPutOptions = {},
  ): Promise<BlobPutResult> {
    // Normalize the polymorphic source shape (GH-126). Bare strings and
    // Uint8Arrays are accepted as a shorthand for `{ content }` / `{ bytes }`
    // so callers don't need to know about the wrapper object — every other
    // ContentSource-shaped surface in the SDK accepts the bare form.
    let normalized: { content?: string; bytes?: Uint8Array };
    if (typeof source === "string") {
      normalized = { content: source };
    } else if (source instanceof Uint8Array) {
      normalized = { bytes: source };
    } else {
      normalized = source as { content?: string; bytes?: Uint8Array };
    }

    if ((normalized.content !== undefined && normalized.bytes !== undefined) ||
        (normalized.content === undefined && normalized.bytes === undefined)) {
      throw new LocalError(
        "Provide exactly one of `content` or `bytes` in BlobPutSource.",
        "uploading blob",
      );
    }

    const bytes: Uint8Array = normalized.bytes
      ? normalized.bytes
      : new TextEncoder().encode(normalized.content!);
    const sizeBytes = bytes.byteLength;

    if (normalized.content !== undefined && sizeBytes > 1_048_576) {
      throw new LocalError(
        "`content` is limited to 1 MB. Use `bytes` for larger uploads.",
        "uploading blob",
      );
    }

    const contentType = opts.contentType ?? guessContentType(key);
    // v1.45 default: `immutable: true`. The agent-DX surface (cdnUrl, sri,
    // scriptTag/linkTag/imgTag) only works for content-addressed uploads.
    const immutable = opts.immutable ?? true;
    const visibility = opts.visibility ?? "public";

    // v1.50: validate caller-supplied metadata + EXIF policy BEFORE any
    // HTTP call. Errors throw LocalError with `code` set to the canonical
    // gateway error code so consumers can branch on `e.code` regardless of
    // whether the rejection happened locally or remotely.
    if (opts.metadata !== undefined) {
      assertAssetMetadata(opts.metadata, "uploading asset");
    }
    if (opts.exifPolicy !== undefined) {
      assertExifPolicy(opts.exifPolicy, "uploading asset");
    }

    // Check credentials early so callers get ProjectNotFound rather than a
    // generic error from inside the apply flow.
    const projectKeys = await requireProjectCredentials(this.client, projectId, "uploading asset");

    // v1.48 unified-apply: route through the apply hero. Bytes upload via
    // /content/v1/plans (CAS substrate) and the asset slice promotes in the
    // activation transaction of /apply/v1/plans/:plan_id/commit. The legacy
    // /storage/v1/uploads* flow is gone (gateway returns 404).
    const { Deploy } = await import("./deploy.js");
    const deploy = new Deploy(this.client);
    const result = await deploy.apply({
      project: projectId,
      assets: {
        put: [
          {
            key,
            source: bytes,
            content_type: contentType,
            visibility,
            immutable,
            ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
            ...(opts.exifPolicy !== undefined ? { exifPolicy: opts.exifPolicy } : {}),
          },
        ],
      },
    });

    // The plan response's asset_entries[].asset_ref is threaded into
    // result.assets.byKey by buildAssetManifestFromPlanEntries in deploy.ts.
    const entry = result.assets?.byKey[key];
    if (!entry) {
      throw new LocalError(
        `apply succeeded but result.assets.byKey["${key}"] is missing. Gateway plan response did not include an asset_entries entry for the key — likely an older gateway version pre-v1.48.`,
        "uploading asset",
      );
    }

    // Widen AssetManifestEntry → BlobPutResult (AssetRef shape with
    // scriptTag/linkTag/imgTag emitters). The integrity fields and CDN
    // envelope are derived from the same SHA the gateway resolved.
    // v1.49+: image-variant fields (width_px/height_px/blurhash/variants/
    // display_url/display_immutable_url/variant_spec_version) are
    // threaded through `AssetManifestEntry` by
    // `buildAssetManifestFromPlanEntries` in deploy.ts. They're optional
    // and absent for non-image MIMEs.
    const sha = entry.sha256;
    const completion: UploadCompleteResponse = {
      key: entry.key,
      size_bytes: entry.size_bytes,
      sha256: sha,
      visibility: entry.visibility,
      url: entry.url,
      immutable_url: entry.immutable_url,
      content_type: entry.content_type,
      cdn_url: entry.cdn_url,
      cdn_immutable_url: entry.cdn_immutable_url,
      immutable_suffix: null,
      // v1.49+ image-variant pass-through. Only set when present so the
      // shape stays bytewise-identical to pre-v1.49 for non-images.
      ...(entry.width_px !== undefined ? { width_px: entry.width_px } : {}),
      ...(entry.height_px !== undefined ? { height_px: entry.height_px } : {}),
      ...(entry.blurhash !== undefined ? { blurhash: entry.blurhash } : {}),
      ...(entry.variant_spec_version !== undefined
        ? { variant_spec_version: entry.variant_spec_version }
        : {}),
      ...(entry.display_url !== undefined ? { display_url: entry.display_url } : {}),
      ...(entry.display_immutable_url !== undefined
        ? { display_immutable_url: entry.display_immutable_url }
        : {}),
      ...(entry.variants !== undefined ? { variants: entry.variants } : {}),
      // v1.50 metadata + EXIF policy + image intrinsics pass-through.
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      ...(entry.image_format !== undefined ? { image_format: entry.image_format } : {}),
      ...(entry.image_info !== undefined ? { image_info: entry.image_info } : {}),
      ...(entry.image_exif !== undefined ? { image_exif: entry.image_exif } : {}),
      ...(entry.image_exif_policy !== undefined
        ? { image_exif_policy: entry.image_exif_policy }
        : {}),
      // v1.54 shape-contract pass-through.
      ...(entry.blurhash_data_url !== undefined
        ? { blurhash_data_url: entry.blurhash_data_url }
        : {}),
      ...(entry.asset_schema !== undefined
        ? { asset_schema: entry.asset_schema }
        : {}),
    };
    return buildAssetRef(completion, contentType);
  }

  /**
   * @deprecated REMOVED in v2.1.0. The /storage/v1/uploads* substrate was
   * dropped in gateway v1.48; all bytes flow through /content/v1/plans now.
   * Migrate to `r.project(id).apply({ assets: { put: [{ key, source, ... }] } })`
   * for single-asset uploads or `r.assets.uploadDir/syncDir/prepareDir/putMany`
   * for batches. For low-level resumable control, use `r.project(id).apply.plan`
   * and the returned `byteReaders` map.
   */
  async initUploadSession(
    _projectId: string,
    _opts: BlobUploadInitOptions,
  ): Promise<BlobUploadInitResult> {
    throw new LocalError(
      "Assets.initUploadSession was removed in v2.1.0 (gateway v1.48 dropped /storage/v1/uploads). " +
        "Use `r.project(id).apply({ assets: { put: [{ key, source, ... }] } })` for single-asset uploads, " +
        "or `r.assets.uploadDir/syncDir/prepareDir/putMany` for batches.",
      "initializing upload",
    );
  }

  /**
   * @deprecated REMOVED in v2.1.0 — see {@link initUploadSession}.
   */
  async getUploadSession(
    _projectId: string,
    _uploadId: string,
  ): Promise<BlobUploadStatusResult> {
    throw new LocalError(
      "Assets.getUploadSession was removed in v2.1.0 (gateway v1.48 dropped /storage/v1/uploads). " +
        "Low-level resumable upload sessions are no longer a public surface; the apply engine handles retries.",
      "fetching upload session",
    );
  }

  /**
   * @deprecated REMOVED in v2.1.0 — see {@link initUploadSession}.
   */
  async completeUploadSession(
    _projectId: string,
    _uploadId: string,
    _opts: BlobUploadCompleteOptions = {},
    _extra: { contentType?: string } = {},
  ): Promise<BlobUploadCompleteResult> {
    throw new LocalError(
      "Assets.completeUploadSession was removed in v2.1.0 (gateway v1.48 dropped /storage/v1/uploads/:id/complete). " +
        "Use `r.project(id).apply` — the apply hero's activation transaction promotes staged uploads to CAS automatically.",
      "completing upload",
    );
  }

  /**
   * Diagnose a public blob URL. Returns a JSON envelope describing the live
   * CDN state (expected vs observed SHA, cache headers, recent invalidation
   * status, vantage). The gateway probes the URL once from us-east-1 with
   * `Range: bytes=0-0` and returns within 5 s even if the inner probe is
   * slow.
   *
   * **Vantage caveat:** the result reflects ONE CloudFront PoP at the time
   * of the call. Other PoPs may serve different cached states. The
   * `probeMayHaveWarmedCache: true` field reminds the agent that the probe
   * itself populates the cache, so a subsequent read may differ.
   *
   * The URL must belong to the requesting project — cross-project URLs are
   * rejected by the gateway with `403`. SSRF is enforced gateway-side: only
   * `*.run402.com` and the project's active custom domains are accepted.
   *
   * @example
   *   const diag = await client.blobs.diagnoseUrl("prj_abc", "https://app.run402.com/_blob/avatar.png");
   *   if (diag.observedSha256 !== diag.expectedSha256) console.log(diag.hint);
   */
  async diagnoseUrl(projectId: string, url: string): Promise<BlobDiagnoseEnvelope> {
    const project = await requireProjectCredentials(this.client, projectId, "diagnosing blob URL");

    const path = `/storage/v1/blobs/diagnose?url=${encodeURIComponent(url)}`;
    const env = await this.client.request<WireBlobDiagnoseEnvelope>(path, {
      headers: {
        apikey: project.service_key,
        Authorization: `Bearer ${project.service_key}`,
      },
      context: "diagnosing blob URL",
    });
    return normalizeBlobDiagnoseEnvelope(env);
  }

  /**
   * Poll the CDN until a mutable URL serves the expected SHA-256, or the
   * timeout elapses. **For mutable URLs only** — for immutable URLs (the
   * `immutableUrl` returned by `put`) no waiting is needed; they're bound
   * at upload time and never previously cached.
   *
   * Default `timeoutMs` is 60_000 (60 s). The helper polls the gateway's
   * diagnose endpoint with exponential backoff bounded by 1 s; each poll
   * may itself warm the cache for the probed PoP, so subsequent reads from
   * other PoPs may still be stale until invalidation propagation completes.
   *
   * @example
   *   await client.blobs.waitFresh("prj_abc", {
   *     url: result.url,           // the mutable URL from blobs.put
   *     sha256: result.contentSha256,
   *     timeoutMs: 30_000,
   *   });
   */
  async waitFresh(
    projectId: string,
    opts: BlobWaitFreshOptions,
  ): Promise<BlobWaitFreshResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    assertPositiveSafeInteger(timeoutMs, "timeoutMs", "waiting for CDN freshness");

    const project = await requireProjectCredentials(this.client, projectId, "waiting for CDN freshness");

    const expected = opts.sha256.toLowerCase();
    const start = Date.now();

    let attempts = 0;
    let observed: string | null = null;
    let delay = 100;
    while (Date.now() - start < timeoutMs) {
      attempts++;
      try {
        const envelope = await this.diagnoseUrl(projectId, opts.url);
        observed = envelope.observedSha256;
        if (observed && observed.toLowerCase() === expected) {
          return {
            fresh: true,
            observedSha256: observed,
            attempts,
            elapsedMs: Date.now() - start,
            vantage: "gateway-us-east-1",
          };
        }
      } catch {
        // Swallow & retry — `diagnoseUrl` can fail on transient gateway
        // hiccups (e.g. ALB cycling). The next poll re-attempts.
      }
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 1000);
    }
    return {
      fresh: false,
      observedSha256: observed,
      attempts,
      elapsedMs: Date.now() - start,
      vantage: "gateway-us-east-1",
    };
  }

  /**
   * Download a blob. Returns the raw `Response` so callers can stream to
   * disk, pipe to another sink, or buffer with `.bytes()` / `.arrayBuffer()`.
   * This avoids forcing large blobs through a JS buffer.
   *
   * @throws {ProjectNotFound} if `projectId` is not in the provider.
   * @throws {ApiError} on non-2xx (includes the error text from the response body).
   */
  async get(projectId: string, key: string): Promise<Response> {
    const project = await requireProjectCredentials(this.client, projectId, "downloading blob");

    const url = `${this.client.apiBase}/storage/v1/blob/${encodeKey(key)}`;
    const res = await this.client.fetch(url, {
      headers: {
        apikey: project.service_key,
        Authorization: `Bearer ${project.service_key}`,
      },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ApiError(
        `Downloading blob failed (HTTP ${res.status})`,
        res.status,
        errText,
        "downloading blob",
      );
    }
    return res;
  }

  /** List blobs with optional prefix + pagination + (v1.50) sort + filter.
   *  Unknown filter keys, invalid sort values, and other structural issues
   *  are rejected client-side BEFORE any HTTP call. */
  async ls(projectId: string, opts: BlobLsOptions = {}): Promise<BlobLsResult> {
    if (opts.limit !== undefined) {
      assertPositiveSafeInteger(opts.limit, "limit", "listing blobs");
    }
    if (opts.sort !== undefined) {
      assertAssetSortKey(opts.sort, "listing blobs");
    }
    if (opts.filter !== undefined) {
      assertAssetFilter(opts.filter, "listing blobs");
    }

    const project = await requireProjectCredentials(this.client, projectId, "listing blobs");

    const qs = new URLSearchParams();
    if (opts.prefix) qs.set("prefix", opts.prefix);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.sort) qs.set("sort", opts.sort);
    if (opts.filter) appendAssetFilterTo(qs, opts.filter);
    const query = qs.toString();
    const path = `/storage/v1/blobs${query ? "?" + query : ""}`;

    return this.client.request<BlobLsResult>(path, {
      headers: {
        apikey: project.service_key,
        Authorization: `Bearer ${project.service_key}`,
      },
      context: "listing blobs",
    });
  }

  /** Delete a blob and decrement the project's storage_bytes. */
  async rm(projectId: string, key: string): Promise<void> {
    const project = await requireProjectCredentials(this.client, projectId, "deleting blob");

    await this.client.request<unknown>(`/storage/v1/blob/${encodeKey(key)}`, {
      method: "DELETE",
      headers: {
        apikey: project.service_key,
        Authorization: `Bearer ${project.service_key}`,
      },
      context: "deleting blob",
    });
  }

  /** Generate a time-boxed S3 presigned GET URL for a blob. Default TTL 1 hour, max 7 days. */
  async sign(projectId: string, key: string, opts: BlobSignOptions = {}): Promise<BlobSignResult> {
    if (opts.ttl_seconds !== undefined) {
      assertIntegerInRange(opts.ttl_seconds, "ttl_seconds", 60, 604800, "signing blob URL");
    }

    const project = await requireProjectCredentials(this.client, projectId, "signing blob URL");

    const body: Record<string, unknown> = {};
    if (opts.ttl_seconds !== undefined) body.ttl_seconds = opts.ttl_seconds;

    return this.client.request<BlobSignResult>(
      `/storage/v1/blob/${encodeKey(key)}/sign`,
      {
        method: "POST",
        headers: {
          apikey: project.service_key,
          Authorization: `Bearer ${project.service_key}`,
        },
        body,
        context: "signing blob URL",
      },
    );
  }
}
