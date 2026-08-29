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
 *
 * MIRROR LAYOUT (task 5.3 fix — do not lose this again). The gateway's real
 * bucket key for every stored artifact is FULLY QUALIFIED under the vault's
 * own prefix (`storage-keys.ts` `vaultPrefix`): `source/<repo_id>/<rest>`,
 * confirmed live 2026-08-26 (`gitvault-mirror-drill.mjs` against
 * `api.run402.com`). The gateway's own `GET …/objects` listing (task 1.2)
 * echoes that FULL key back on every entry — it never returns a
 * repo-relative key. This module's own working representation, and the
 * mirror BACKEND's key space (`gitvault-mirror-backend.ts`
 * `openGitvaultMirrorBackend`, whose `root`/`prefix` already bake in
 * `source/<repo_id>`), are both REPO-RELATIVE (`head/<gen>`,
 * `wal/<id>.pack.enc`, `key-envelopes/<epoch>/<fp>.env`, …) — the same shape
 * `gitvault-recover.ts` and `gitvault-publication.ts`'s `gitvaultPaths`
 * already use. The mapping is therefore, in ONE place:
 *
 *   bucket key  =  `source/<repo_id>/` + mirror key (repo-relative)
 *
 * `listGitvaultObjectsAll` is the ONLY function that ever sees a full,
 * `source/<repo_id>/`-prefixed key (the raw wire shape, typed
 * `RawVaultObjectEntry` below) — it strips the prefix via
 * `stripSourcePrefix` before anything else in this module (or in
 * `gitvault-recover.ts`, which never talks to the live gateway at all) sees
 * the entry. Every `GitvaultObjectEntry` handed to `generationRouteForKey`,
 * `objectReadRequestForEntry`, `planMirrorWrite`, `reconcileOne`, and the
 * `GitvaultMirrorBackend` itself is repo-relative from that point on. An
 * entry whose key names a DIFFERENT repo id than the one being synced is a
 * listing-isolation violation and is refused loudly (never silently
 * stripped-and-kept or silently dropped) — see `stripSourcePrefix`.
 *
 * Two chain kinds are part of this SAME listing (the pre-fix gateway omitted
 * them entirely, which was task 5.3 finding (a); the listing now includes
 * them end to end), both fetched via the exact-bytes generation routes
 * (`.../heads/:generation`, `.../admissions/:generation`), never through
 * `object-reads`:
 *   - `head/<generation>` — `object_kind: "head"` for every ordinary
 *     generation, but the GENESIS entry at generation `0000000000000000`
 *     carries `object_kind: "vault_genesis"` (the ledger's own
 *     `admitted_object_kind`) instead. Both route through the SAME
 *     `.../heads/:generation` fetch — the kind distinguishes the CONTENT,
 *     not the route.
 *   - `admissions/<generation>` — `object_kind: "admission_record"` at
 *     EVERY generation, including genesis (genesis has an admission record
 *     too).
 * `size_bytes` is an EXACT decimal string for every kind, including these
 * two (the ledger enforces the admitted byte count via CHECK constraints and
 * the gateway serves it as `octet_length`) — never `null`. `reconcileOne`
 * still diffs by size first (cheap) and hash-verifies on every actual copy
 * (belt-and-suspenders, unconditional — never skipped just because a size
 * happened to match).
 */
import { createHash } from "node:crypto";
import type { Client } from "../kernel.js";
import { LocalError, isRun402Error } from "../errors.js";
import {
  GITVAULT_GENESIS_GENERATION,
  GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
  GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
} from "../namespaces/gitvault.crypto.js";
import { fetchGitvaultObjectBytes } from "./gitvault-edge-fetch.js";
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

/**
 * REPO-RELATIVE — the `source/<repo_id>/` prefix has already been stripped
 * (see the module doc's mirror-layout mapping). This is the shape every
 * OTHER function in this module, `gitvault-recover.ts`, and the mirror
 * backend interface all consume; nothing here ever sees the raw wire key
 * except `listGitvaultObjectsAll` itself.
 *
 * `size_bytes` is an exact decimal string for EVERY kind, including the two
 * generation-addressed chain kinds (`head`/`vault_genesis` at generation
 * zero, `admission_record`) — never `null`.
 */
export interface GitvaultObjectEntry {
  key: string;
  object_kind: string;
  sha256: string;
  size_bytes: string;
}

/** The WIRE shape of one listing entry, exactly as the gateway's `GET …/objects` returns it — `key` is FULLY QUALIFIED under `source/<repo_id>/`. Never leaves `listGitvaultObjectsAll`. */
interface RawVaultObjectEntry {
  key: string;
  object_kind: string;
  sha256: string;
  size_bytes: string;
}

interface VaultObjectsPage {
  repo_id: string;
  objects: RawVaultObjectEntry[];
  has_more: boolean;
  next_cursor: string | null;
}

/** protocol §3 (`storage-keys.ts` `GITVAULT_SOURCE_PREFIX`) — duplicated here because the SDK carries no dependency on the gateway package. */
const GITVAULT_SOURCE_PREFIX = "source";

/**
 * Turn one WIRE key (`source/<repo_id>/<rest>`) into the REPO-RELATIVE key
 * every other function in this module expects. A key naming a DIFFERENT repo
 * id than the one being synced is a listing-isolation violation — refused
 * loudly rather than silently stripped-and-kept (it could only mean a
 * gateway bug or a cross-tenant data leak, and a partial sync that quietly
 * dropped it would misreport as a clean success). A key with no `source/`
 * prefix at all is a listing-shape violation of the same severity.
 */
function stripSourcePrefix(repoId: string, key: string): string {
  const expected = `${GITVAULT_SOURCE_PREFIX}/${repoId}/`;
  if (key.startsWith(expected)) return key.slice(expected.length);
  const foreign = /^source\/([^/]+)\//.exec(key);
  if (foreign) {
    fail(
      "GITVAULT_MIRROR_FOREIGN_REPO_KEY",
      `the objects listing for ${repoId} returned a key addressed to a different vault (${foreign[1]!}): ${key}`,
      "listing gitvault vault objects",
      { key, repo_id: repoId, foreign_repo_id: foreign[1] },
    );
  }
  fail("GITVAULT_MIRROR_LISTING_INCONSISTENT", `listed key is not in the expected source/<repo_id>/… layout: ${key}`, "listing gitvault vault objects", { key, repo_id: repoId });
}

/** Page through `GET /gitvault/v1/vaults/:vault_id/objects`, collecting every entry, stripped to repo-relative keys. Store-and-echo cursor per D3a — never parsed here either. */
export async function listGitvaultObjectsAll(client: Client, repoId: string): Promise<GitvaultObjectEntry[]> {
  const base = `/gitvault/v1/vaults/${encodeURIComponent(repoId)}/objects`;
  const out: GitvaultObjectEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await client.request<VaultObjectsPage>(`${base}${qs}`, { context: "listing gitvault vault objects" });
    for (const raw of page.objects) {
      out.push({ key: stripSourcePrefix(repoId, raw.key), object_kind: raw.object_kind, sha256: raw.sha256, size_bytes: raw.size_bytes });
    }
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
    // Defense in depth: the key SHAPE alone is enough to route the read, but
    // cross-checking the listing's own declared object_kind catches a
    // mislabeled entry (gateway bug) loudly instead of silently reading the
    // wrong thing under the right generation. `admissions/<gen>` is always
    // `admission_record`; `head/<gen>` is `vault_genesis` ONLY at generation
    // zero and `head` at every later generation — the kind names the
    // CONTENT, both fetch through the same route.
    const expectedKind =
      generationRoute.route === "admissions" ? "admission_record" : generationRoute.generation === GITVAULT_GENESIS_GENERATION ? "vault_genesis" : "head";
    if (entry.object_kind !== expectedKind) {
      fail(
        "GITVAULT_MIRROR_KEY_UNRECOGNIZED",
        `listed object_kind '${entry.object_kind}' does not match its generation-addressed key ${entry.key} (expected '${expectedKind}')`,
        "reading gitvault mirror source object",
        { key: entry.key, object_kind: entry.object_kind, expected_object_kind: expectedKind },
      );
    }
    const path = `${base}/${generationRoute.route}/${encodeURIComponent(generationRoute.generation)}`;
    const auth = (await client.credentials.getAuth(path, { method: `gitvault.read_${generationRoute.route}` })) ?? {};
    const r = await client.fetch(`${client.apiBase}${path}`, { method: "GET", headers: { ...auth, accept: "application/json" } });
    if (r.status === 404) return null;
    if (!r.ok) fail("GITVAULT_MIRROR_READ_FAILED", `${entry.key} read failed (HTTP ${r.status})`, "reading gitvault mirror source object", { key: entry.key, status: r.status });
    return new Uint8Array(await r.arrayBuffer());
  }
  const read = objectReadRequestForEntry(entry);
  // `edge_url` (gitvault-read-edge-cache design D5) is the same optional,
  // same-bytes CDN companion `gitvault-publication.ts`'s object-reads
  // consumers get — see `fetchGitvaultObjectBytes` (`gitvault-edge-fetch.ts`)
  // for the prefer-edge/silent-fallback policy shared across both.
  let presigned: { reads: Array<{ url: string; edge_url?: string }> };
  try {
    presigned = await client.request(`${base}/object-reads`, { method: "POST", body: { objects: [read] }, context: "resolving gitvault mirror source object" });
  } catch (e) {
    if (isRun402Error(e) && ((e as { status?: number }).status === 404 || (e as { code?: string }).code === "RESOURCE_NOT_FOUND")) return null;
    throw e;
  }
  const target = presigned.reads[0];
  if (!target) return null;
  const r = await fetchGitvaultObjectBytes(client, target);
  if (r.status === 404) return null;
  if (!r.ok) fail("GITVAULT_MIRROR_READ_FAILED", `${entry.key} GET failed (HTTP ${r.status})`, "reading gitvault mirror source object", { key: entry.key, status: r.status });
  return new Uint8Array(await r.arrayBuffer());
}

/** Exported for the key-shape conformance test (`gitvault-mirror-recover.test.ts`) — never called for its own sake outside this module. */
export function generationRouteForKey(key: string): { route: "heads" | "admissions"; generation: string } | null {
  const head = /^head\/([0-9a-f]{16})$/.exec(key);
  if (head) return { route: "heads", generation: head[1]! };
  const adm = /^admissions\/([0-9a-f]{16})$/.exec(key);
  if (adm) return { route: "admissions", generation: adm[1]! };
  return null;
}

/**
 * Repo-relative key shapes for every id-addressed, non-generation-addressed
 * kind (`storage-keys.ts` `objectKeyFor` + `upload-sessions.ts`
 * `UPLOADABLE_KINDS`, mirrored here since the SDK has no dependency on the
 * gateway package). ANCHORED (`^…$`) on purpose — the bug this table
 * replaces (task 5.3 finding (b)) was an UNANCHORED fallback regex that
 * greedily matched the REPO ID itself (`src_<32hex>` satisfies the same
 * `[a-z0-9_]+_[0-9a-f]{32}` shape as a real object id) out of a
 * `source/<repo_id>/…` key, sending the wrong object_id to the gateway.
 * Keyed by the listing's own declared `object_kind` (trusted metadata from
 * the gateway) — the pattern then both extracts the id AND validates that
 * the key's shape actually matches its declared kind.
 */
const NON_GENERATION_KEY_SPECS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "wal_pack", pattern: /^wal\/(wal_[0-9a-f]{32})\.pack\.enc$/ },
  { kind: "ref_state", pattern: /^refs\/(refs_[0-9a-f]{32})\.enc$/ },
  { kind: "retention_roots", pattern: /^retention\/(rr_[0-9a-f]{32})\.enc$/ },
  { kind: "checkpoint_manifest", pattern: /^checkpoints\/(chk_[0-9a-f]{32})\.manifest\.enc$/ },
  { kind: "checkpoint_pack", pattern: /^checkpoints\/(ckp_[0-9a-f]{32})\.pack\.enc$/ },
  { kind: "checkpoint_claim_set", pattern: /^checkpoints\/(ccs_[0-9a-f]{32})\.claims\.json$/ },
  { kind: "maintenance_stage_claim_set", pattern: /^maintenance\/(msc_[0-9a-f]{32})\.stage\.json$/ },
  { kind: "maintenance_stage_page", pattern: /^maintenance\/(msp_[0-9a-f]{32})\.page\.json$/ },
  { kind: "maintenance_completion_cut", pattern: /^maintenance\/cuts\/(adm_[0-9a-f]{32})\.json$/ },
  { kind: "retention_cutoff", pattern: /^retention\/(rc_[0-9a-f]{32})\.ticket\.json$/ },
  { kind: "prune_intent", pattern: /^prune\/(pi_[0-9a-f]{32})\.intent\.json$/ },
  // prune_completion is filed under the INTENT's own object_id (storage-keys.ts
  // `pruneCompletionKey`) — its key literally carries a `pi_…` id, not `pc_…`.
  { kind: "prune_completion", pattern: /^prune\/(pi_[0-9a-f]{32})\.completion\.json$/ },
  { kind: "verifier_receipt", pattern: /^verifier-receipts\/(vr_[0-9a-f]{32})\.json$/ },
  { kind: "maintenance_cycle_issuance", pattern: /^maintenance\/issued\/(mc_[0-9a-f]{32})\.json$/ },
  { kind: "maintenance_cycle_terminal", pattern: /^maintenance\/terminals\/(mc_[0-9a-f]{32})\.terminal\.json$/ },
];

/**
 * `key_envelope` is path-addressed by `(epoch, recipient_fingerprint)`, not a
 * plain object_id — every other kind uses its object_id, read straight from
 * the key's own filename via an ANCHORED, kind-specific pattern (never a
 * loose, unanchored fallback — see {@link NON_GENERATION_KEY_SPECS}).
 * Exported for the key-shape conformance test.
 */
export function objectReadRequestForEntry(entry: GitvaultObjectEntry): { object_kind: string; object_id?: string; epoch?: string; recipient_fingerprint?: string } {
  if (entry.object_kind === "key_envelope") {
    // `key-envelopes/<epoch>/<recipient_fingerprint>.env` — the GATEWAY's
    // real §3 wire key (`packages/gateway/src/services/gitvault/
    // upload-sessions.ts` `UPLOADABLE_KINDS.key_envelope.key()`, mirrored by
    // `storage-keys.ts` `objectKeyFor`). This is what the live objects
    // listing actually returns, and is DIFFERENT from the SDK's own
    // `gitvault-creation-journal.ts` envelope `path` string
    // (`envelopes/<epoch>/<fp>`, no `key-` prefix, no `.env` suffix) — that
    // string is CLIENT-LOCAL addressing for the upload manifest only ("never
    // rides the wire", per its own doc comment); the gateway derives its own
    // key independently and never echoes the client's `path` back. Do not
    // re-derive this from that SDK constant.
    const m = /^key-envelopes\/([0-9a-f]{16})\/(ek_[0-9a-f]{32})\.env$/.exec(entry.key);
    if (!m) fail("GITVAULT_MIRROR_KEY_UNRECOGNIZED", `key_envelope key does not match the expected layout: ${entry.key}`, "building gitvault mirror read request", { key: entry.key });
    return { object_kind: "key_envelope", epoch: m[1]!, recipient_fingerprint: m[2]! };
  }
  const spec = NON_GENERATION_KEY_SPECS.find((s) => s.kind === entry.object_kind);
  if (!spec) {
    fail("GITVAULT_MIRROR_KEY_UNRECOGNIZED", `unrecognized object_kind '${entry.object_kind}' for mirror read (key ${entry.key})`, "building gitvault mirror read request", { key: entry.key, object_kind: entry.object_kind });
  }
  const m = spec.pattern.exec(entry.key);
  if (!m) fail("GITVAULT_MIRROR_KEY_UNRECOGNIZED", `${entry.object_kind} key does not match the expected §3 layout: ${entry.key}`, "building gitvault mirror read request", { key: entry.key, object_kind: entry.object_kind });
  return { object_kind: entry.object_kind, object_id: m[1]! };
}

/**
 * Task 5.3 follow-up (found via the live drill 2026-08-26, gateway diagnosis
 * confirmed correct — NOT a bug): the recipient-only read gate on
 * `key_envelope` means a mirror can only ever hold envelopes wrapped for
 * THIS machine's own identity. A multi-recipient vault (gitvault-human-
 * envelopes) makes a foreign-recipient envelope the NORM, not an anomaly —
 * it must never be synced as a failure. This extracts the `ek_` fingerprint
 * straight from the key_envelope's own key (no network round-trip needed to
 * classify it), reusing the exact pattern `objectReadRequestForEntry` uses;
 * `null` for a key that doesn't match the expected layout at all (a real,
 * separate problem — that case falls through to the normal read-and-fail
 * path so `GITVAULT_MIRROR_KEY_UNRECOGNIZED` still surfaces).
 */
function keyEnvelopeRecipientFingerprintFromKey(key: string): string | null {
  const m = /^key-envelopes\/[0-9a-f]{16}\/(ek_[0-9a-f]{32})\.env$/.exec(key);
  return m ? m[1]! : null;
}

/** The local keystore's own `ek_` fingerprint, or `null` when no identity exists on this machine (keyless / never-`gitvault init`-ed). */
function localEncryptionFingerprint(keystore: GitvaultKeystore): string | null {
  return keystore.readIdentity()?.encryption_fingerprint ?? null;
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
  outcome: "copied" | "already_present" | "skipped_foreign_recipient" | "failed";
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
  /**
   * Task 5.3 follow-up: a `key_envelope` wrapped for a DIFFERENT recipient
   * than this machine's own identity — EXPECTED, not a problem. The
   * recipient-only read gate means a mirror can only ever hold envelopes
   * addressed to the local identity; a multi-recipient vault
   * (gitvault-human-envelopes) makes this the norm. Never counted toward
   * `objects_failed`, and never causes `mirror sync` to report anything but
   * success — named per-key in `skipped_foreign_recipient_keys` so a reader
   * can tell "expected skip" from "silent gap" without cross-referencing.
   */
  objects_skipped_foreign_recipient: number;
  skipped_foreign_recipient_keys: string[];
  objects_failed: number;
  bytes_copied: string;
  errors: Array<{ key: string; error: string }>;
  validity_not_freshness: typeof GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT;
  keystore_still_required: typeof GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT;
}

/**
 * Copy one entry (presigned GET → hash-verify → mirror create-only PUT) if
 * the mirror does not already hold it at the same size. Idempotent: a
 * matching size is treated as already-present WITHOUT a hash check (D7 —
 * "hash-verified on copy" means on copy, not on every skip, and applies
 * uniformly to every kind now that `size_bytes` is exact for all of them —
 * see the module doc); a size mismatch re-copies and hash-verifies. Every
 * failure is tagged with its `object_kind` so a sync summary's `errors[]` is
 * self-explaining without cross-referencing the listing (task 5.3's "no
 * per-entry reason surfaced" gap).
 *
 * `ownFingerprint` (task 5.3 follow-up): a `key_envelope` entry addressed to
 * a DIFFERENT recipient is classified `skipped_foreign_recipient` BEFORE any
 * network read is attempted (the fingerprint is parsed straight out of the
 * entry's own key) — never a failure, and never even reaches the gateway,
 * which would correctly 403 it under the recipient-only read gate.
 */
async function reconcileOne(client: Client, repoId: string, backend: GitvaultMirrorBackend, entry: GitvaultObjectEntry, ownFingerprint: string | null): Promise<GitvaultMirrorCopyResult> {
  const kindTag = `[${entry.object_kind}]`;
  if (entry.object_kind === "key_envelope") {
    const fp = keyEnvelopeRecipientFingerprintFromKey(entry.key);
    if (fp !== null && fp !== ownFingerprint) {
      return { key: entry.key, outcome: "skipped_foreign_recipient" };
    }
  }
  try {
    const existing = await backend.head(entry.key);
    if (existing && existing.size_bytes === entry.size_bytes) {
      return { key: entry.key, outcome: "already_present" };
    }
    const bytes = await readGitvaultObjectBytes(client, repoId, entry);
    if (!bytes) return { key: entry.key, outcome: "failed", error: `${kindTag} the source no longer serves this object (listed but unreadable)` };
    const hash = sha256Hex(bytes);
    if (hash !== entry.sha256) {
      return { key: entry.key, outcome: "failed", error: `${kindTag} hash mismatch on copy: expected ${entry.sha256}, got ${hash}` };
    }
    const put = await backend.putCreateOnly(entry.key, bytes);
    if (!put.created) {
      // A concurrent writer (another sync, or the dual-push hook) won the
      // create-only race — benign; the mirror now holds SOME valid bytes at
      // this key, and re-checking their size closes the loop honestly.
      const after = await backend.head(entry.key);
      if (after && after.size_bytes === entry.size_bytes) return { key: entry.key, outcome: "already_present" };
      return { key: entry.key, outcome: "failed", error: `${kindTag} mirror key already exists with a different size — refusing to overwrite (content-addressed keys should never collide; investigate)` };
    }
    return { key: entry.key, outcome: "copied", size_bytes: entry.size_bytes };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { key: entry.key, outcome: "failed", error: message.startsWith(kindTag) ? message : `${kindTag} ${message}` };
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

  const ownFingerprint = localEncryptionFingerprint(keystore);
  const entries = await listGitvaultObjectsAll(client, repoId);
  const plan = planMirrorWrite(entries);
  const ordered = [...plan.objects, ...plan.admissionsAndHeads];

  let copied = 0;
  let already = 0;
  let skippedForeign = 0;
  let failed = 0;
  let bytesCopied = 0n;
  const errors: Array<{ key: string; error: string }> = [];
  const skippedForeignKeys: string[] = [];
  for (const entry of ordered) {
    const result = await reconcileOne(client, repoId, backend, entry, ownFingerprint);
    if (result.outcome === "copied") {
      copied += 1;
      bytesCopied += BigInt(entry.size_bytes);
    } else if (result.outcome === "already_present") {
      already += 1;
    } else if (result.outcome === "skipped_foreign_recipient") {
      skippedForeign += 1;
      skippedForeignKeys.push(result.key);
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
    objects_skipped_foreign_recipient: skippedForeign,
    skipped_foreign_recipient_keys: skippedForeignKeys,
    objects_failed: failed,
    bytes_copied: bytesCopied.toString(),
    errors,
    validity_not_freshness: GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
    keystore_still_required: GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
  };
}

function openBackendFromConfig(keystore: GitvaultKeystore, repoId: string): GitvaultMirrorBackend {
  const config = readMirrorConfig(keystore, repoId);
  if (!config) fail("GITVAULT_MIRROR_NOT_CONFIGURED", `no mirror is configured for ${repoId}`, "opening gitvault mirror", { repo_id: repoId }, [{ action: "run402 repos mirror <destination>" }]);
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
