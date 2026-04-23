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

export interface BlobPutResult {
  key: string;
  size_bytes: number;
  sha256: string | null;
  visibility: BlobVisibility;
  url: string | null;
  immutable_url: string | null;
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
