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
import type { Client } from "../kernel.js";
import type {
  AssetPutEntryInput,
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
// Asset slice input building (SDK input → AssetPutEntryInput)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Walk a `LocalDirRef` and emit `AssetPutEntryInput[]` carrying a
 * `ContentSource` per file (rather than a pre-computed SHA). The actual
 * hashing + byte-reader registration happens inside the SDK's
 * `normalizeAssetSlice` pipeline so the bytes are uploaded via the shared
 * `byteReaders` map (v1.48 unified-apply). Returning wire-shaped entries
 * here would skip byte-reader registration and the deploy would fail with
 * `Missing bytes for sha=<...>` at upload time.
 *
 * The prefix is applied to relative keys. content_type/visibility/immutable
 * are left to the normalizer's defaults (visibility=public, immutable=true,
 * content_type derived from extension).
 */
export async function entriesFromLocalDir(ref: LocalDirRef): Promise<AssetPutEntryInput[]> {
  const fileSetOpts: FileSetFromDirOptions = {
    ignore: ref.ignore,
    includeSensitive: ref.includeSensitive,
  };
  const fileSet = await fileSetFromDir(ref.path, fileSetOpts);
  const entries: AssetPutEntryInput[] = [];
  for (const [relPath, source] of Object.entries(fileSet)) {
    const key = applyPrefix(ref.prefix, relPath);
    if (typeof source === "object" && source !== null && "__source" in source) {
      const fs = source as FsFileSource;
      if (fs.__source === "fs-file") {
        entries.push({
          key,
          source: fs,
          content_type: fs.contentType,
        });
        continue;
      }
    }
    entries.push({ key, source });
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

/**
 * Build an `AssetManifest` from a `DeployResult`. The gateway plan
 * response is the authoritative source — `result.assets` is populated by
 * `buildAssetManifestFromPlanEntries` in deploy.ts from
 * `plan.asset_entries[].asset_ref`. Throws if the result has no `assets`
 * (which would mean the gateway didn't echo asset_entries — older
 * gateway pre-v1.48 or a release-only apply where the spec carried no
 * assets slice).
 */
function manifestFromResult(
  result: DeployResult,
  pruned: string[] | undefined,
  durationMs: number,
): AssetManifest {
  if (!result.assets) {
    throw new LocalError(
      "Deploy result missing `assets` — gateway plan response did not include asset_entries. Requires gateway v1.48+.",
      "building asset manifest",
    );
  }
  const out: AssetManifest = {
    list: result.assets.list,
    byKey: result.assets.byKey,
    manifest: result.assets.manifest,
    totals: {
      files: result.assets.totals?.files ?? result.assets.list.length,
      bytes_uploaded: result.assets.totals?.bytes_uploaded ?? 0,
      bytes_reused: result.assets.totals?.bytes_reused ?? 0,
      duration_ms: durationMs,
    },
  };
  if (pruned) out.pruned = pruned;
  return out;
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
    return manifestFromResult(result, undefined, Date.now() - start);
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
      return manifestFromResult(result, undefined, Date.now() - start);
    }
    if (!opts.prefix) {
      throw new LocalError(
        "syncDir({ prune: true }) requires an explicit prefix (no implicit project-root prune)",
        "preparing destructive asset sync",
      );
    }
    if (!opts.confirm) {
      // Run a plan to obtain the gateway-computed base_revision +
      // delete_set_digest + sample of planned-delete keys (design D10).
      // The plan response carries an `asset_sync` block when the spec
      // declares destructive sync; we surface its values via the typed
      // PruneConfirmationRequired error so the caller can present them
      // to a user, then retry with `confirm: {...}` populated.
      const { plan } = await this.applyEngine().plan(
        {
          project: opts.project,
          assets: {
            put: entries,
            sync: { prefix: opts.prefix, prune: true },
          },
        } as ReleaseSpec,
        { dryRun: true },
      );
      const block = (plan as { asset_sync?: {
        prefix: string;
        prune: true;
        base_revision: string;
        delete_set_digest: string;
        expected_delete_count: number;
        sample_keys: string[];
        over_inline_threshold: boolean;
      } }).asset_sync;
      throw new PruneConfirmationRequired({
        base_revision: block?.base_revision ?? "",
        delete_set_digest: block?.delete_set_digest ?? "",
        expected_delete_count: block?.expected_delete_count ?? 0,
        sample_keys: block?.sample_keys ?? [],
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
    return manifestFromResult(
      result,
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
    // Plan-only via the engine — the gateway resolves URLs at plan time
    // (URLs are deterministic from `(project_public_id, key,
    // content_sha256)` per design D8). The caller renders HTML against
    // these resolved URLs, then calls `apply()` with the returned
    // `applySlice` to commit. We return the original input entries (with
    // sources retained) as the applySlice so the SDK normalizer can
    // register byte readers when the caller commits.
    const { plan } = await this.applyEngine().plan(
      { project: opts.project, assets: { put: entries } } as ReleaseSpec,
      { dryRun: true },
    );
    const planEntries = plan.asset_entries ?? [];
    const list: AssetManifestEntry[] = [];
    const byKey: Record<string, AssetManifestEntry> = Object.create(null);
    const manifest: Record<string, AssetManifestEntry> = Object.create(null);
    for (const entry of planEntries) {
      const e: AssetManifestEntry = {
        key: entry.key,
        sha256: entry.sha256,
        size_bytes: entry.size_bytes,
        content_type: entry.content_type,
        visibility: entry.visibility,
        url: entry.asset_ref.url,
        immutable_url: entry.asset_ref.immutable_url,
        cdn_url: entry.asset_ref.cdn_url,
        cdn_immutable_url: entry.asset_ref.cdn_immutable_url,
        sri: entry.asset_ref.sri,
        etag: entry.asset_ref.etag,
        content_digest: entry.asset_ref.content_digest,
      };
      list.push(e);
      byKey[entry.key] = e;
      manifest[entry.key] = e;
    }
    return {
      manifest: {
        list,
        byKey,
        manifest,
        totals: {
          files: planEntries.length,
          bytes_uploaded: 0,
          bytes_reused: 0,
          duration_ms: Date.now() - start,
        },
      },
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
    const entries: AssetPutEntryInput[] = items.map((item) => ({
      key: item.key,
      source: item.source,
      content_type: item.contentType,
      visibility: item.visibility,
      immutable: item.immutable,
    }));
    const result = await this.applyEngine().apply(
      { project: opts.project, assets: { put: entries } },
      { onEvent: opts.onEvent },
    );
    return manifestFromResult(result, undefined, Date.now() - start);
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
