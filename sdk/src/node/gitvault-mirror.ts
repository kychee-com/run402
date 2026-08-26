/**
 * gitvault-mirror-and-recover — the mirror writer + reconcile/sync engine +
 * capture-time dual-push hook (design D1/D6/D7, tasks 2.2–2.4).
 *
 * ADMISSION-ORDER WRITE DISCIPLINE (D1's whole point). The gateway's objects
 * listing (`GET /gitvault/v1/vaults/:vault_id/objects`) is a flat, unordered
 * set of `{key, object_kind, sha256, size_bytes}` — it does not group objects
 * by generation. The correct, SUFFICIENT ordering rule does not need that
 * grouping: write EVERY plain object first (any order among themselves — a
 * WAL pack, a checkpoint pack, a prune intent never depend on one another),
 * THEN write every `admissions/<gen>` and `head/<gen>` pair, interleaved and
 * strictly ascending by generation, admission always immediately before its
 * head. Any interruption therefore lands the mirror in one of exactly two
 * shapes:
 *   - mid-objects: no admission/head has been written yet, so nothing in the
 *     mirror references anything absent — a completely inert, valid state
 *     (recovery just sees the mirror's newest COMPLETE prior generation, if
 *     any was mirrored on an earlier pass).
 *   - mid-admissions/heads at generation K: every object is present (phase
 *     one finished), every generation < K is fully written (admission +
 *     head), and K itself has AT MOST its admission record without its head
 *     — which recovery reads exactly as "the mirror's newest generation is
 *     K-1", a completely ordinary and valid earlier state (protocol §5A step
 *     4: a record existing without its head PUT is a normal in-flight shape,
 *     never corruption).
 * This is exactly the "torn mirror ≡ some earlier valid generation" property
 * design D1 requires, and it needs no per-generation object grouping to prove.
 *
 * Read path: `GET …/objects` (paginated) for the listing, then the SAME
 * presigned-read machinery the SDK's publication module uses for live pushes
 * (`POST …/object-reads` for object-kind reads, `GET …/heads/:gen` /
 * `GET …/admissions/:gen` for the two generation-addressed raw-byte routes) —
 * reimplemented here as a THIN, self-contained reader (not exported from
 * `gitvault-publication.ts`, which keeps those helpers module-private) so
 * this file has no dependency on the live-push module and works from nothing
 * but a `Client` + `repo_id`.
 */
import { createHash } from "node:crypto";
import type { Client } from "../kernel.js";
import { LocalError, isRun402Error } from "../errors.js";
import {
  GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
  GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
} from "../namespaces/gitvault.crypto.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { formatMirrorDestination, readMirrorConfig, type GitvaultMirrorConfig } from "./gitvault-mirror-config.js";
import { openGitvaultMirrorBackend, resolveMirrorCredentials, type GitvaultMirrorBackend } from "./gitvault-mirror-backend.js";

function fail(code: string, message: string, context: string, details?: unknown, nextActions?: unknown[]): never {
  throw new LocalError(message, context, { code, details, ...(nextActions ? { next_actions: nextActions } : {}) });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ─── The vault objects listing (task 1.2's client half) ───────────────────────

export interface GitvaultObjectEntry {
  key: string;
  object_kind: string;
  sha256: string;
  size_bytes: string;
}

interface VaultObjectsPage {
  repo_id: string;
  objects: GitvaultObjectEntry[];
  has_more: boolean;
  next_cursor: string | null;
}

/** Page through `GET /gitvault/v1/vaults/:vault_id/objects`, collecting every entry. Store-and-echo cursor per D3a — never parsed here either. */
export async function listGitvaultObjectsAll(client: Client, repoId: string): Promise<GitvaultObjectEntry[]> {
  const base = `/gitvault/v1/vaults/${encodeURIComponent(repoId)}/objects`;
  const out: GitvaultObjectEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await client.request<VaultObjectsPage>(`${base}${qs}`, { context: "listing gitvault vault objects" });
    out.push(...page.objects);
    if (!page.has_more) break;
    if (!page.next_cursor) fail("GITVAULT_MIRROR_LISTING_INCONSISTENT", "the objects listing reported has_more with no next_cursor", "listing gitvault vault objects");
    cursor = page.next_cursor;
  }
  return out;
}

/** Read one object's bytes by key, using the same wire identity every stored kind already carries (§3 layout). `null` when the gateway reports the object absent. */
export async function readGitvaultObjectBytes(client: Client, repoId: string, entry: GitvaultObjectEntry): Promise<Uint8Array | null> {
  const base = `/gitvault/v1/vaults/${encodeURIComponent(repoId)}`;
  const generationRoute = generationRouteForKey(entry.key);
  if (generationRoute) {
    const path = `${base}/${generationRoute.route}/${encodeURIComponent(generationRoute.generation)}`;
    const auth = (await client.credentials.getAuth(path, { method: `gitvault.read_${generationRoute.route}` })) ?? {};
    const r = await client.fetch(`${client.apiBase}${path}`, { method: "GET", headers: { ...auth, accept: "application/json" } });
    if (r.status === 404) return null;
    if (!r.ok) fail("GITVAULT_MIRROR_READ_FAILED", `${entry.key} read failed (HTTP ${r.status})`, "reading gitvault mirror source object", { key: entry.key, status: r.status });
    return new Uint8Array(await r.arrayBuffer());
  }
  const read = objectReadRequestForEntry(entry);
  let presigned: { reads: Array<{ url: string }> };
  try {
    presigned = await client.request(`${base}/object-reads`, { method: "POST", body: { objects: [read] }, context: "resolving gitvault mirror source object" });
  } catch (e) {
    if (isRun402Error(e) && ((e as { status?: number }).status === 404 || (e as { code?: string }).code === "RESOURCE_NOT_FOUND")) return null;
    throw e;
  }
  const target = presigned.reads[0];
  if (!target) return null;
  const r = await client.fetch(target.url, { method: "GET" });
  if (r.status === 404) return null;
  if (!r.ok) fail("GITVAULT_MIRROR_READ_FAILED", `${entry.key} GET failed (HTTP ${r.status})`, "reading gitvault mirror source object", { key: entry.key, status: r.status });
  return new Uint8Array(await r.arrayBuffer());
}

function generationRouteForKey(key: string): { route: "heads" | "admissions"; generation: string } | null {
  const head = /^head\/([0-9a-f]{16})$/.exec(key);
  if (head) return { route: "heads", generation: head[1]! };
  const adm = /^admissions\/([0-9a-f]{16})$/.exec(key);
  if (adm) return { route: "admissions", generation: adm[1]! };
  return null;
}

/** `key_envelope` is path-addressed by `(epoch, recipient_fingerprint)`, not a plain object_id — every other kind uses its object_id, read straight from the key's own filename. */
function objectReadRequestForEntry(entry: GitvaultObjectEntry): { object_kind: string; object_id?: string; epoch?: string; recipient_fingerprint?: string } {
  if (entry.object_kind === "key_envelope") {
    // `envelopes/<epoch>/<recipient_fingerprint>` — matches the SDK's own
    // already-shipped storage-key convention (`gitvault-creation-journal.ts`).
    const m = /^envelopes\/([0-9a-f]{16})\/(ek_[0-9a-f]{32})$/.exec(entry.key);
    if (!m) fail("GITVAULT_MIRROR_KEY_UNRECOGNIZED", `key_envelope key does not match the expected layout: ${entry.key}`, "building gitvault mirror read request", { key: entry.key });
    return { object_kind: "key_envelope", epoch: m[1]!, recipient_fingerprint: m[2]! };
  }
  const m = /([a-z0-9_]+_[0-9a-f]{32})/.exec(entry.key);
  const objectId = m ? m[1]! : entry.key;
  return { object_kind: entry.object_kind, object_id: objectId };
}

// ─── Admission-order planning ──────────────────────────────────────────────────

export interface GitvaultMirrorWritePlan {
  /** Every non-head, non-admission entry, in listing order — write these FIRST, in any order among themselves. */
  objects: GitvaultObjectEntry[];
  /** Then admission records and heads, interleaved, strictly ascending by generation (admission before its own head). */
  admissionsAndHeads: GitvaultObjectEntry[];
}

/** Sort a flat listing into the admission-order write plan (module doc above). */
export function planMirrorWrite(entries: readonly GitvaultObjectEntry[]): GitvaultMirrorWritePlan {
  const objects: GitvaultObjectEntry[] = [];
  const byGeneration = new Map<string, { admission?: GitvaultObjectEntry; head?: GitvaultObjectEntry }>();
  for (const e of entries) {
    const route = generationRouteForKey(e.key);
    if (!route) {
      objects.push(e);
      continue;
    }
    const slot = byGeneration.get(route.generation) ?? {};
    if (route.route === "admissions") slot.admission = e;
    else slot.head = e;
    byGeneration.set(route.generation, slot);
  }
  const generations = [...byGeneration.keys()].sort();
  const admissionsAndHeads: GitvaultObjectEntry[] = [];
  for (const gen of generations) {
    const slot = byGeneration.get(gen)!;
    if (slot.admission) admissionsAndHeads.push(slot.admission);
    if (slot.head) admissionsAndHeads.push(slot.head);
  }
  return { objects, admissionsAndHeads };
}

// ─── Reconcile / sync ───────────────────────────────────────────────────────────

export interface GitvaultMirrorCopyResult {
  key: string;
  outcome: "copied" | "already_present" | "failed";
  size_bytes?: string;
  error?: string;
}

export interface GitvaultMirrorSyncSummary {
  repo_id: string;
  destination: string;
  /** Faithful counts of what ACTUALLY happened this call — never an estimate (design D3a rider (e)). */
  objects_listed: number;
  objects_copied: number;
  objects_already_present: number;
  objects_failed: number;
  bytes_copied: string;
  errors: Array<{ key: string; error: string }>;
  validity_not_freshness: typeof GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT;
  keystore_still_required: typeof GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT;
}

/** Copy one entry (presigned GET → hash-verify → mirror create-only PUT) if the mirror does not already hold it at the same size. Idempotent: a matching size is treated as already-present WITHOUT a hash check (D7 — "hash-verified on copy" means on copy, not on every skip); a size mismatch re-copies and hash-verifies. */
async function reconcileOne(client: Client, repoId: string, backend: GitvaultMirrorBackend, entry: GitvaultObjectEntry): Promise<GitvaultMirrorCopyResult> {
  try {
    const existing = await backend.head(entry.key);
    if (existing && existing.size_bytes === entry.size_bytes) {
      return { key: entry.key, outcome: "already_present" };
    }
    const bytes = await readGitvaultObjectBytes(client, repoId, entry);
    if (!bytes) return { key: entry.key, outcome: "failed", error: "the source no longer serves this object (listed but unreadable)" };
    const hash = sha256Hex(bytes);
    if (hash !== entry.sha256) {
      return { key: entry.key, outcome: "failed", error: `hash mismatch on copy: expected ${entry.sha256}, got ${hash}` };
    }
    const put = await backend.putCreateOnly(entry.key, bytes);
    if (!put.created) {
      // A concurrent writer (another sync, or the dual-push hook) won the
      // create-only race — benign; the mirror now holds SOME valid bytes at
      // this key, and re-checking their size closes the loop honestly.
      const after = await backend.head(entry.key);
      if (after && after.size_bytes === entry.size_bytes) return { key: entry.key, outcome: "already_present" };
      return { key: entry.key, outcome: "failed", error: "mirror key already exists with a different size — refusing to overwrite (content-addressed keys should never collide; investigate)" };
    }
    return { key: entry.key, outcome: "copied", size_bytes: entry.size_bytes };
  } catch (e) {
    return { key: entry.key, outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

export interface GitvaultMirrorSyncOptions {
  keystore?: GitvaultKeystore;
  /** Test/advanced hook: an already-opened backend, bypassing config resolution. */
  backend?: GitvaultMirrorBackend;
}

/**
 * `run402 gitvault mirror sync` (task 2.3): list the vault's stored objects,
 * diff against the mirror by key+size, fetch and hash-verify what's missing,
 * write it in admission order. Resumable and idempotent — running it twice in
 * a row with nothing new copies nothing the second time.
 */
export async function mirrorSync(client: Client, repoId: string, options: GitvaultMirrorSyncOptions = {}): Promise<GitvaultMirrorSyncSummary> {
  const keystore = options.keystore ?? GitvaultKeystore.open();
  const backend = options.backend ?? openBackendFromConfig(keystore, repoId);
  const config = readMirrorConfig(keystore, repoId);
  const destination = options.backend ? backend.describe() : formatMirrorDestination(config!.destination);

  const entries = await listGitvaultObjectsAll(client, repoId);
  const plan = planMirrorWrite(entries);
  const ordered = [...plan.objects, ...plan.admissionsAndHeads];

  let copied = 0;
  let already = 0;
  let failed = 0;
  let bytesCopied = 0n;
  const errors: Array<{ key: string; error: string }> = [];
  for (const entry of ordered) {
    const result = await reconcileOne(client, repoId, backend, entry);
    if (result.outcome === "copied") {
      copied += 1;
      bytesCopied += BigInt(entry.size_bytes);
    } else if (result.outcome === "already_present") {
      already += 1;
    } else {
      failed += 1;
      errors.push({ key: result.key, error: result.error ?? "unknown failure" });
    }
  }

  return {
    repo_id: repoId,
    destination,
    objects_listed: entries.length,
    objects_copied: copied,
    objects_already_present: already,
    objects_failed: failed,
    bytes_copied: bytesCopied.toString(),
    errors,
    validity_not_freshness: GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
    keystore_still_required: GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
  };
}

function openBackendFromConfig(keystore: GitvaultKeystore, repoId: string): GitvaultMirrorBackend {
  const config = readMirrorConfig(keystore, repoId);
  if (!config) fail("GITVAULT_MIRROR_NOT_CONFIGURED", `no mirror is configured for ${repoId}`, "opening gitvault mirror", { repo_id: repoId }, [{ action: "run402 gitvault mirror set <destination>" }]);
  if (config.destination.kind === "s3" && config.credential) {
    // Fail fast on a missing/misconfigured credential BEFORE any network call,
    // so a sync's error names the credential problem instead of a confusing
    // downstream 403.
    resolveMirrorCredentials(config.credential);
  }
  return openGitvaultMirrorBackend(config.destination, repoId, config.credential);
}

// ─── Capture-time dual-push hook (task 2.4, design D6) ─────────────────────────

export interface GitvaultMirrorPushResult {
  attempted: boolean;
  outcome: "pushed" | "skipped_no_mirror" | "failed";
  summary?: GitvaultMirrorSyncSummary;
  error?: string;
}

/**
 * Fires after an ordinary vault push/deploy produces a new generation. NEVER
 * throws and NEVER alters the caller's deploy/push outcome (design D6) — a
 * mirror is strictly extra durability, and its failure is reported BESIDE the
 * vault result as a distinct line, not folded into it. Fires only when a
 * mirror is configured for this vault; a vault with no mirror gets
 * `skipped_no_mirror` (not an error) so callers can log it uniformly without
 * branching on whether mirroring was ever opted into.
 *
 * Implemented as a full (but INCREMENTAL, idempotent) sync rather than a
 * push-scoped upload: the objects listing + diff-by-size machinery already
 * makes an all-caught-up sync cheap (one listing page, zero copies), and this
 * keeps the admission-order write discipline in exactly one place instead of
 * a second, push-scoped code path that could drift from it.
 */
export async function mirrorPushForGeneration(client: Client, repoId: string, options: GitvaultMirrorSyncOptions = {}): Promise<GitvaultMirrorPushResult> {
  let keystore: GitvaultKeystore;
  try {
    keystore = options.keystore ?? GitvaultKeystore.open();
    if (!options.backend && !readMirrorConfig(keystore, repoId)) {
      return { attempted: false, outcome: "skipped_no_mirror" };
    }
  } catch (e) {
    return { attempted: false, outcome: "skipped_no_mirror", error: e instanceof Error ? e.message : String(e) };
  }
  try {
    const summary = await mirrorSync(client, repoId, { ...options, keystore });
    return { attempted: true, outcome: summary.objects_failed > 0 ? "failed" : "pushed", summary };
  } catch (e) {
    return { attempted: true, outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}
