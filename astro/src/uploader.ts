/**
 * Bounded-parallelism uploader.
 *
 * Given a set of discovered absolute paths + a Run402 SDK project handle,
 * for each path:
 *   1. Read bytes, compute sha256.
 *   2. Check the build cache; on hit (same sha), use the cached AssetRef.
 *   3. On miss, call `project.assets.put(key, bytes, opts)` and cache the
 *      result.
 *
 * Parallelism is bounded at `concurrency: 4` by default. The gateway's
 * encoder semaphore (v1.49: 2 concurrent) accepts the rest in its queue
 * (4 deep) before returning TOO_MANY_ENCODES_QUEUED — so 4 concurrent
 * uploads is the sweet spot where the gateway never rejects and we don't
 * starve.
 *
 * Errors are surfaced verbatim with the source file path appended. We do
 * NOT silently fall back to a non-variant code path — a build that can't
 * upload an image is a build that should fail loudly.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { BuildCache } from "./cache.js";
import { GatewayUploadError } from "./errors.js";
import type { AssetRef } from "./types.js";

/** Minimal shape of the project-scoped SDK we depend on. */
export interface ProjectAssetsClient {
  assets: {
    put(
      key: string,
      source: Buffer | Uint8Array | string,
      opts?: { contentType?: string; visibility?: "public" | "private" },
    ): Promise<AssetRef>;
  };
}

export interface UploaderOptions {
  /** Max concurrent uploads. Default: 4. */
  concurrency?: number;
  /** Key prefix prepended to each uploaded image. Default: "astro/". */
  prefix?: string;
  /** Per-file retry attempts on TOO_MANY_ENCODES_QUEUED. Default: 3. */
  maxRetries?: number;
  /** Logger receives one structured event per upload. */
  log?: (event: UploadLogEvent) => void;
}

export interface UploadLogEvent {
  absolutePath: string;
  status: "cache_hit" | "uploaded" | "retry" | "failed";
  /** Bytes of source file. */
  size?: number;
  /** Wall-clock duration in ms for `uploaded`. */
  durationMs?: number;
  /** Attempt index (1-based) for `retry` / `failed`. */
  attempt?: number;
  /** Error code for `failed`. */
  errorCode?: string;
}

export interface UploadResult {
  absolutePath: string;
  assetRef: AssetRef;
  fromCache: boolean;
  size: number;
}

export interface UploaderSummary {
  results: Map<string, UploadResult>;
  /** Count of unique sources processed. */
  total: number;
  /** Count served from the build cache (no gateway call). */
  fromCache: number;
  /** Count newly uploaded. */
  uploaded: number;
  /** Sum of size_bytes across uploaded entries (NOT cache-hit entries). */
  bytesUploaded: number;
  /** Sum of size_bytes across cache-hit entries. */
  bytesReused: number;
  /** Wall-clock duration of the upload phase in ms. */
  durationMs: number;
}

// v0.2.1 (closes kychee-com/run402-private#408): default concurrency
// dropped from 4 → 1 because every `client.assets.put` routes through
// the apply substrate (per SDK ≥2.1) — each put is its own
// plan-against-base + commit. Parallel puts race on the same base
// release and ALL but the first throw BASE_RELEASE_CONFLICT, so
// concurrency=4 made every multi-file `assetsDir` build fail on the
// first race. Serial puts (concurrency=1) plan against the LATEST
// committed release each time, no conflict possible.
//
// The per-image gateway encoder is already 2-concurrent internally
// (IMAGE_VARIANTS_MAX_CONCURRENCY in services/encoder-semaphore.ts),
// so client-side concurrency >1 doesn't speed up the actual encode
// work — it just contends on the apply pipeline. Net wall-clock
// impact of concurrency=1 vs 4 is small for the apply path; encode
// time is the bottleneck either way.
//
// Future v0.3 could pivot to the SDK's batched
// `assets.uploadDir(path)` for ONE plan covering all files. For now,
// concurrency=1 + retry is the simplest correct fix.
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_PREFIX = "astro/";
const DEFAULT_MAX_RETRIES = 3;

const RETRYABLE_CODES = new Set([
  "TOO_MANY_ENCODES_QUEUED",
  "TOO_MANY_UPLOADS_IN_FLIGHT",
  // Apply-substrate race: another deploy activated a new release
  // between this op's plan and commit. Retrying re-plans against the
  // now-latest base, which will succeed (assuming concurrency=1 within
  // this build — other builds running against the same project are a
  // different cross-build race we'd need backoff-with-jitter for).
  "BASE_RELEASE_CONFLICT",
]);

export async function uploadAll(
  absolutePaths: Iterable<string>,
  client: ProjectAssetsClient,
  cache: BuildCache,
  options: UploaderOptions = {},
): Promise<UploaderSummary> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const log = options.log;

  const paths = Array.from(new Set(absolutePaths)); // dedup
  const results = new Map<string, UploadResult>();
  const start = Date.now();
  let fromCache = 0;
  let uploaded = 0;
  let bytesUploaded = 0;
  let bytesReused = 0;

  // Bounded fan-out: index pointer + N workers.
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < paths.length) {
      const i = idx++;
      const absPath = paths[i]!;
      try {
        const result = await processOne(absPath, client, cache, prefix, maxRetries, log);
        results.set(absPath, result);
        if (result.fromCache) {
          fromCache++;
          bytesReused += result.size;
        } else {
          uploaded++;
          bytesUploaded += result.size;
        }
      } catch (err) {
        log?.({
          absolutePath: absPath,
          status: "failed",
          errorCode: err instanceof GatewayUploadError ? err.code : undefined,
        });
        throw err;
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, paths.length) }, worker);
  await Promise.all(workers);

  return {
    results,
    total: paths.length,
    fromCache,
    uploaded,
    bytesUploaded,
    bytesReused,
    durationMs: Date.now() - start,
  };
}

async function processOne(
  absPath: string,
  client: ProjectAssetsClient,
  cache: BuildCache,
  prefix: string,
  maxRetries: number,
  log?: (e: UploadLogEvent) => void,
): Promise<UploadResult> {
  const [bytes, stats] = await Promise.all([readFile(absPath), stat(absPath)]);
  const sha = sha256(bytes);

  const cached = cache.get(absPath, sha);
  if (cached) {
    log?.({ absolutePath: absPath, status: "cache_hit", size: stats.size });
    return { absolutePath: absPath, assetRef: cached, fromCache: true, size: stats.size };
  }

  const key = buildKey(absPath, prefix);
  const contentType = inferContentType(absPath);

  const startUpload = Date.now();
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const ref = await client.assets.put(key, bytes, {
        contentType,
        visibility: "public",
      });
      cache.set(absPath, sha, ref);
      log?.({
        absolutePath: absPath,
        status: "uploaded",
        size: stats.size,
        durationMs: Date.now() - startUpload,
      });
      return { absolutePath: absPath, assetRef: ref, fromCache: false, size: stats.size };
    } catch (err) {
      lastErr = err;
      const code = extractErrorCode(err);
      if (code && RETRYABLE_CODES.has(code) && attempt < maxRetries) {
        const retryAfterMs = extractRetryAfterMs(err) ?? 2000;
        log?.({
          absolutePath: absPath,
          status: "retry",
          attempt,
          errorCode: code,
        });
        await delay(retryAfterMs);
        continue;
      }
      throw new GatewayUploadError(
        code ?? "UPLOAD_FAILED",
        extractErrorMessage(err),
        absPath,
        extractStatus(err),
      );
    }
  }

  // Retry budget exhausted.
  throw new GatewayUploadError(
    extractErrorCode(lastErr) ?? "UPLOAD_RETRY_EXHAUSTED",
    `${extractErrorMessage(lastErr)} (after ${maxRetries} attempts)`,
    absPath,
    extractStatus(lastErr),
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the asset key from the source path. We use the file basename so
 * downstream tooling that lists blobs by key prefix sees recognizable
 * names. CAS dedup means the actual byte storage is per-sha; the key is
 * for serving.
 */
function buildKey(absPath: string, prefix: string): string {
  const name = basename(absPath);
  return `${prefix}${name}`;
}

function inferContentType(absPath: string): string {
  const ext = extname(absPath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    default:
      return "application/octet-stream";
  }
}

function extractErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; envelope?: { code?: unknown } };
    if (typeof e.code === "string") return e.code;
    if (e.envelope && typeof e.envelope.code === "string") return e.envelope.code;
  }
  return undefined;
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function extractRetryAfterMs(err: unknown): number | null {
  if (err && typeof err === "object") {
    const e = err as { retryAfter?: unknown; headers?: { "retry-after"?: unknown } };
    if (typeof e.retryAfter === "number") return e.retryAfter * 1000;
    if (e.headers && typeof e.headers["retry-after"] === "string") {
      const n = Number(e.headers["retry-after"]);
      if (Number.isFinite(n)) return n * 1000;
    }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
