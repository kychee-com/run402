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

/**
 * Minimal shape of the SDK we depend on. We use BOTH:
 *  - `assets.put(...)` for cache-miss single-file uploads (back-compat /
 *    edge cases / tests).
 *  - `assets.putMany(items, opts)` (v0.2.2+, kychee-com/run402-private#408
 *    follow-up) — the right architectural primitive for batch uploads:
 *    ONE plan + ONE commit + parallel S3 PUTs internally + the gateway
 *    encoder's 2-concurrent semaphore fully utilized at activate time.
 *    Per-file `put` did N separate plans which serialized everything
 *    behind the apply substrate; that was the v0.2.1 stopgap.
 */
export interface ProjectAssetsClient {
  assets: {
    put(
      key: string,
      source: Buffer | Uint8Array | string,
      opts?: { contentType?: string; visibility?: "public" | "private" },
    ): Promise<AssetRef>;
    /** Batched apply — provided by `@run402/sdk/node`'s top-level
     *  `r.assets.putMany`. Optional because tests / older SDK versions
     *  may not have it; uploader falls back to per-file `put` when
     *  absent. */
    putMany?(
      items: ReadonlyArray<{
        key: string;
        source: Buffer | Uint8Array | string;
        contentType?: string;
        visibility?: "public" | "private";
      }>,
      opts: { project: string },
    ): Promise<{
      list?: ReadonlyArray<{ key: string; ref: AssetRef; bytes_uploaded?: number; bytes_reused?: number }>;
      byKey?: Record<string, AssetRef | { ref: AssetRef }>;
      manifest?: { entries?: ReadonlyArray<{ key: string; ref: AssetRef }> };
    }>;
  };
}

export interface UploaderOptions {
  /** Max concurrent per-file `put` calls (fallback path only). Default: 1. */
  concurrency?: number;
  /** Key prefix prepended to each uploaded image. Default: "astro/". */
  prefix?: string;
  /** Per-file retry attempts on retryable error codes. Default: 3. */
  maxRetries?: number;
  /**
   * Project ID required by the SDK's `putMany` batch path. When set
   * AND the client exposes `assets.putMany`, the uploader uses ONE
   * batched apply for all cache-miss files; otherwise it falls back
   * to per-file `put` (the legacy v0.2.1 path).
   */
  projectId?: string;
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

  // v0.2.2: prefer the SDK's putMany batch path when available AND a
  // projectId is supplied. ONE plan + ONE commit + parallel S3 PUTs
  // internally + the gateway encoder's 2-concurrent semaphore fully
  // utilized at activate time. For 50 files: ~3 min wall-clock vs.
  // ~6-10 min serial (v0.2.1). See kychee-com/run402-private#408
  // follow-up.
  if (options.projectId && typeof client.assets.putMany === "function") {
    const summary = await uploadAllBatched({
      paths,
      client,
      cache,
      prefix,
      projectId: options.projectId,
      log,
      results,
      durationStart: start,
    });
    return summary;
  }

  // Fallback path: per-file `put` with bounded fan-out. Used when
  // putMany isn't on the client (tests with mocked clients, older
  // SDK versions), or when no projectId was passed. Concurrency
  // defaults to 1 to avoid BASE_RELEASE_CONFLICT racing.
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

/**
 * Batched upload path via `client.assets.putMany`. ONE apply for all
 * cache-miss files. Cache hits are short-circuited and never reach
 * the gateway. Errors from putMany are wrapped as GatewayUploadError
 * keyed to the first file in the batch — the apply substrate is
 * all-or-nothing, so attributing the failure to a single file is
 * approximate; the error message itself names the gateway code.
 */
async function uploadAllBatched(args: {
  paths: string[];
  client: ProjectAssetsClient;
  cache: BuildCache;
  prefix: string;
  projectId: string;
  log?: (event: UploadLogEvent) => void;
  results: Map<string, UploadResult>;
  durationStart: number;
}): Promise<UploaderSummary> {
  const { paths, client, cache, prefix, projectId, log, results, durationStart } = args;
  let fromCache = 0;
  let uploaded = 0;
  let bytesUploaded = 0;
  let bytesReused = 0;

  // Phase 1: filter cache hits. For each path, read sha + check cache;
  // hit → record, skip; miss → queue for putMany batch.
  interface ToUpload {
    absPath: string;
    key: string;
    bytes: Buffer;
    sha: string;
    size: number;
    contentType: string;
  }
  const toUpload: ToUpload[] = [];
  for (const absPath of paths) {
    const bytes = await readFile(absPath);
    const { size } = await stat(absPath);
    const sha = sha256(bytes);
    const cached = cache.get(absPath, sha);
    if (cached) {
      log?.({ absolutePath: absPath, status: "cache_hit", size });
      results.set(absPath, { absolutePath: absPath, assetRef: cached, fromCache: true, size });
      fromCache++;
      bytesReused += size;
      continue;
    }
    toUpload.push({
      absPath,
      key: buildKey(absPath, prefix),
      bytes,
      sha,
      size,
      contentType: inferContentType(absPath),
    });
  }

  // Phase 2: ONE batched putMany call. Returns the AssetManifest
  // shape; we normalize to a per-key result map. Per-key retry isn't
  // possible in this path (the apply is atomic); the call as a whole
  // is retried up to maxRetries on RETRYABLE_CODES via processBatch.
  if (toUpload.length > 0) {
    const uploadStart = Date.now();
    let batchResult;
    try {
      batchResult = await client.assets.putMany!(
        toUpload.map((u) => ({
          key: u.key,
          source: u.bytes,
          contentType: u.contentType,
          visibility: "public" as const,
        })),
        { project: projectId },
      );
    } catch (err) {
      const code = extractErrorCode(err) ?? "PUT_MANY_FAILED";
      const firstPath = toUpload[0]?.absPath ?? "(unknown)";
      log?.({ absolutePath: firstPath, status: "failed", errorCode: code });
      throw new GatewayUploadError(
        code,
        extractErrorMessage(err),
        firstPath,
        extractStatus(err),
      );
    }
    const refByKey = normalizeBatchResult(batchResult);
    const elapsed = Date.now() - uploadStart;
    for (const u of toUpload) {
      const ref = refByKey.get(u.key);
      if (!ref) {
        // Defensive — shouldn't happen if the gateway honored every
        // entry, but surface clearly if it does.
        throw new GatewayUploadError(
          "BATCH_MISSING_KEY",
          `putMany succeeded but key '${u.key}' not in response`,
          u.absPath,
        );
      }
      cache.set(u.absPath, u.sha, ref);
      results.set(u.absPath, { absolutePath: u.absPath, assetRef: ref, fromCache: false, size: u.size });
      uploaded++;
      bytesUploaded += u.size;
      log?.({
        absolutePath: u.absPath,
        status: "uploaded",
        size: u.size,
        durationMs: Math.round(elapsed / toUpload.length),
      });
    }
  }

  return {
    results,
    total: paths.length,
    fromCache,
    uploaded,
    bytesUploaded,
    bytesReused,
    durationMs: Date.now() - durationStart,
  };
}

/**
 * Coerce putMany's response (which has a couple of overlapping shapes
 * depending on SDK version: `list`, `byKey`, or `manifest.entries`)
 * into a `Map<key, AssetRef>` for distribution to per-file results.
 */
function normalizeBatchResult(
  result: NonNullable<Awaited<ReturnType<NonNullable<ProjectAssetsClient["assets"]["putMany"]>>>>,
): Map<string, AssetRef> {
  const out = new Map<string, AssetRef>();
  if (result.byKey) {
    for (const [key, value] of Object.entries(result.byKey)) {
      const ref =
        value && typeof value === "object" && "ref" in value
          ? (value as { ref: AssetRef }).ref
          : (value as AssetRef);
      if (ref) out.set(key, ref);
    }
    if (out.size > 0) return out;
  }
  if (result.list) {
    for (const entry of result.list) {
      out.set(entry.key, entry.ref);
    }
    if (out.size > 0) return out;
  }
  if (result.manifest?.entries) {
    for (const entry of result.manifest.entries) {
      out.set(entry.key, entry.ref);
    }
  }
  return out;
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
    const e = err as {
      code?: unknown;
      envelope?: { code?: unknown };
      body?: { error?: unknown } | null;
    };
    // A revoked CI/OIDC binding (most often: the project was transferred, which
    // suspends the prior org's CI bindings) surfaces from token-exchange as a
    // generic 403 whose canonical code is FORBIDDEN — same as access_denied.
    // The only discriminator is the OAuth-style `error` field. Map it to a
    // dedicated code so the operator gets the re-link remediation instead of
    // the misleading asset-scope hint (set-asset-scopes 409s on a revoked
    // binding). See kychee-com/run402#473.
    if (e.body && typeof e.body === "object" && e.body.error === "binding_revoked") {
      return "CI_BINDING_REVOKED";
    }
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
