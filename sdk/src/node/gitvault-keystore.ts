/**
 * gitvault — the principal keystore (protocol rev 41 §5.1; task 5.2).
 *
 * Layout (under the active profile's config dir, beside the project-key cache
 * `core/src/keystore.ts` manages — `RUN402_CONFIG_DIR` / `RUN402_WALLET` aware):
 *
 *   <config>/gitvault/
 *     identity.json                 Ed25519 seed + X25519 private key (0600)
 *     repos/<repo_id>.json          K_repo, trust pin, dual pins, last ref transaction (0600)
 *     repos/<repo_id>.lock/         per-repo lock (mkdir-atomic, 0700)
 *     receipts/<repo_id>.recovery_receipt.json   the recovery receipt (NOT a secret; more copies better)
 *     journal/<client_creation_id>.json          six-stage creation journals (task 5.3)
 *     audit.log                     append-only JSON lines (0600)
 *
 * Discipline (spec: "Writes SHALL be atomic with per-repo locks, no-follow
 * creation, and permission audits"): directories 0700, files 0600, every
 * write = temp file (O_NOFOLLOW|O_EXCL) + fsync + rename + directory fsync,
 * and `auditKeystorePermissions()` runs at open so a world-readable identity
 * is a named finding, never silent.
 *
 * Transitions (protocol §5.1 partial-loss table) are DERIVED by
 * {@link GitvaultKeystore.assess} and acted on by explicit methods — the
 * keystore never guesses:
 *   - repo file lost + identity intact  → `restoreRepoFromEnvelope` (own envelope)
 *   - signing key lost, K_repo held     → `read_only` (clear report)
 *   - stale pin                         → `stale_pin` (re-verify from genesis; 5.4)
 *   - whole keystore lost               → `VAULT_UNRECOVERABLE` (§0, verbatim)
 */

import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../core-dist/config.js";
import { LocalError } from "../errors.js";
import {
  GITVAULT_EK_RE,
  GITVAULT_SRC_RE,
  GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT,
  GITVAULT_TERMINAL_LOSS_STATEMENT,
  GITVAULT_VK_RE,
  bytesToHex,
  checkGenesisKeyBindings,
  checkRecoveryReceipt,
  ekFingerprint,
  formatGitvaultTimestamp,
  generateEncryptionKeypair,
  generateSigningKeypair,
  hexToBytes,
  openKeyEnvelope,
  storedBytesSha256,
  toBase64url,
  verifyGitvaultObject,
  vkFingerprint,
} from "../namespaces/gitvault.crypto.js";
import type {
  GitvaultEncryptionKeypair,
  GitvaultKeyEnvelope,
  GitvaultRecoveryReceipt,
  GitvaultSignedObject,
  GitvaultSigningKeypair,
  GitvaultVaultGenesis,
} from "../namespaces/gitvault.types.js";

// ─── On-disk shapes ──────────────────────────────────────────────────────────

/** `identity.json` — the principal's two private keys. Either half MAY be absent after partial loss. */
export interface GitvaultIdentityFile {
  version: 1;
  /** Ed25519 32-byte seed, lowercase hex. Absent ⇒ the signing key is lost (read-only principal). */
  signing_seed_hex?: string;
  /** Raw Ed25519 public key, base64url. */
  signing_pubkey: string;
  /** `vk_` fingerprint. */
  signing_fingerprint: string;
  /** X25519 32-byte private key, lowercase hex. Absent ⇒ no envelope can be opened. */
  encryption_private_key_hex?: string;
  /** Raw X25519 public key, base64url. */
  encryption_pubkey: string;
  /** `ek_` fingerprint. */
  encryption_fingerprint: string;
  created_at: string;
}

/** The dual pins (protocol §6.4): the newest authenticated head and its generation. */
export interface GitvaultHeadPin {
  generation: string;
  head_sha256: string;
  pinned_at: string;
}

/** `repos/<repo_id>.json` — everything per-vault the principal must not lose. */
export interface GitvaultRepoFile {
  version: 1;
  repo_id: string;
  org_id: string;
  project_id: string;
  /** Raw 32-byte secret for {@link GitvaultRepoFile.epoch} (`K_repo`/`K_1` pre-rotation, `K_e` after one), lowercase hex. */
  k_repo_hex: string;
  /** The current epoch — `0000000000000001` until this vault's first rotation (D194, rev 42); advances on every rotation this principal drove or opened its own envelope for. */
  epoch: string;
  /**
   * D194/D202, rev 42: every symmetric epoch key this principal has EVER
   * locally held, keyed by 16-hex epoch — the substrate `checkFreshEpochKeyAgainstPriorKeys`
   * (D195's inequality obligation) and the full-history-on-join branch (a)
   * (`FULL_VIA_EPOCH_KEYS`) both need. `epoch` -> `k_repo_hex` above is
   * ALWAYS mirrored here too (an entry for the current epoch always
   * exists), so this map alone is sufficient for both purposes — a reader
   * never needs to special-case "the current one lives elsewhere."
   * Absent/`null` for a pre-rotation vault (equivalent to the single
   * `{[epoch]: k_repo_hex}` entry).
   */
  epoch_keys?: Record<string, string> | null;
  /** Trust pin: the admitted genesis stored-bytes hash. */
  genesis_sha256: string;
  /** `highest_authenticated` (§6.4): chain-verified; a listing below it is `GENERATION_REGRESSION`. `null` until the first head is authenticated. */
  head_pin: GitvaultHeadPin | null;
  /** `highest_materialized` (§6.4): decrypted + applied — the ONLY push base. Absent/`null` ⇒ never materialized. */
  materialized_pin?: GitvaultHeadPin | null;
  /** The verified-prefix watermark of a budget-interrupted verification (§9.3 — resumable). Absent/`null` when none is pending. */
  verified_prefix?: GitvaultHeadPin | null;
  /**
   * gitvault-clone-scaling (bench P3): the newest checkpoint coverage this
   * checkout has LOCALLY learned — from pushing a checkpoint-form head,
   * walking past a checkpoint head, a genesis-anchored walk that saw none
   * (proving coverage = genesis), or a restore's checkpoint apply. Feeds
   * the checkpoint-staleness advisory ONLY; absent/`null` means coverage
   * is unknown on this checkout and the advisory stays silent — it is
   * never protocol state and never consulted by verification or restore.
   */
  checkpoint_covers_through?: string | null;
  /**
   * gitvault-object-host-predial (design D1): the object-store ORIGINS
   * (`scheme://host` — never a path, query, key, or credential) this
   * checkout has observed a presigned or edge URL actually served bytes
   * from, most-recently-observed first, deduped, capped at
   * {@link GITVAULT_OBJECT_STORE_ORIGINS_CAP}. Same locally-learned,
   * monotonic-in-usefulness pattern as {@link checkpoint_covers_through}:
   * absent/`null`/`[]` means nothing is known yet (a first-ever session,
   * byte-identical to before this field existed) and is never protocol
   * state — it feeds the connection prewarm ONLY (`predialGitvaultObjectStore`
   * in `gitvault-prewarm.ts`), never verification, never a source of truth
   * for where an object actually lives. A stale entry (bucket migrated)
   * costs at most one harmless background dial and is overwritten by the
   * next observed fetch.
   */
  object_store_origins?: string[];
  /**
   * TOFU pins for {@link GitvaultVault.reconcileEnvelopeRecipients}
   * (gitvault-human-envelopes design D4 point 3): `principal_id ->` the
   * `ek_` fingerprint this repo last wrapped a `key_envelope` for (or
   * observed already covering the vault). A later reconcile whose org
   * directory reports a DIFFERENT fingerprint for the same `principal_id`
   * refuses to wrap under it — a pinned-key change is a refusal, never a
   * silent re-wrap. Absent/`null` until reconcile has run at least once.
   */
  envelope_recipient_pins?: Record<string, string> | null;
  /**
   * The MOST RECENT `recipient_pin_manifest` this principal itself built,
   * signed, and successfully admitted (D197) — via {@link
   * GitvaultVault.publishPinManifestUpdate} or {@link
   * GitvaultVault.rotateEpoch}'s `pending_confirmations` fold. Read-side
   * short-circuit ONLY: {@link GitvaultVault} `readPinManifestObject`
   * consults this before a network `object-reads` round trip, and uses it
   * ONLY when `pin_manifest_version` + `stored_bytes_sha256` match the
   * receipt it is resolving — never as a substitute for verification of a
   * manifest this principal did not itself author (a version/hash mismatch
   * falls through to the network path unchanged). Safe to skip the network
   * fetch + re-verify-own-signature step in the match case: those exact
   * bytes were built with `this.signer()` moments earlier and the upload
   * already round-tripped a checksum-verified PUT, so re-fetching and
   * re-checking our own signature over our own just-authored bytes proves
   * nothing a network failure couldn't ALSO independently fail to prove.
   * Absent/`null` until this principal has published its first manifest.
   */
  known_pin_manifest?: { pin_manifest_version: string; stored_bytes_sha256: string; pins: { principal_id: string; ek_fingerprint: string }[] } | null;
  /**
   * gitvault-multi-writer rev 47 (protocol §4.15) — the writer-set analog of
   * {@link head_pin}: the chain-replayed writer state as of THIS repo's own
   * `head_pin`/`verified_prefix` generation, persisted so `GitvaultVault.verifyToNewest`
   * never has to re-walk the writer set from genesis on every call. Advances
   * in lockstep with `head_pin`/`verified_prefix` — always at the SAME
   * generation, never ahead or behind. `null` until the first `verifyToNewest`
   * call on this checkout (equivalent to the genesis-only singleton, which
   * that call derives for free without needing this field yet).
   */
  writer_set_pin?: { version: string; sha256: string; writers: { writer_key_id: string; signing_pubkey: string }[]; pinned_at: string } | null;
  /**
   * gitvault-multi-writer rev 47 — THIS principal's own relationship to the
   * chain-verified `writer_set_pin` above, as of the last time it was
   * computed (`repos view`/`doctor`/reconcile — task 5.7). `"pending"`: a
   * claimed handoff or a directory publish is waiting on the actual
   * `add_writer_key` push (see `pending_writer_admission` below).
   * `"active"`: this principal's own signing key IS in `writer_set_pin.writers`.
   * `"not_admitted"`: an active, eligible org member whose key has never
   * been added. `"removed"`: a key that WAS a writer and was chain-removed
   * (permanently — see `writer-state.ts`'s `burnedWriterKeyIds`). `null`
   * until first computed (e.g. a checkout with no local signing key at all).
   */
  writer_status?: "pending" | "active" | "not_admitted" | "removed" | null;
  /**
   * gitvault-multi-writer rev 47 (task 5.6) — set by `resume()` the moment a
   * handoff claim response's `writer_admission_grant` is verified and
   * persisted, BEFORE the recipient's own `add_writer_key{"handoff"}`
   * activation push lands on-chain; cleared once that push is admitted
   * (`writer_status` flips to `"active"` at the same time). Surviving this
   * field across a crash is exactly what makes the activation push
   * idempotently resumable (task 5.6's "crash replay") — the grant + the
   * writer_key_id it names are the only state a retry needs, and both are
   * already locally held (the grant was echoed verbatim in the claim
   * response; nothing here is ever re-derived from a network call).
   */
  pending_writer_admission?: { handoff_id: string; writer_admission_grant: Record<string, unknown>; claimed_writer_key_id: string } | null;
  /** The last ref transaction this principal published (5.4 fills it). */
  last_ref_transaction: Record<string, unknown> | null;
  /** How this file came to exist — creation, or a §5.1 restore from the principal's own envelope. */
  provenance: "created" | "restored_from_envelope" | "restored_from_handoff";
  updated_at: string;
}

/** One `audit.log` line. */
export interface GitvaultAuditEntry {
  at: string;
  event: GitvaultAuditEvent;
  repo_id?: string;
  details?: Record<string, unknown>;
}

export type GitvaultAuditEvent =
  | "keystore_opened"
  | "identity_created"
  | "repo_saved"
  | "repo_restored_from_envelope"
  | "recovery_receipt_stored"
  | "permission_finding"
  | "lock_acquired"
  | "lock_released"
  | "lock_stale_reclaimed"
  | "transition_assessed"
  | "journal_stage"
  | "epoch_rotation_recorded";

/** A permission-audit finding (never fatal by default; surfaced to doctor). */
export interface GitvaultPermissionFinding {
  path: string;
  problem: "world_or_group_accessible" | "symlink" | "not_owned_by_user" | "missing";
  mode?: string;
}

/** The §5.1 partial-loss transition the keystore is in for one vault. */
export type GitvaultKeystoreState =
  | { state: "ready"; repo: GitvaultRepoFile }
  | { state: "repo_state_lost_identity_intact"; next_action: "restore_from_envelope" }
  | { state: "read_only"; repo: GitvaultRepoFile; reason: "signing_key_lost" }
  | { state: "stale_pin"; repo: GitvaultRepoFile; next_action: "reverify_from_genesis" }
  | { state: "unrecoverable"; code: "VAULT_UNRECOVERABLE"; statement: string; doctor_text: string };

export interface GitvaultKeystoreOptions {
  /** Override the keystore root (tests). Defaults to `<config dir>/gitvault`. */
  rootDir?: string;
  /** Clock injection (tests). */
  now?: () => Date;
  /** When true, a permission finding on open throws `GITVAULT_KEYSTORE_PERMISSIONS` instead of only auditing. */
  strictPermissions?: boolean;
}

export interface GitvaultLockOptions {
  /** How long a lock is considered live before it is reclaimed as stale (ms). Default 10 min. */
  staleAfterMs?: number;
  /** Total wait budget before `GITVAULT_KEYSTORE_LOCKED` (ms). Default 30 s. */
  timeoutMs?: number;
}

function fail(code: string, message: string, context: string, details?: unknown): never {
  throw new LocalError(message, context, { code, details });
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** The local object cache's recency window (design D3: "genesis + newest N=8 heads + newest carriers"). */
export const GITVAULT_OBJECT_CACHE_WINDOW = 8;

/** gitvault-object-host-predial (design D1): the max persisted object-store origins per repo — small on purpose, this is a predial hint, not an inventory. */
export const GITVAULT_OBJECT_STORE_ORIGINS_CAP = 4;

/** Bare hex16 generation comparison for cache eviction — deliberately NOT `generationToBigInt` (gitvault-publication.ts), which this lower-level module must not import (publication already imports FROM here). Malformed input sorts as "evict" rather than throwing: a corrupt cache entry should never block eviction of everything else. */
function genToBigInt(generation: string): bigint {
  try {
    return /^[0-9a-f]{16}$/.test(generation) ? BigInt(`0x${generation}`) : -1n;
  } catch {
    return -1n;
  }
}

/** Default keystore root: `<active profile config dir>/gitvault`. */
export function getGitvaultKeystoreRoot(): string {
  return join(getConfigDir(), "gitvault");
}

function mkdir0700(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
}

function fsyncDir(path: string): void {
  try {
    const fd = openSync(path, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    /* some filesystems refuse directory fsync; the rename is still atomic */
  }
}

/**
 * Atomic, no-follow, fsynced write: `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` on a
 * temp sibling, fsync, rename over the target, fsync the directory.
 */
export function writeFileAtomic0600(path: string, text: string): void {
  const dir = dirname(path);
  mkdir0700(dir);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    fail("GITVAULT_KEYSTORE_SYMLINK", `refusing to write through a symlink: ${path}`, "writing gitvault keystore file", { path });
  }
  const tmp = join(dir, `.${String(process.pid)}.${bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(6)))}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, FILE_MODE);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}

/** No-follow read: a symlinked keystore file is a refusal, not a read. */
export function readFileNoFollow(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    fail("GITVAULT_KEYSTORE_SYMLINK", `refusing to read through a symlink: ${path}`, "reading gitvault keystore file", { path });
  }
  const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function auditPath(path: string, expectDir: boolean): GitvaultPermissionFinding[] {
  const findings: GitvaultPermissionFinding[] = [];
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return [{ path, problem: "missing" }];
  }
  if (st.isSymbolicLink()) findings.push({ path, problem: "symlink" });
  if (process.platform !== "win32") {
    const mode = st.mode & 0o777;
    const allowed = expectDir ? DIR_MODE : FILE_MODE;
    if ((mode & ~allowed) !== 0) findings.push({ path, problem: "world_or_group_accessible", mode: mode.toString(8) });
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) findings.push({ path, problem: "not_owned_by_user" });
  }
  return findings;
}

// ─── The keystore ────────────────────────────────────────────────────────────

export class GitvaultKeystore {
  readonly rootDir: string;
  private readonly now: () => Date;
  private readonly strictPermissions: boolean;

  constructor(options: GitvaultKeystoreOptions = {}) {
    this.rootDir = options.rootDir ?? getGitvaultKeystoreRoot();
    this.now = options.now ?? (() => new Date());
    this.strictPermissions = options.strictPermissions ?? false;
  }

  /** Open (creating the directory skeleton) and run the permission audit. */
  static open(options: GitvaultKeystoreOptions = {}): GitvaultKeystore {
    const ks = new GitvaultKeystore(options);
    for (const dir of [ks.rootDir, ks.reposDir, ks.receiptsDir, ks.journalDir]) mkdir0700(dir);
    const findings = ks.auditPermissions();
    ks.audit("keystore_opened", undefined, { findings: findings.length });
    if (findings.length > 0 && ks.strictPermissions) {
      fail("GITVAULT_KEYSTORE_PERMISSIONS", "gitvault keystore permission audit failed", "opening gitvault keystore", { findings });
    }
    return ks;
  }

  get identityPath(): string { return join(this.rootDir, "identity.json"); }
  get reposDir(): string { return join(this.rootDir, "repos"); }
  get receiptsDir(): string { return join(this.rootDir, "receipts"); }
  get journalDir(): string { return join(this.rootDir, "journal"); }
  get auditLogPath(): string { return join(this.rootDir, "audit.log"); }
  repoPath(repoId: string): string {
    if (!GITVAULT_SRC_RE.test(repoId)) fail("GITVAULT_BAD_REPO_ID", `not a src_ id: ${repoId}`, "resolving gitvault repo path");
    return join(this.reposDir, `${repoId}.json`);
  }
  recoveryReceiptPath(repoId: string): string {
    if (!GITVAULT_SRC_RE.test(repoId)) fail("GITVAULT_BAD_REPO_ID", `not a src_ id: ${repoId}`, "resolving gitvault receipt path");
    return join(this.receiptsDir, `${repoId}.recovery_receipt.json`);
  }

  // ── permission audit ──

  /** Audit every keystore path that exists; findings are recorded in `audit.log` and returned. */
  auditPermissions(): GitvaultPermissionFinding[] {
    const findings: GitvaultPermissionFinding[] = [];
    const check = (path: string, dir: boolean) => {
      if (!existsSync(path) && !isSymlink(path)) return;
      findings.push(...auditPath(path, dir));
    };
    check(this.rootDir, true);
    check(this.identityPath, false);
    check(this.auditLogPath, false);
    for (const dir of [this.reposDir, this.journalDir]) {
      check(dir, true);
      if (existsSync(dir)) {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          if (entry.endsWith(".lock")) continue;
          check(p, statSafe(p)?.isDirectory() ?? false);
        }
      }
    }
    for (const f of findings) this.audit("permission_finding", undefined, { ...f });
    return findings;
  }

  // ── audit log ──

  /** Append one JSON line to `audit.log` (0600, created no-follow). */
  audit(event: GitvaultAuditEvent, repoId?: string, details?: Record<string, unknown>): void {
    const entry: GitvaultAuditEntry = { at: formatGitvaultTimestamp(this.now()), event, ...(repoId ? { repo_id: repoId } : {}), ...(details ? { details } : {}) };
    mkdir0700(this.rootDir);
    if (isSymlink(this.auditLogPath)) {
      fail("GITVAULT_KEYSTORE_SYMLINK", "refusing to append through a symlinked audit.log", "appending gitvault audit log");
    }
    const fd = openSync(this.auditLogPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | O_NOFOLLOW, FILE_MODE);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Read the audit log (newest last). */
  readAuditLog(): GitvaultAuditEntry[] {
    const text = readFileNoFollow(this.auditLogPath);
    if (!text) return [];
    return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as GitvaultAuditEntry);
  }

  // ── identity ──

  readIdentity(): GitvaultIdentityFile | null {
    const text = readFileNoFollow(this.identityPath);
    if (!text) return null;
    const parsed = JSON.parse(text) as GitvaultIdentityFile;
    if (parsed.version !== 1 || typeof parsed.signing_pubkey !== "string" || typeof parsed.encryption_pubkey !== "string") {
      fail("GITVAULT_KEYSTORE_CORRUPT", "identity.json is not a version-1 gitvault identity", "reading gitvault identity");
    }
    return parsed;
  }

  /** Create the identity if absent; never overwrites an existing one. */
  ensureIdentity(): GitvaultIdentityFile {
    const existing = this.readIdentity();
    if (existing) return existing;
    const signing = generateSigningKeypair();
    const encryption = generateEncryptionKeypair();
    const identity: GitvaultIdentityFile = {
      version: 1,
      signing_seed_hex: bytesToHex(signing.seed),
      signing_pubkey: toBase64url(signing.public_key),
      signing_fingerprint: vkFingerprint(signing.public_key),
      encryption_private_key_hex: bytesToHex(encryption.private_key),
      encryption_pubkey: toBase64url(encryption.public_key),
      encryption_fingerprint: ekFingerprint(encryption.public_key),
      created_at: formatGitvaultTimestamp(this.now()),
    };
    if (existsSync(this.identityPath)) {
      fail("GITVAULT_KEYSTORE_CONFLICT", "identity.json appeared concurrently; refusing to overwrite", "creating gitvault identity");
    }
    writeFileAtomic0600(this.identityPath, JSON.stringify(identity, null, 2));
    this.audit("identity_created", undefined, { signing_fingerprint: identity.signing_fingerprint, encryption_fingerprint: identity.encryption_fingerprint });
    return identity;
  }

  /** The signing keypair, or `null` when the signing seed is lost (read-only principal). */
  signingKeypair(identity: GitvaultIdentityFile = this.requireIdentity()): GitvaultSigningKeypair | null {
    if (!identity.signing_seed_hex) return null;
    const kp = generateSigningKeypair(hexToBytes(identity.signing_seed_hex));
    if (vkFingerprint(kp.public_key) !== identity.signing_fingerprint) {
      fail("GITVAULT_KEYSTORE_CORRUPT", "identity signing seed does not derive the recorded fingerprint", "loading gitvault signing key");
    }
    return kp;
  }

  /** The encryption keypair, or `null` when the X25519 private key is lost. */
  encryptionKeypair(identity: GitvaultIdentityFile = this.requireIdentity()): GitvaultEncryptionKeypair | null {
    if (!identity.encryption_private_key_hex) return null;
    const kp = generateEncryptionKeypair(hexToBytes(identity.encryption_private_key_hex));
    if (ekFingerprint(kp.public_key) !== identity.encryption_fingerprint) {
      fail("GITVAULT_KEYSTORE_CORRUPT", "identity encryption key does not derive the recorded fingerprint", "loading gitvault encryption key");
    }
    return kp;
  }

  private requireIdentity(): GitvaultIdentityFile {
    const id = this.readIdentity();
    if (!id) fail("VAULT_UNRECOVERABLE", GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT, "loading gitvault identity", { statement: GITVAULT_TERMINAL_LOSS_STATEMENT });
    return id;
  }

  // ── repo files ──

  readRepo(repoId: string): GitvaultRepoFile | null {
    const text = readFileNoFollow(this.repoPath(repoId));
    if (!text) return null;
    const parsed = JSON.parse(text) as GitvaultRepoFile;
    if (parsed.version !== 1 || parsed.repo_id !== repoId || typeof parsed.k_repo_hex !== "string") {
      fail("GITVAULT_KEYSTORE_CORRUPT", `repos/${repoId}.json is not a version-1 gitvault repo file`, "reading gitvault repo file", { repo_id: repoId });
    }
    return parsed;
  }

  listRepoIds(): string[] {
    if (!existsSync(this.reposDir)) return [];
    return readdirSync(this.reposDir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((id) => GITVAULT_SRC_RE.test(id)).sort();
  }

  /**
   * gitvault-offline-clone-resolve (design D1/D2/D6, task 1.1): the
   * keystore's project→repo lookup that lets {@link resolveGitvaultAddress}
   * (`gitvault-address.ts`) answer an id-form address WITHOUT the network
   * `findVaultByProject` round trip. D2's completeness argument: decrypting
   * anything requires exactly this repo file (`k_repo_hex`), so "this
   * keystore holds a matching file" is exactly the set of clones that can
   * complete regardless of how resolution went — the network call was only
   * ever confirming a fact this machine already held.
   *
   * `orgId`, when supplied, is a HARD equality filter, never a hint: a
   * `project_id` match under a different `org_id` is a miss (D1, "mismatched
   * org → treat as miss, never guess") — an org transfer or an id collision
   * must never resolve to the wrong vault silently. Passing `undefined`
   * accepts any org for that project id.
   *
   * Multiple repo files can legitimately name the same `project_id` — most
   * commonly a re-vaulted project that left its old file behind under its
   * old `repo_id` on THIS machine. D3: the most-recently-modified file (by
   * filesystem mtime — D6 rules out a maintained on-disk index for v1) wins;
   * a wrong pick is indistinguishable from an ordinary stale pin and heals
   * through the same {@link recoverStaleGitvaultPin} first-use-refusal path.
   *
   * Cheap by construction (D6): one directory listing plus one JSON read per
   * candidate — no maintained project→repo index. NEVER throws: a corrupt,
   * unreadable, or concurrently-deleted repo file is skipped exactly as a
   * cache miss, because a project-id scan has no single `repo_id` to blame a
   * throw on (unlike {@link readRepo}'s single-id contract, where throwing on
   * corruption is the right, attributable failure). Returns `null` on no
   * match, an empty keystore, or a not-yet-created `repos/` directory.
   */
  findRepoByProject(projectId: string, orgId?: string): GitvaultRepoFile | null {
    let best: { repo: GitvaultRepoFile; mtimeMs: number } | null = null;
    for (const repoId of this.listRepoIds()) {
      let repo: GitvaultRepoFile | null;
      try {
        repo = this.readRepo(repoId);
      } catch {
        continue; // corrupt/unreadable file — skip silently, this is a scan, not a targeted read
      }
      if (!repo || repo.project_id !== projectId) continue;
      if (orgId !== undefined && repo.org_id !== orgId) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(this.repoPath(repoId)).mtimeMs;
      } catch {
        continue; // vanished between listing and stat — skip
      }
      if (!best || mtimeMs > best.mtimeMs) best = { repo, mtimeMs };
    }
    return best?.repo ?? null;
  }

  /** Save (create or replace) a repo file under the per-repo lock. */
  saveRepo(repo: Omit<GitvaultRepoFile, "version" | "updated_at">): GitvaultRepoFile {
    const full: GitvaultRepoFile = { version: 1, ...repo, updated_at: formatGitvaultTimestamp(this.now()) };
    this.withRepoLock(repo.repo_id, () => {
      writeFileAtomic0600(this.repoPath(repo.repo_id), JSON.stringify(full, null, 2));
    });
    this.audit("repo_saved", repo.repo_id, { provenance: repo.provenance, genesis_sha256: repo.genesis_sha256 });
    return full;
  }

  /** Update the dual pins / last ref transaction without touching key material. */
  updateRepo(repoId: string, patch: Partial<Pick<GitvaultRepoFile, "head_pin" | "materialized_pin" | "verified_prefix" | "last_ref_transaction" | "epoch" | "envelope_recipient_pins" | "k_repo_hex" | "epoch_keys" | "known_pin_manifest" | "checkpoint_covers_through" | "object_store_origins">>): GitvaultRepoFile {
    return this.withRepoLock(repoId, () => {
      const existing = this.readRepo(repoId);
      if (!existing) fail("GITVAULT_REPO_STATE_MISSING", `no repo file for ${repoId}`, "updating gitvault repo file", { repo_id: repoId });
      const full: GitvaultRepoFile = { ...existing, ...patch, updated_at: formatGitvaultTimestamp(this.now()) };
      writeFileAtomic0600(this.repoPath(repoId), JSON.stringify(full, null, 2));
      return full;
    });
  }

  /**
   * gitvault-object-host-predial (design D1/D4, task 1.2): record that
   * `origins` (already-normalized `scheme://host` strings) were observed
   * serving THIS repo's objects — the transport's write-through-on-change
   * hook. Most-recently-observed wins ties over anything already recorded;
   * deduped; capped at {@link GITVAULT_OBJECT_STORE_ORIGINS_CAP}. A true
   * no-op (no lock taken, no write, `updated_at` untouched) when the
   * resulting set is IDENTICAL — in order — to what is already on disk, so
   * the steady state (every session re-observes the same one or two
   * origins) costs nothing. Best-effort by contract: a missing repo file
   * (this call racing a not-yet-`saveRepo`'d creation) or any read/write
   * failure is swallowed — this is a latency hint, never load-bearing, and
   * must never surface into a caller's own object-read path.
   */
  recordObjectStoreOrigins(repoId: string, origins: readonly string[]): void {
    if (origins.length === 0) return;
    try {
      const existing = this.readRepo(repoId);
      if (!existing) return;
      const current = existing.object_store_origins ?? [];
      const next: string[] = [];
      for (const o of origins) if (!next.includes(o)) next.push(o);
      for (const o of current) {
        if (next.length >= GITVAULT_OBJECT_STORE_ORIGINS_CAP) break;
        if (!next.includes(o)) next.push(o);
      }
      const capped = next.slice(0, GITVAULT_OBJECT_STORE_ORIGINS_CAP);
      if (capped.length === current.length && capped.every((o, i) => o === current[i])) return;
      this.updateRepo(repoId, { object_store_origins: capped });
    } catch {
      /* best-effort learning only — never surfaces into an object read */
    }
  }

  // ── local immutable-object cache (gitvault-client-round-trips design D3) ──
  //
  // `<rootDir>/<repo_id>/objects/` — beside the repo file above, NOT inside
  // it: genesis bytes, admitted head bytes, and carrier (ref_state /
  // retention_roots) ciphertext this principal has already fetched and
  // verified once. Holds ONLY ciphertext and signed public objects — never
  // decrypted plaintext, key material, or key envelopes. This class stores
  // and retrieves bytes alongside the sha256 they were verified against; it
  // does not itself re-verify anything — every caller (`GitvaultVault`)
  // re-checks a cache hit against the SAME pin/receipt it would check
  // network bytes against before trusting it, so a stale or tampered entry
  // can only ever be discarded and refetched, never silently trusted. A
  // missing or corrupt cache file reads back as `null` (a plain cache miss),
  // never a thrown error — the cache is a pure accelerator, and its absence
  // degrades to exactly today's network-fetch behavior.

  private objectsRepoDir(repoId: string): string {
    if (!GITVAULT_SRC_RE.test(repoId)) fail("GITVAULT_BAD_REPO_ID", `not a src_ id: ${repoId}`, "resolving gitvault object cache path");
    return join(this.rootDir, repoId, "objects");
  }
  private objectsGenesisPath(repoId: string): string { return join(this.objectsRepoDir(repoId), "genesis.json"); }
  private objectsHeadsDir(repoId: string): string { return join(this.objectsRepoDir(repoId), "heads"); }
  private objectsCarriersDir(repoId: string): string { return join(this.objectsRepoDir(repoId), "carriers"); }
  private objectsHeadPath(repoId: string, generation: string): string { return join(this.objectsHeadsDir(repoId), `${generation}.json`); }
  private objectsCarrierPath(repoId: string, objectId: string): string { return join(this.objectsCarriersDir(repoId), `${objectId}.json`); }

  private readCachedFile(path: string): Record<string, unknown> | null {
    const text = readFileNoFollow(path);
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  private writeCachedFile(path: string, data: Record<string, unknown>): void {
    writeFileAtomic0600(path, JSON.stringify(data));
  }
  private decodeCachedBytes(data: Record<string, unknown> | null): { sha256: string; bytes: Uint8Array } | null {
    if (!data || typeof data.sha256 !== "string" || typeof data.bytes_base64 !== "string") return null;
    try {
      return { sha256: data.sha256, bytes: new Uint8Array(Buffer.from(data.bytes_base64, "base64")) };
    } catch {
      return null;
    }
  }

  /** Genesis is one small object per vault, immutable forever — cached and never evicted. */
  readCachedGenesis(repoId: string): { sha256: string; bytes: Uint8Array } | null {
    return this.decodeCachedBytes(this.readCachedFile(this.objectsGenesisPath(repoId)));
  }
  writeCachedGenesis(repoId: string, sha256: string, bytes: Uint8Array): void {
    this.writeCachedFile(this.objectsGenesisPath(repoId), { sha256, bytes_base64: Buffer.from(bytes).toString("base64") });
  }

  readCachedHead(repoId: string, generation: string): { sha256: string; bytes: Uint8Array } | null {
    return this.decodeCachedBytes(this.readCachedFile(this.objectsHeadPath(repoId, generation)));
  }
  /** Writes the head, then evicts anything more than {@link GITVAULT_OBJECT_CACHE_WINDOW} generations behind it. */
  writeCachedHead(repoId: string, generation: string, sha256: string, bytes: Uint8Array): void {
    this.writeCachedFile(this.objectsHeadPath(repoId, generation), { sha256, bytes_base64: Buffer.from(bytes).toString("base64") });
    this.evictObjectCache(repoId, generation);
  }

  readCachedCarrier(repoId: string, objectId: string): { sha256: string; bytes: Uint8Array; generation: string } | null {
    const data = this.readCachedFile(this.objectsCarrierPath(repoId, objectId));
    const decoded = this.decodeCachedBytes(data);
    if (!decoded || typeof data?.generation !== "string") return null;
    return { ...decoded, generation: data.generation };
  }
  /** Writes the carrier (keyed by `object_id`, tagged with the generation that referenced it), then sweeps the window. */
  writeCachedCarrier(repoId: string, objectId: string, generation: string, sha256: string, bytes: Uint8Array): void {
    this.writeCachedFile(this.objectsCarrierPath(repoId, objectId), { sha256, bytes_base64: Buffer.from(bytes).toString("base64"), generation });
    this.evictObjectCache(repoId, generation);
  }

  /**
   * Drop heads and carriers more than {@link GITVAULT_OBJECT_CACHE_WINDOW}
   * generations behind `latestGeneration` — genesis is exempt (kept
   * forever). Runs inline on every cache write; also callable directly
   * (`sweepObjectCache`, wired into `repos gc`) as a periodic backstop that
   * catches any orphan a crashed write might have left behind. Best-effort:
   * an unlink failure (e.g. already gone) is silently ignored, matching the
   * cache's own "a miss just refetches" posture.
   */
  private evictObjectCache(repoId: string, latestGeneration: string): void {
    const cutoff = genToBigInt(latestGeneration) - BigInt(GITVAULT_OBJECT_CACHE_WINDOW - 1);
    const pruneDir = (dir: string, generationOf: (entry: string) => string | null) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".json")) continue;
        const gen = generationOf(entry);
        if (gen === null || genToBigInt(gen) < cutoff) {
          try { unlinkSync(join(dir, entry)); } catch { /* already gone — fine */ }
        }
      }
    };
    pruneDir(this.objectsHeadsDir(repoId), (entry) => {
      const gen = entry.slice(0, -".json".length);
      return /^[0-9a-f]{16}$/.test(gen) ? gen : null;
    });
    pruneDir(this.objectsCarriersDir(repoId), (entry) => {
      const data = this.readCachedFile(join(this.objectsCarriersDir(repoId), entry));
      return typeof data?.generation === "string" ? data.generation : null;
    });
  }

  /** The `repos gc`-time sweep (task 4.2): re-applies the SAME eviction window as an inline write would, for every repo this keystore holds. Safe to call on a repo with no cache directory at all (a no-op). */
  sweepObjectCache(repoId: string): void {
    const repo = this.readRepo(repoId);
    const newest = repo?.materialized_pin?.generation ?? repo?.head_pin?.generation ?? null;
    if (newest) this.evictObjectCache(repoId, newest);
  }

  /**
   * Record a COMMITTED epoch rotation (D194, rev 42): advances the local
   * "current" pointer (`epoch` + `k_repo_hex`) to the new epoch's key AND
   * appends it to `epoch_keys` (never overwriting a prior entry — every key
   * this principal has ever held stays locally available for historical
   * decrypt / the D195 prior-key-inequality check on the NEXT rotation).
   * Audited distinctly from an ordinary `updateRepo` patch.
   */
  recordEpochRotation(repoId: string, input: { new_epoch: string; new_k_repo_hex: string }): GitvaultRepoFile {
    return this.withRepoLock(repoId, () => {
      const existing = this.readRepo(repoId);
      if (!existing) fail("GITVAULT_REPO_STATE_MISSING", `no repo file for ${repoId}`, "recording gitvault epoch rotation", { repo_id: repoId });
      const epochKeys = { ...(existing.epoch_keys ?? {}), [existing.epoch]: existing.k_repo_hex, [input.new_epoch]: input.new_k_repo_hex };
      const full: GitvaultRepoFile = { ...existing, epoch: input.new_epoch, k_repo_hex: input.new_k_repo_hex, epoch_keys: epochKeys, updated_at: formatGitvaultTimestamp(this.now()) };
      writeFileAtomic0600(this.repoPath(repoId), JSON.stringify(full, null, 2));
      this.audit("epoch_rotation_recorded", repoId, { new_epoch: input.new_epoch, known_epoch_count: Object.keys(epochKeys).length });
      return full;
    });
  }

  // ── recovery receipts ──

  saveRecoveryReceipt(receipt: GitvaultRecoveryReceipt): void {
    // Not a secret — but written with the same discipline so a partially written
    // receipt is never mistaken for a complete one.
    writeFileAtomic0600(this.recoveryReceiptPath(receipt.repo_id), JSON.stringify(receipt, null, 2));
    this.audit("recovery_receipt_stored", receipt.repo_id, { genesis_sha256: receipt.genesis_sha256 });
  }

  readRecoveryReceipt(repoId: string): GitvaultRecoveryReceipt | null {
    const text = readFileNoFollow(this.recoveryReceiptPath(repoId));
    return text ? (JSON.parse(text) as GitvaultRecoveryReceipt) : null;
  }

  // ── per-repo lock ──

  /**
   * Run `fn` holding the per-repo lock (`repos/<repo_id>.lock/`, mkdir-atomic).
   * A lock older than `staleAfterMs` whose recorded pid is dead is reclaimed
   * (audited). Re-entrant for the same process+repo.
   */
  withRepoLock<T>(repoId: string, fn: () => T, options: GitvaultLockOptions = {}): T {
    const lockDir = `${this.repoPath(repoId)}.lock`;
    if (this.held.has(lockDir)) return fn();
    const staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
    const timeoutMs = options.timeoutMs ?? 30 * 1000;
    const deadline = Date.now() + timeoutMs;
    mkdir0700(this.reposDir);
    for (;;) {
      try {
        mkdirSync(lockDir, { mode: DIR_MODE });
        break;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (this.reclaimStaleLock(lockDir, repoId, staleAfterMs)) continue;
        if (Date.now() >= deadline) {
          fail("GITVAULT_KEYSTORE_LOCKED", `another process holds the lock for ${repoId}`, "acquiring gitvault repo lock", { repo_id: repoId, lock: lockDir });
        }
        const until = Date.now() + 25;
        while (Date.now() < until) { /* spin */ }
      }
    }
    try {
      writeFileAtomic0600(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: formatGitvaultTimestamp(this.now()) }));
    } catch {
      /* owner record is advisory */
    }
    this.held.add(lockDir);
    this.audit("lock_acquired", repoId);
    try {
      return fn();
    } finally {
      this.held.delete(lockDir);
      try { safeRemoveLock(lockDir); } catch { /* best-effort */ }
      this.audit("lock_released", repoId);
    }
  }

  private readonly held = new Set<string>();

  private reclaimStaleLock(lockDir: string, repoId: string, staleAfterMs: number): boolean {
    let ownerPid: number | undefined;
    let age = Number.POSITIVE_INFINITY;
    try {
      const st = statSync(lockDir);
      age = Date.now() - st.mtimeMs;
      const owner = readFileNoFollow(join(lockDir, "owner.json"));
      if (owner) ownerPid = (JSON.parse(owner) as { pid?: number }).pid;
    } catch {
      /* unreadable owner record → rely on age */
    }
    const ownerDead = ownerPid !== undefined && ownerPid !== process.pid && !pidAlive(ownerPid);
    if (age > staleAfterMs || ownerDead) {
      try {
        safeRemoveLock(lockDir);
        this.audit("lock_stale_reclaimed", repoId, { owner_pid: ownerPid ?? null, age_ms: Math.round(age) });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // ── §5.1 transitions ──

  /**
   * Derive the partial-loss transition for one vault. `expectedGenesisSha256`
   * (from a freshly listed genesis, 5.4) turns a pin mismatch into `stale_pin`.
   */
  assess(repoId: string, expectedGenesisSha256?: string): GitvaultKeystoreState {
    const identity = this.readIdentity();
    const repo = this.readRepo(repoId);
    let state: GitvaultKeystoreState;
    if (!identity && !repo) {
      state = { state: "unrecoverable", code: "VAULT_UNRECOVERABLE", statement: GITVAULT_TERMINAL_LOSS_STATEMENT, doctor_text: GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT };
    } else if (!identity && repo) {
      // K_repo survives but no key can sign or open anything new: the history
      // stays READABLE (K_repo decrypts) but nothing can be published.
      state = { state: "read_only", repo, reason: "signing_key_lost" };
    } else if (identity && !repo) {
      state = identity.encryption_private_key_hex
        ? { state: "repo_state_lost_identity_intact", next_action: "restore_from_envelope" }
        : { state: "unrecoverable", code: "VAULT_UNRECOVERABLE", statement: GITVAULT_TERMINAL_LOSS_STATEMENT, doctor_text: GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT };
    } else if (identity && repo && !identity.signing_seed_hex) {
      state = { state: "read_only", repo, reason: "signing_key_lost" };
    } else if (expectedGenesisSha256 !== undefined && repo && repo.genesis_sha256 !== expectedGenesisSha256) {
      state = { state: "stale_pin", repo, next_action: "reverify_from_genesis" };
    } else {
      state = { state: "ready", repo: repo! };
    }
    this.audit("transition_assessed", repoId, { state: state.state });
    return state;
  }

  /**
   * §5.1 "repo file lost + identity intact → restore K_repo from own envelope".
   * The genesis is checked (signature + key bindings against the stored
   * envelope + the recovery receipt/pin when one survives) BEFORE the envelope
   * is opened; the restored file is marked `restored_from_envelope`.
   */
  async restoreRepoFromEnvelope(input: {
    genesis: GitvaultVaultGenesis;
    envelope: GitvaultKeyEnvelope;
    /** A surviving receipt (on disk or supplied) authenticates the genesis; without one the restore is labeled unauthenticated salvage. */
    recovery_receipt?: GitvaultRecoveryReceipt | null;
  }): Promise<{ repo: GitvaultRepoFile; trust: "receipt" | "unauthenticated_salvage" }> {
    const identity = this.readIdentity();
    if (!identity) fail("VAULT_UNRECOVERABLE", GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT, "restoring gitvault repo state", { statement: GITVAULT_TERMINAL_LOSS_STATEMENT });
    const recipient = this.encryptionKeypair(identity);
    if (!recipient) fail("VAULT_UNRECOVERABLE", GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT, "restoring gitvault repo state", { statement: GITVAULT_TERMINAL_LOSS_STATEMENT });
    const { genesis, envelope } = input;
    if (!verifyGitvaultObject(genesis as unknown as GitvaultSignedObject, genesis.creator_signing_pubkey)) {
      fail("GITVAULT_SIGNATURE_INVALID", "vault_genesis signature does not verify", "restoring gitvault repo state", { repo_id: genesis.repo_id });
    }
    const bindings = checkGenesisKeyBindings(genesis, envelope);
    if (bindings.length > 0) {
      fail("VAULT_CREATION_CONFLICT", "genesis key bindings do not hold for the stored envelope", "restoring gitvault repo state", { repo_id: genesis.repo_id, problems: bindings });
    }
    const genesisSha = storedBytesSha256(genesis as unknown as GitvaultSignedObject);
    const receipt = input.recovery_receipt ?? this.readRecoveryReceipt(genesis.repo_id);
    let trust: "receipt" | "unauthenticated_salvage" = "unauthenticated_salvage";
    if (receipt) {
      const problems = checkRecoveryReceipt(receipt, genesis);
      if (problems.length > 0) {
        fail("VAULT_CREATION_CONFLICT", "recovery receipt does not pin this genesis (substituted vault?)", "restoring gitvault repo state", { repo_id: genesis.repo_id, problems });
      }
      trust = "receipt";
    }
    if (envelope.recipient_fingerprint !== identity.encryption_fingerprint) {
      fail("GITVAULT_ENVELOPE_NOT_FOR_RECIPIENT", "the stored envelope is addressed to another principal", "restoring gitvault repo state", { recipient_fingerprint: envelope.recipient_fingerprint });
    }
    const kRepo = await openKeyEnvelope({ envelope, recipient, signer_public_key: genesis.creator_signing_pubkey });
    const repo = this.saveRepo({
      repo_id: genesis.repo_id,
      org_id: genesis.org_id,
      project_id: genesis.project_id,
      k_repo_hex: bytesToHex(kRepo),
      epoch: envelope.epoch,
      genesis_sha256: genesisSha,
      head_pin: null,
      last_ref_transaction: null,
      provenance: "restored_from_envelope",
    });
    this.audit("repo_restored_from_envelope", genesis.repo_id, { trust });
    return { repo, trust };
  }

  /** Identity fingerprints for display/doctor (never key material). */
  identitySummary(): { signing_fingerprint: string; encryption_fingerprint: string; signing_key_present: boolean; encryption_key_present: boolean } | null {
    const id = this.readIdentity();
    if (!id) return null;
    if (!GITVAULT_VK_RE.test(id.signing_fingerprint) || !GITVAULT_EK_RE.test(id.encryption_fingerprint)) {
      fail("GITVAULT_KEYSTORE_CORRUPT", "identity fingerprints are malformed", "reading gitvault identity");
    }
    return {
      signing_fingerprint: id.signing_fingerprint,
      encryption_fingerprint: id.encryption_fingerprint,
      signing_key_present: Boolean(id.signing_seed_hex),
      encryption_key_present: Boolean(id.encryption_private_key_hex),
    };
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function statSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeRemoveLock(lockDir: string): void {
  const owner = join(lockDir, "owner.json");
  // rmdir needs an empty directory; the owner record is the only file ever written there.
  if (existsSync(owner)) unlinkSync(owner);
  rmdirSync(lockDir);
}
