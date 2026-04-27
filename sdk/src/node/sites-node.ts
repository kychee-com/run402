/**
 * Node-only augmentation of the `sites` namespace.
 *
 * `deployDir(dir)` walks a directory, computes per-file SHA-256 + size,
 * builds a canonical manifest, and ships it via the v1.32 plan/commit
 * transport:
 *
 *   1. POST /deploy/v1/plan { manifest_digest, manifest } — returns per-file
 *      state (`present`, `satisfied_by_plan`, or `missing` + presigned URLs).
 *   2. PUT each `missing` file's bytes to its presigned S3 URL(s),
 *      sending `x-amz-checksum-sha256` to satisfy the signed checksum
 *      algorithm. Single-PUT covers small files; multipart covers large
 *      files (the gateway picks per-part sizing).
 *   3. POST /deploy/v1/commit { plan_id } — Stage 1 (DB) returns
 *      synchronously with `applied`, `noop`, `copying`, or `failed`.
 *      `copying` triggers a poll loop on `GET /deployments/v1/:id` until
 *      `ready` (or `failed`).
 *
 * The canonicalize used to compute `manifest_digest` MUST match the
 * gateway's byte-for-byte (see `./canonicalize.ts`).
 *
 * Imports `node:fs/promises` and so cannot run in a V8 isolate. Wired into
 * the SDK via the `@run402/sdk/node` entry point only.
 */

import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { Sites, type SiteDeployResult } from "../namespaces/sites.js";
import { ApiError, LocalError, Run402Error } from "../errors.js";
import {
  buildCanonicalManifest,
  computeManifestDigest,
  type Manifest,
  type ManifestEntry,
} from "./canonicalize.js";

const DEFAULT_IGNORE = new Set([".git", "node_modules", ".DS_Store"]);
const CONTEXT = "deploying directory";

/** Cap on total time spent waiting for Stage 2 copy to drain. */
const COPY_POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** Initial poll interval; we hold this for ~30 s, then back off. */
const COPY_POLL_INITIAL_MS = 1_000;
const COPY_POLL_MAX_MS = 30_000;
/** Time after which we re-call /deploy/v1/plan to refresh presigned URLs (1 h TTL). */
const URL_REFRESH_AT_MS = 50 * 60 * 1000;

export interface DeployDirOptions {
  /** Project ID the deployment is linked to. */
  project: string;
  /** Local directory to walk. Paths in the manifest are relative to this root. */
  dir: string;
  /** Deployment target label, e.g. `"production"`. */
  target?: string;
  /**
   * Optional progress callback. Invoked synchronously at four phases of the
   * deploy. Errors thrown from the callback are caught and dropped — a buggy
   * consumer can't abort the deploy.
   */
  onEvent?: (event: DeployEvent) => void;
}

/**
 * Progress event emitted by {@link NodeSites.deployDir} when the caller
 * supplies an `onEvent` callback. A discriminated union keyed by `phase`.
 */
export type DeployEvent =
  /** `POST /deploy/v1/plan` returned. Fires once per deploy. */
  | { phase: "plan"; manifest_size: number }
  /**
   * One file's bytes were successfully PUT to S3. Fires once per `missing`
   * entry in the plan response — files reported as `present` or
   * `satisfied_by_plan` do not trigger an upload event.
   */
  | { phase: "upload"; file: string; sha256: string; done: number; total: number }
  /** About to call `POST /deploy/v1/commit`. Fires once per deploy. */
  | { phase: "commit" }
  /** Stage-2 copy poll tick (`GET /deployments/v1/:id`). Fires per iteration when commit returned `copying`. */
  | { phase: "poll"; status: string; elapsed_ms: number };

/** One walked file plus everything we need to hash, plan, and upload it. */
interface WalkedFile {
  path: string;
  size: number;
  sha256: string;
  content_type: string;
  bytes: Buffer;
}

interface PlanFilePresent {
  sha256: string;
  present: true;
  size: number;
  content_type: string;
}
interface PlanFileSatisfied {
  sha256: string;
  satisfied_by_plan: true;
  size: number;
  content_type: string;
}
interface PlanFileMissing {
  sha256: string;
  missing: true;
  upload_id: string;
  mode: "single" | "multipart";
  key: string;
  staging_key: string;
  part_size_bytes: number;
  part_count: number;
  parts: Array<{ part_number: number; url: string; byte_start: number; byte_end: number }>;
  expires_at: string;
}
type PlanFileResponse = PlanFilePresent | PlanFileSatisfied | PlanFileMissing;

interface PlanResponse {
  plan_id: string;
  files: PlanFileResponse[];
}

interface CommitResponse {
  deployment_id: string;
  url: string;
  status: "applied" | "noop" | "copying" | "failed";
  bytes_total?: number;
  bytes_uploaded?: number;
}

/**
 * Sites namespace enriched with the Node-only `deployDir` convenience.
 * All existing `Sites` methods are inherited unchanged.
 */
export class NodeSites extends Sites {
  /**
   * Deploy every file under `dir` as a static site. Walks the tree, hashes
   * each file, plans the deploy with the gateway (which dedupes against
   * already-uploaded content), uploads only the missing bytes, then
   * commits.
   *
   * Files named `.git`, `node_modules`, or `.DS_Store` are skipped at every
   * depth. Symlinks cause a {@link LocalError} — they are not followed.
   */
  async deployDir(opts: DeployDirOptions): Promise<SiteDeployResult> {
    const emit = (event: DeployEvent): void => {
      if (!opts.onEvent) return;
      try {
        opts.onEvent(event);
      } catch {
        // Swallow — a buggy consumer must not abort a deploy in progress.
      }
    };

    const files = await collectFiles(opts.dir);
    if (files.length === 0) {
      throw new LocalError(
        `directory ${opts.dir} contains no deployable files`,
        CONTEXT,
      );
    }

    const manifest = buildCanonicalManifest(
      files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        size: f.size,
        content_type: f.content_type,
      })),
    );
    const manifestDigest = await computeManifestDigest(manifest);

    // Map sha → bytes so we can satisfy the plan response without re-walking.
    // Multiple paths may share the same sha (identical files); any copy works.
    const bytesBySha = new Map<string, Buffer>();
    // Map sha → first manifest path with that content, so upload events can
    // report a human-readable file path even when multiple paths dedupe.
    const pathBySha = new Map<string, string>();
    for (const f of files) {
      bytesBySha.set(f.sha256, f.bytes);
      if (!pathBySha.has(f.sha256)) pathBySha.set(f.sha256, f.path);
    }

    // Reach through to the kernel client. `Sites.client` is `private` in TS
    // but enumerable at runtime; the cast bypasses the visibility check.
    const client = (this as unknown as { client: PlanCommitClient }).client;
    const planClient = new ClientFromBase(client);
    const plan = await planClient.requestPlan(opts.project, manifest, manifestDigest);
    const planAt = Date.now();

    emit({ phase: "plan", manifest_size: manifest.files.length });

    const totalMissing = plan.files.filter(isMissing).length;
    let doneCounter = 0;

    let activePlan = plan;
    let activePlanAt = planAt;
    for (const entry of activePlan.files) {
      if (!isMissing(entry)) continue;

      // Refresh the plan if the URL TTL window is about to close.
      if (Date.now() - activePlanAt > URL_REFRESH_AT_MS) {
        activePlan = await planClient.requestPlan(opts.project, manifest, manifestDigest);
        activePlanAt = Date.now();
      }
      const refreshed = activePlan.files.find((e) => e.sha256 === entry.sha256);
      const target = refreshed && isMissing(refreshed) ? refreshed : entry;

      const bytes = bytesBySha.get(target.sha256);
      if (!bytes) {
        throw new LocalError(
          `internal: no local bytes for sha ${target.sha256.slice(0, 12)}…`,
          CONTEXT,
        );
      }
      try {
        await uploadOne(client.fetch, target, bytes);
      } catch (err) {
        // S3 returns 403 when the presigned URL has expired. Refresh once.
        if (err instanceof ApiError && err.status === 403) {
          activePlan = await planClient.requestPlan(opts.project, manifest, manifestDigest);
          activePlanAt = Date.now();
          const fresh = activePlan.files.find((e) => e.sha256 === target.sha256);
          if (fresh && isMissing(fresh)) {
            await uploadOne(client.fetch, fresh, bytes);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      doneCounter += 1;
      emit({
        phase: "upload",
        file: pathBySha.get(target.sha256) ?? target.sha256,
        sha256: target.sha256,
        done: doneCounter,
        total: totalMissing,
      });
    }

    emit({ phase: "commit" });
    const commit = await planClient.commit(opts.project, activePlan.plan_id);

    if (commit.status === "applied" || commit.status === "noop") {
      return shapeResult(commit);
    }
    if (commit.status === "copying") {
      const final = await pollUntilReady(this, commit.deployment_id, emit);
      return { deployment_id: commit.deployment_id, url: commit.url, ...final };
    }
    // status === "failed": stage 2 exhausted retries. Surface as ApiError so
    // callers can decide whether to re-call deployDir (which re-commits).
    throw new ApiError(
      `Deploy commit failed for plan ${activePlan.plan_id} after copy retries`,
      500,
      commit,
      "committing deploy",
    );
  }
}

// ─── Plan / commit ───────────────────────────────────────────────────────────

interface PlanCommitClient {
  request<T>(path: string, opts: { method?: string; body?: unknown; context: string }): Promise<T>;
  fetch: typeof globalThis.fetch;
}

class ClientFromBase {
  constructor(private readonly client: PlanCommitClient) {}
  async requestPlan(projectId: string, manifest: Manifest, manifestDigest: string): Promise<PlanResponse> {
    return this.client.request<PlanResponse>("/deploy/v1/plan", {
      method: "POST",
      body: { project: projectId, manifest_digest: manifestDigest, manifest },
      context: "planning deploy",
    });
  }
  async commit(projectId: string, planId: string): Promise<CommitResponse> {
    return this.client.request<CommitResponse>("/deploy/v1/commit", {
      method: "POST",
      body: { project: projectId, plan_id: planId },
      context: "committing deploy",
    });
  }
}

function isMissing(entry: PlanFileResponse): entry is PlanFileMissing {
  return (entry as PlanFileMissing).missing === true;
}

function shapeResult(commit: CommitResponse): SiteDeployResult {
  const out: SiteDeployResult = { deployment_id: commit.deployment_id, url: commit.url };
  if (commit.bytes_total !== undefined) out.bytes_total = commit.bytes_total;
  if (commit.bytes_uploaded !== undefined) out.bytes_uploaded = commit.bytes_uploaded;
  return out;
}

// ─── Upload ──────────────────────────────────────────────────────────────────

async function uploadOne(
  fetchFn: typeof globalThis.fetch,
  entry: PlanFileMissing,
  bytes: Buffer,
): Promise<void> {
  if (entry.mode === "single") {
    if (entry.parts.length !== 1) {
      throw new LocalError(
        `internal: single-mode upload for ${entry.sha256.slice(0, 12)}… returned ${entry.parts.length} parts`,
        CONTEXT,
      );
    }
    const part = entry.parts[0];
    const slice = bytes.subarray(part.byte_start, part.byte_end + 1);
    // For single-PUT, the URL pre-commits the whole-object SHA — we send
    // the same value (in base64, not hex) on the PUT.
    const checksum = base64FromHex(entry.sha256);
    await putToS3(fetchFn, part.url, slice, checksum, part.part_number);
    return;
  }
  // multipart: each part PUT carries its own per-part SHA-256 base64.
  for (const part of entry.parts) {
    const slice = bytes.subarray(part.byte_start, part.byte_end + 1);
    const checksum = await sha256Base64(slice);
    await putToS3(fetchFn, part.url, slice, checksum, part.part_number);
  }
}

async function putToS3(
  fetchFn: typeof globalThis.fetch,
  url: string,
  body: Uint8Array,
  checksumBase64: string,
  partNumber: number,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "PUT",
      headers: { "x-amz-checksum-sha256": checksumBase64 },
      body: body as BodyInit,
    });
  } catch (err) {
    throw new ApiError(
      `S3 PUT failed for part ${partNumber}: ${(err as Error).message}`,
      0,
      null,
      "uploading deploy bytes",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `S3 PUT failed for part ${partNumber} (HTTP ${res.status})${text ? ": " + text.slice(0, 200) : ""}`,
      res.status,
      text,
      "uploading deploy bytes",
    );
  }
}

// ─── Poll ────────────────────────────────────────────────────────────────────

interface PollResult {
  status: string;
  url?: string;
  bytes_total?: number;
  bytes_uploaded?: number;
}

async function pollUntilReady(
  sites: NodeSites,
  deploymentId: string,
  emit: (event: DeployEvent) => void,
): Promise<PollResult> {
  const start = Date.now();
  let interval = COPY_POLL_INITIAL_MS;
  while (Date.now() - start < COPY_POLL_TIMEOUT_MS) {
    await sleep(interval);
    let info;
    try {
      info = await sites.getDeployment(deploymentId);
    } catch (err) {
      // Transient lookup failure: keep polling unless we're a hard error.
      if (err instanceof Run402Error && err.status !== null && err.status >= 500) {
        continue;
      }
      throw err;
    }
    emit({ phase: "poll", status: info.status, elapsed_ms: Date.now() - start });
    if (info.status === "ready" || info.status === "applied") {
      return { status: info.status, url: info.url };
    }
    if (info.status === "failed") {
      throw new ApiError(
        `Deployment ${deploymentId} entered failed state during copy`,
        500,
        info,
        "polling deploy",
      );
    }
    // Hold the initial cadence for the first 30 s, then back off to a max.
    if (Date.now() - start > 30_000) {
      interval = Math.min(Math.floor(interval * 1.5), COPY_POLL_MAX_MS);
    }
  }
  throw new ApiError(
    `Timed out waiting for deployment ${deploymentId} to reach ready (${COPY_POLL_TIMEOUT_MS / 60_000} min)`,
    504,
    null,
    "polling deploy",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Filesystem walk + hashing ───────────────────────────────────────────────

async function collectFiles(root: string): Promise<WalkedFile[]> {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (err) {
    throw new LocalError(
      `cannot read directory ${root}: ${(err as Error).message}`,
      CONTEXT,
      err,
    );
  }
  if (rootStat.isSymbolicLink()) {
    throw new LocalError(
      `symlink found at ${root} (following symlinks is not supported)`,
      CONTEXT,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new LocalError(`path ${root} is not a directory`, CONTEXT);
  }

  const out: WalkedFile[] = [];
  await walkInto(root, root, out);
  return out;
}

async function walkInto(root: string, current: string, out: WalkedFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (err) {
    throw new LocalError(
      `cannot read directory ${current}: ${(err as Error).message}`,
      CONTEXT,
      err,
    );
  }
  for (const entry of entries) {
    if (DEFAULT_IGNORE.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new LocalError(
        `symlink found at ${fullPath} (following symlinks is not supported)`,
        CONTEXT,
      );
    }
    if (entry.isDirectory()) {
      await walkInto(root, fullPath, out);
      continue;
    }
    if (entry.isFile()) {
      let bytes;
      try {
        bytes = await readFile(fullPath);
      } catch (err) {
        throw new LocalError(
          `cannot read file ${fullPath}: ${(err as Error).message}`,
          CONTEXT,
          err,
        );
      }
      const rel = normalizeRelPath(relative(root, fullPath));
      out.push({
        path: rel,
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        content_type: guessContentType(rel),
        bytes,
      });
    }
  }
}

/**
 * Normalize a relative path to POSIX forward slashes. Exposed for tests;
 * not part of the public SDK API.
 */
export function normalizeRelPath(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Buffer.from(hash).toString("base64");
}

function base64FromHex(hex: string): string {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new LocalError(`invalid hex sha256: ${hex}`, CONTEXT);
  }
  return Buffer.from(hex, "hex").toString("base64");
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml",
  pdf: "application/pdf",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
};

function guessContentType(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// ─── Test-only exports ───────────────────────────────────────────────────────
// Kept exported so the unit tests can drive the walk + hash logic without
// having to spin up an HTTP mock for every concern.

/** @internal — exposed for tests, not part of the public SDK API. */
export async function _collectFilesForTest(root: string): Promise<WalkedFile[]> {
  return collectFiles(root);
}

/** @internal — exposed for tests, not part of the public SDK API. */
export type { WalkedFile, PlanResponse, CommitResponse, ManifestEntry };
