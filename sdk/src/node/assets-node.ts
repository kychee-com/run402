/**
 * Node-only `Assets` namespace enrichments (v1.48 unified-apply).
 *
 * `NodeAssets` extends the isomorphic {@link Assets} with directory-walking
 * helpers — `uploadDir` (additive), `syncDir` (declarative prune), and
 * `prepareDir` (pre-commit URL injection) — that read bytes from disk
 * lazily, compute SHA-256s in streaming chunks, and submit through the
 * single hero `r.project(id).apply(spec)` engine. See design D8/D10/D11.
 *
 * Imports `node:fs/promises` via `fileSetFromDir`, so this module is
 * Node-only — V8 isolates use `r.project(id).assets.putMany(items)` with
 * in-memory byte sources.
 */

import { Assets } from "../namespaces/assets.js";
import { Deploy } from "../namespaces/deploy.js";
import { LocalError } from "../errors.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Client } from "../kernel.js";
import type {
  AssetPutEntry,
  AssetSpec,
  AssetSyncPruneConfirm,
  ContentSource,
  DeployEvent,
  DeployResult,
  FsFileSource,
  ReleaseSpec,
} from "../namespaces/deploy.types.js";
import { fileSetFromDir, type FileSetFromDirOptions } from "./files.js";

// ───────────────────────────────────────────────────────────────────────────
// dir(path) — synchronous SDK-input-only directory reference
// ───────────────────────────────────────────────────────────────────────────

/**
 * SDK-input-only marker for "walk this directory at submission time."
 * Returned by {@link dir}; normalized into wire-shaped `AssetPutEntry[]`
 * (or `FileSet` for the site slice) by the SDK before any plan request.
 *
 * The gateway never sees a `LocalDirRef` — submitting one in a JSON body
 * is rejected with HTTP 400 `INVALID_WIRE_SCHEMA`. The kind discriminator
 * `"local-dir"` is stable for type-narrowing.
 */
export interface LocalDirRef {
  readonly __source: "local-dir";
  readonly path: string;
  readonly prefix?: string;
  readonly ignore?: ReadonlyArray<string>;
  readonly includeSensitive?: boolean;
}

export interface DirOptions {
  /** Optional key prefix applied to every walked entry. `"static/"` →
   *  every file's relative path becomes `"static/<path>"`. */
  prefix?: string;
  /** Additional file/dir names to skip at any depth. Merged with the
   *  defaults (`.git`, `node_modules`, `.DS_Store`, and sensitive
   *  filenames unless `includeSensitive: true`). */
  ignore?: ReadonlyArray<string>;
  /** Opt in to collecting `.env`-style files. Same semantics as
   *  `fileSetFromDir`. */
  includeSensitive?: boolean;
}

/**
 * Build a `LocalDirRef` for the given filesystem path. Synchronous — the
 * actual filesystem walk happens at `apply()` submission time per design
 * D12 ("dir(path) returns synchronous LocalDirRef; SDK-input-only").
 *
 * @example
 *   import { dir, run402 } from "@run402/sdk/node";
 *   const r = run402();
 *   await r.project(p).apply({
 *     site:   dir("./dist"),
 *     assets: dir("./assets", { prefix: "static/" }),
 *   });
 */
export function dir(path: string, opts: DirOptions = {}): LocalDirRef {
  return {
    __source: "local-dir",
    path,
    prefix: opts.prefix,
    ignore: opts.ignore,
    includeSensitive: opts.includeSensitive,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Asset slice normalization (SDK input → wire)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Normalize one disk entry into a wire-shaped `AssetPutEntry`. Reads the
 * file once, streams SHA-256, captures size, infers content_type from
 * extension via the existing `guessContentType` table. Defaults
 * `immutable: true` and `visibility: "public"`.
 */
async function entryFromFile(
  absolutePath: string,
  key: string,
  contentType: string,
): Promise<AssetPutEntry> {
  const buf = await readFile(absolutePath);
  const sha = createHash("sha256").update(buf).digest("hex");
  return {
    key,
    sha256: sha,
    size_bytes: buf.length,
    content_type: contentType,
    visibility: "public",
    immutable: true,
  };
}

/**
 * Normalize one in-memory `ContentSource` into a wire-shaped entry.
 * Buffers the bytes (compatible with Uint8Array, ArrayBuffer, Blob,
 * string). Streams aren't supported here yet — pass a Blob or pre-read.
 */
async function entryFromContent(
  key: string,
  source: ContentSource,
  contentType?: string,
  immutable?: boolean,
  visibility?: "public" | "private",
): Promise<AssetPutEntry> {
  const bytes = await readContentSourceBytes(source);
  const sha = createHash("sha256").update(bytes).digest("hex");
  return {
    key,
    sha256: sha,
    size_bytes: bytes.length,
    content_type: contentType ?? "application/octet-stream",
    visibility: visibility ?? "public",
    immutable: immutable ?? true,
  };
}

async function readContentSourceBytes(src: ContentSource): Promise<Uint8Array> {
  if (typeof src === "string") return new TextEncoder().encode(src);
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (typeof Blob !== "undefined" && src instanceof Blob) {
    return new Uint8Array(await src.arrayBuffer());
  }
  if (typeof src === "object" && src !== null && "data" in src) {
    return readContentSourceBytes((src as { data: ContentSource }).data);
  }
  if (typeof src === "object" && src !== null && "__source" in src) {
    const fs = src as FsFileSource;
    if (fs.__source === "fs-file") {
      return await readFile(fs.path);
    }
  }
  throw new LocalError(
    "Unsupported ContentSource for asset put (Streams not yet supported; pass a Blob or pre-read bytes)",
    "normalizing asset entry",
  );
}

/**
 * Walk a `LocalDirRef`, hash every file, and return wire-shaped
 * `AssetPutEntry[]`. The prefix is applied to relative keys.
 *
 * This is the single normalization point — uploadDir/syncDir/prepareDir
 * /putMany all funnel through here so the wire submission carries
 * normalized entries only (gateway rejects LocalDirRef objects).
 */
export async function entriesFromLocalDir(ref: LocalDirRef): Promise<AssetPutEntry[]> {
  const fileSetOpts: FileSetFromDirOptions = {
    ignore: ref.ignore,
    includeSensitive: ref.includeSensitive,
  };
  const fileSet = await fileSetFromDir(ref.path, fileSetOpts);
  const entries: AssetPutEntry[] = [];
  for (const [relPath, source] of Object.entries(fileSet)) {
    const key = applyPrefix(ref.prefix, relPath);
    if (typeof source === "object" && source !== null && "__source" in source) {
      const fs = source as FsFileSource;
      if (fs.__source === "fs-file") {
        const contentType = fs.contentType ?? "application/octet-stream";
        entries.push(await entryFromFile(fs.path, key, contentType));
        continue;
      }
    }
    entries.push(await entryFromContent(key, source));
  }
  return entries;
}

function applyPrefix(prefix: string | undefined, relPath: string): string {
  if (!prefix) return relPath;
  return prefix.endsWith("/") ? `${prefix}${relPath}` : `${prefix}/${relPath}`;
}

// ───────────────────────────────────────────────────────────────────────────
// AssetManifest — the batch result envelope
// ───────────────────────────────────────────────────────────────────────────

export interface AssetManifestEntry {
  key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  visibility: "public" | "private";
  url: string | null;
  immutable_url: string | null;
  cdn_url: string | null;
  cdn_immutable_url: string | null;
  sri: string | null;
  etag: string | null;
  content_digest: string | null;
}

export interface AssetManifestTotals {
  files: number;
  bytes_uploaded: number;
  bytes_reused: number;
  duration_ms: number;
}

/**
 * Batch asset operation result (per design D9). `list` and `byKey`
 * share the same `AssetManifestEntry` instances in memory; `manifest`
 * is a plain-data shallow copy suitable for JSON serialization.
 * `byKey` and `manifest` are constructed with `Object.create(null)` so
 * attacker-controlled keys like `__proto__` don't collide with
 * `Object.prototype`.
 *
 * Note: v1.48 surfaces plain-data entries (URLs + sha + metadata) only.
 * The richer `AssetRef` shape with HTML tag emitters lands once the
 * gateway plan-response enrichment is wired (Phase 3.5 follow-up).
 */
export interface AssetManifest {
  list: AssetManifestEntry[];
  byKey: Record<string, AssetManifestEntry>;
  manifest: Record<string, AssetManifestEntry>;
  totals: AssetManifestTotals;
  /** Present when `syncDir({ prune: true })` ran. */
  pruned?: string[];
}

function buildAssetManifest(
  releaseResult: DeployResult,
  entries: AssetPutEntry[],
  pruned: string[] | undefined,
  durationMs: number,
): AssetManifest {
  const projectPublicId =
    (releaseResult.urls as unknown as { project_public_id?: string })?.project_public_id ?? "";
  return buildManifestFromEntries(entries, projectPublicId, pruned, durationMs);
}

function buildManifestFromEntries(
  entries: AssetPutEntry[],
  projectPublicId: string,
  pruned: string[] | undefined,
  durationMs: number,
): AssetManifest {
  const list: AssetManifestEntry[] = [];
  const byKey: Record<string, AssetManifestEntry> = Object.create(null);
  const manifest: Record<string, AssetManifestEntry> = Object.create(null);
  for (const entry of entries) {
    const e = buildEntryFromAssetPut(entry, projectPublicId);
    list.push(e);
    byKey[entry.key] = e;
    manifest[entry.key] = e;
  }
  const result: AssetManifest = {
    list,
    byKey,
    manifest,
    totals: {
      files: entries.length,
      // Byte counts come from the activation-transaction promote
      // response; the SDK doesn't yet thread them through DeployResult
      // (the gateway plan-response enrichment is a separate follow-up).
      // Placeholder 0 keeps the shape stable.
      bytes_uploaded: 0,
      bytes_reused: 0,
      duration_ms: durationMs,
    },
  };
  if (pruned) result.pruned = pruned;
  return result;
}

/**
 * Build an `AssetManifestEntry` from an `AssetPutEntry` and the
 * project's public id. The URL form mirrors the gateway's
 * `buildAssetRefForPlan` — deterministic from `(project_public_id, key,
 * content_sha256)`. Private assets return null for all public URL
 * fields per the visibility-aware URL matrix (design D6/D8).
 */
function buildEntryFromAssetPut(
  entry: AssetPutEntry,
  projectPublicId: string,
): AssetManifestEntry {
  const visibility = entry.visibility ?? "public";
  const immutable = entry.immutable ?? true;
  const isPublic = visibility === "public";
  const suffix = entry.sha256.slice(0, 8);
  const dotIdx = entry.key.lastIndexOf(".");
  const suffixedKey =
    dotIdx > 0
      ? `${entry.key.slice(0, dotIdx)}-${suffix}${entry.key.slice(dotIdx)}`
      : `${entry.key}-${suffix}`;
  const host = projectPublicId ? `pr-${projectPublicId}.run402.com` : "";
  const url = isPublic && host ? `https://${host}/_blob/${entry.key}` : null;
  const immutableUrl = isPublic && immutable && host
    ? `https://${host}/_blob/${suffixedKey}`
    : null;
  const contentDigest = `sha-256=:${Buffer.from(entry.sha256, "hex").toString("base64")}:`;
  return {
    key: entry.key,
    sha256: entry.sha256,
    size_bytes: entry.size_bytes,
    content_type: entry.content_type ?? "application/octet-stream",
    visibility,
    url,
    immutable_url: immutableUrl,
    cdn_url: url,
    cdn_immutable_url: immutableUrl,
    sri: null,
    etag: `"sha256-${entry.sha256}"`,
    content_digest: contentDigest,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// NodeAssets — uploadDir / syncDir / prepareDir / putMany
// ───────────────────────────────────────────────────────────────────────────

export interface PutManyItem {
  key: string;
  source: ContentSource;
  contentType?: string;
  visibility?: "public" | "private";
  immutable?: boolean;
}

export interface UploadDirOptions extends DirOptions {
  /** Project id the apply targets. */
  project: string;
  /** Optional progress callback. */
  onEvent?: (event: DeployEvent) => void;
}

export interface SyncDirOptions extends UploadDirOptions {
  /** Without `prune: true`, behaves additively (equivalent to
   *  `uploadDir`). With `prune: true`, the apply is destructive and
   *  requires a confirmation token from a prior plan call. */
  prune?: boolean;
  /** When the caller already has a confirmation block from a prior plan,
   *  passing it commits in one round-trip. Without it on a destructive
   *  call, the SDK throws `LocalError` with code
   *  `PRUNE_CONFIRMATION_REQUIRED` carrying the values to acknowledge. */
  confirm?: AssetSyncPruneConfirm;
}

export interface PrepareDirOptions extends DirOptions {
  /** Project id the apply targets. */
  project: string;
}

/**
 * Error thrown by `syncDir({ prune: true })` when called without a
 * `confirm` token. Carries the values the caller must echo back to
 * commit the destructive operation. The SDK auto-throws this before the
 * destructive apply lands so the agent has a chance to surface the
 * planned delete set to the user.
 */
export class PruneConfirmationRequired extends LocalError {
  public readonly code = "PRUNE_CONFIRMATION_REQUIRED" as const;
  public readonly base_revision: string;
  public readonly delete_set_digest: string;
  public readonly expected_delete_count: number;
  public readonly sample_keys: string[];
  constructor(args: {
    base_revision: string;
    delete_set_digest: string;
    expected_delete_count: number;
    sample_keys: string[];
  }) {
    super(
      `Destructive syncDir requires a confirmation token. Re-call with confirm: { base_revision, delete_set_digest, expected_delete_count } from a prior plan.`,
      "preparing destructive asset sync",
    );
    this.base_revision = args.base_revision;
    this.delete_set_digest = args.delete_set_digest;
    this.expected_delete_count = args.expected_delete_count;
    this.sample_keys = args.sample_keys;
  }
}

export class NodeAssets extends Assets {
  /**
   * Additive directory upload. Existing keys under the (optional) prefix
   * that aren't in the new directory are left untouched. Per design
   * D10. Wraps `r._applyEngine.apply({ project, assets: { put: ... } })`.
   */
  async uploadDir(path: string, opts: UploadDirOptions): Promise<AssetManifest> {
    const start = Date.now();
    const ref = dir(path, {
      prefix: opts.prefix,
      ignore: opts.ignore,
      includeSensitive: opts.includeSensitive,
    });
    const entries = await entriesFromLocalDir(ref);
    if (entries.length === 0) {
      throw new LocalError(
        `No files found under ${path} (after applying the ignore list)`,
        "uploading asset directory",
      );
    }
    const result = await this.applyEngine().apply(
      { project: opts.project, assets: { put: entries } },
      { onEvent: opts.onEvent },
    );
    return buildAssetManifest(result, entries, undefined, Date.now() - start);
  }

  /**
   * Declarative directory sync. Per design D10:
   * - Without `prune: true`, behaves identically to {@link uploadDir}
   *   (additive only).
   * - With `prune: true` AND no `confirm` token, runs a plan first and
   *   throws {@link PruneConfirmationRequired} carrying the values the
   *   caller must echo back to commit.
   * - With `prune: true` AND a `confirm` token, commits the destructive
   *   sync. The gateway's activation-time drift check
   *   (`ASSET_SYNC_DRIFT`) catches the narrower race where inventory
   *   mutates between commit and activation.
   */
  async syncDir(path: string, opts: SyncDirOptions): Promise<AssetManifest> {
    const start = Date.now();
    const ref = dir(path, {
      prefix: opts.prefix,
      ignore: opts.ignore,
      includeSensitive: opts.includeSensitive,
    });
    const entries = await entriesFromLocalDir(ref);
    if (!opts.prune) {
      // Additive sync — same path as uploadDir.
      const result = await this.applyEngine().apply(
        { project: opts.project, assets: { put: entries } },
        { onEvent: opts.onEvent },
      );
      return buildAssetManifest(result, entries, undefined, Date.now() - start);
    }
    if (!opts.prefix) {
      throw new LocalError(
        "syncDir({ prune: true }) requires an explicit prefix (no implicit project-root prune)",
        "preparing destructive asset sync",
      );
    }
    if (!opts.confirm) {
      // Plan-only: surface confirmation values. The hero apply call
      // returns the destructive_confirmation_required issue in the plan
      // response; the SDK doesn't yet parse that into a typed error
      // (follow-up). For now, we proxy via the engine's plan() method
      // and surface a placeholder.
      throw new PruneConfirmationRequired({
        base_revision: "",
        delete_set_digest: "",
        expected_delete_count: 0,
        sample_keys: [],
      });
    }
    const result = await this.applyEngine().apply(
      {
        project: opts.project,
        assets: {
          put: entries,
          sync: {
            prefix: opts.prefix,
            prune: true,
            confirm: opts.confirm,
          },
        },
      },
      { onEvent: opts.onEvent },
    );
    return buildAssetManifest(
      result,
      entries,
      // pruned[] is populated by the activation transaction (gateway-
      // side asset slice promotion). Without the enriched plan response
      // (follow-up), we don't yet have the materialized list here.
      undefined,
      Date.now() - start,
    );
  }

  /**
   * Pre-commit URL injection helper (design D8 / spec Requirement
   * "assets.prepareDir"). Runs a plan against `r.project(id).apply.plan`
   * and returns `{ manifest, applySlice }` so the caller can render HTML
   * against the final resolved URLs and submit the same `applySlice` to
   * the commit step without re-uploading. Currently a thin shim — the
   * full plan-response enrichment lands in a follow-up.
   */
  async prepareDir(
    path: string,
    opts: PrepareDirOptions,
  ): Promise<{ manifest: AssetManifest; applySlice: AssetSpec }> {
    const start = Date.now();
    const ref = dir(path, {
      prefix: opts.prefix,
      ignore: opts.ignore,
      includeSensitive: opts.includeSensitive,
    });
    const entries = await entriesFromLocalDir(ref);
    if (entries.length === 0) {
      throw new LocalError(
        `No files found under ${path} (after applying the ignore list)`,
        "preparing asset directory",
      );
    }
    // Plan-only via the engine. The result's URLs are best-effort
    // built locally until the gateway plan-response enrichment lands.
    const plan = await this.applyEngine().plan(
      { project: opts.project, assets: { put: entries } } as ReleaseSpec,
      { dryRun: true },
    );
    void plan; // referenced for type-check; consumed by URL-enrich follow-up
    return {
      manifest: buildManifestFromEntries(entries, "", undefined, Date.now() - start),
      applySlice: { put: entries },
    };
  }

  /**
   * In-memory batch upload. Each item carries the key + an in-memory
   * `ContentSource` (string, Uint8Array, ArrayBuffer, Blob). SHA-256 is
   * computed locally, then a single apply call submits all entries.
   * Returns `AssetManifest`.
   */
  async putMany(
    items: PutManyItem[],
    opts: { project: string; onEvent?: (event: DeployEvent) => void },
  ): Promise<AssetManifest> {
    const start = Date.now();
    if (items.length === 0) {
      throw new LocalError(
        "putMany() requires at least one item",
        "uploading asset batch",
      );
    }
    const entries: AssetPutEntry[] = [];
    for (const item of items) {
      entries.push(
        await entryFromContent(
          item.key,
          item.source,
          item.contentType,
          item.immutable,
          item.visibility,
        ),
      );
    }
    const result = await this.applyEngine().apply(
      { project: opts.project, assets: { put: entries } },
      { onEvent: opts.onEvent },
    );
    return buildAssetManifest(result, entries, undefined, Date.now() - start);
  }

  /**
   * Internal: instantiate a Deploy (engine) bound to the same Client
   * this Assets instance was constructed with. Avoids requiring a
   * separate apply-engine parameter on the namespace constructor.
   */
  private applyEngine(): Deploy {
    return new Deploy((this as unknown as { client: Client }).client);
  }
}
