/**
 * `assets` namespace — in-function blob upload via the unified-apply substrate.
 *
 * Calls `POST /apply/v1/service-asset-put` with service-key auth. The gateway
 * runs the same activation sub-transaction the wallet-auth apply hero uses
 * (`promoteStagedAssetSlice`), so visibility, immutable-URL retention, and
 * per-unique-hash storage billing all behave identically to deploy-time
 * `r.project(id).apply({ assets: { put: [...] } })`.
 *
 * Pre-v1.48 the runtime called `/storage/v1/uploads*`; that substrate was
 * removed in the unified-apply migration. This namespace is the v2.1+
 * in-function replacement.
 */

import { config } from "./config.js";

export type AssetVisibility = "public" | "private";

export interface AssetPutSource {
  content?: string;
  bytes?: Uint8Array;
}

export type AssetPutSourceInput = string | Uint8Array | AssetPutSource;

export interface AssetPutOptions {
  contentType?: string;
  visibility?: AssetVisibility;
  /**
   * When `true` (default), the returned `immutableUrl` is content-addressed
   * and the underlying `internal.asset_versions` row is retained per the
   * project's tier. When `false`, only the mutable `url` is meaningful;
   * `immutableUrl` is null.
   */
  immutable?: boolean;
}

/**
 * Resolved asset reference. Wire shape matches the AssetRef the SDK's
 * `r.project(id).apply` and `r.assets.put` return, so HTML rendered against
 * these URLs is byte-identical to the deploy-time path.
 *
 * Mutable URL: `url` (and `cdnUrl`).
 * Immutable URL: `immutableUrl` (and `cdnImmutableUrl`) — content-hashed
 * suffix, suitable for SRI + indefinite caching.
 *
 * snake_case (`immutable_url`, `size_bytes`, `content_type`) and camelCase
 * (`immutableUrl`, `size`, `contentType`) aliases are both emitted so
 * existing callers and the SDK's surface keep working without translation.
 */
export interface AssetRef {
  key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  visibility: AssetVisibility;
  immutable: boolean;
  url: string | null;
  immutable_url: string | null;
  cdn_url: string | null;
  cdn_immutable_url: string | null;
  sri: string | null;
  etag: string;
  content_digest: string;
  // camelCase aliases for SDK parity.
  immutableUrl: string | null;
  cdnUrl: string | null;
  cdnImmutableUrl: string | null;
  size: number;
  contentType: string;
  contentSha256: string;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
  zip: "application/zip",
  tgz: "application/gzip",
  gz: "application/gzip",
};

function guessContentType(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = key.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

function normalizeSource(source: AssetPutSourceInput): Uint8Array {
  if (typeof source === "string") {
    return new TextEncoder().encode(source);
  }
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source && typeof source === "object") {
    if (source.content !== undefined && source.bytes !== undefined) {
      throw new Error(
        "assets.put: provide exactly one of `content` or `bytes` in source",
      );
    }
    if (typeof source.content === "string") {
      return new TextEncoder().encode(source.content);
    }
    if (source.bytes instanceof Uint8Array) {
      return source.bytes;
    }
  }
  throw new Error(
    "assets.put: source must be a string, Uint8Array, or { content | bytes } object",
  );
}

function widenAssetRef(raw: Record<string, unknown>): AssetRef {
  const url = (raw.url as string | null) ?? null;
  const immutableUrl = (raw.immutable_url as string | null) ?? null;
  const cdnUrl = (raw.cdn_url as string | null) ?? null;
  const cdnImmutableUrl = (raw.cdn_immutable_url as string | null) ?? null;
  return {
    key: String(raw.key ?? ""),
    sha256: String(raw.sha256 ?? ""),
    size_bytes: Number(raw.size_bytes ?? 0),
    content_type: String(raw.content_type ?? "application/octet-stream"),
    visibility: (raw.visibility as AssetVisibility) ?? "public",
    immutable: raw.immutable === true,
    url,
    immutable_url: immutableUrl,
    cdn_url: cdnUrl,
    cdn_immutable_url: cdnImmutableUrl,
    sri: (raw.sri as string | null) ?? null,
    etag: String(raw.etag ?? ""),
    content_digest: String(raw.content_digest ?? ""),
    immutableUrl,
    cdnUrl,
    cdnImmutableUrl,
    size: Number(raw.size_bytes ?? 0),
    contentType: String(raw.content_type ?? "application/octet-stream"),
    contentSha256: String(raw.sha256 ?? ""),
  };
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as {
      code?: string;
      error?: string;
      message?: string;
    };
    const msg = parsed.message || parsed.error || text;
    return parsed.code ? `${parsed.code}: ${msg}` : msg;
  } catch {
    return text;
  }
}

export const assets = {
  /**
   * Upload bytes to the project's blob store and return the resolved AssetRef.
   *
   * Defaults: `visibility: "public"`, `immutable: true`. The mutable `url`
   * always serves the latest bytes for the key; the `immutableUrl` is
   * content-hashed and stable for SRI / long-TTL caching.
   *
   * The gateway runs the same activation sub-transaction the wallet apply
   * hero uses, so quota enforcement (402 on storage-tier overage),
   * per-unique-hash storage billing, and immutable-URL retention all match
   * deploy-time behavior.
   */
  async put(
    key: string,
    source: AssetPutSourceInput,
    opts: AssetPutOptions = {},
  ): Promise<AssetRef> {
    if (typeof key !== "string" || key === "") {
      throw new Error("assets.put: key must be a non-empty string");
    }
    const bytes = normalizeSource(source);
    if (bytes.byteLength === 0) {
      throw new Error("assets.put: bytes must be non-empty");
    }
    const contentType = opts.contentType ?? guessContentType(key);
    const visibility: AssetVisibility = opts.visibility ?? "public";
    const immutable = opts.immutable ?? true;

    // Slice into a fresh ArrayBuffer so the fetch body is a `BufferSource`
    // (Uint8Array<ArrayBufferLike> stopped matching the DOM `BodyInit` union
    // when TS 5.7 made TypedArrays generic over their backing buffer).
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const res = await fetch(config.API_BASE + "/apply/v1/service-asset-put", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.SERVICE_KEY,
        "Content-Type": contentType,
        "x-run402-asset-key": key,
        "x-run402-asset-visibility": visibility,
        "x-run402-asset-immutable": immutable ? "true" : "false",
      },
      body: buf,
    });
    if (!res.ok) {
      throw new Error(
        "Asset put failed (" + res.status + "): " + (await readErrorMessage(res)),
      );
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return widenAssetRef(raw);
  },
};
