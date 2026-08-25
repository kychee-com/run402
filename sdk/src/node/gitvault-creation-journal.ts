/**
 * gitvault — the six-stage crash-safe creation journal (protocol rev 41 §5.2;
 * task 5.3).
 *
 *   LOCAL_KEYS_PREPARED   identity + client_creation_id            (no ciphertext yet —
 *   ALLOCATED             verified allocation: repo_id, nonce, gen   repo_id is a KDF input)
 *   OBJECTS_PREPARED      exact object ids, nonces, framed bytes, hashes, sizes — fsynced BEFORE any PUT
 *   OBJECTS_FINALIZED     server receipts, compared to the local manifest
 *   GENESIS_PREPARED      exact genesis stored bytes + hash
 *   ACTIVE                admitted; pin + recovery receipt recorded
 *
 * The ordering is the round-3 H5 invariant made structural: `K_repo` is
 * generated and the creator's `key_envelope` is sealed ONLY in the
 * OBJECTS_PREPARED step, which cannot run until ALLOCATED has journaled a
 * `repo_id` — because `repo_id` is an HKDF input and an HPKE AAD member, no
 * ciphertext can exist before allocation. Each stage is written to
 * `journal/<client_creation_id>.json` with the keystore's atomic+fsync write
 * before the next step starts.
 *
 * Restart reconciliation (`resume`) dispatches on the durable stage:
 *   - OBJECTS_PREPARED with a PUT possibly in flight → read-and-compare the
 *     object against the journaled bytes; equal → finalized; present-but-
 *     different → `VAULT_CREATION_CONFLICT`; absent → PUT the SAME bytes.
 *     Never re-encrypt under the same id (a fresh seal would be a second
 *     ciphertext under a single-use key label).
 *   - GENESIS_PREPARED → read the admitted genesis back; equal → ACTIVE;
 *     foreign → `VAULT_CREATION_CONFLICT`, never overwritten.
 *   - a `superseded` allocation anywhere → `ALLOCATION_SUPERSEDED`; the client
 *     does not publish.
 *   - anything the journal cannot explain → refuse the destructive retry.
 *
 * The control-plane calls ride an injectable {@link GitvaultCreationTransport}
 * — task 5.4 wires the HTTP one; tests supply an in-memory bucket.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LocalError } from "../errors.js";
import {
  GITVAULT_GENESIS_EPOCH,
  GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT,
  GITVAULT_TERMINAL_LOSS_STATEMENT,
  buildRecoveryReceipt,
  buildVaultGenesis,
  bytesToHex,
  checkAllocation,
  checkGenesisKeyBindings,
  formatGitvaultTimestamp,
  newHex32,
  parseGitvaultStrict,
  randomBytes,
  sealKeyEnvelope,
  sha256Hex,
  storedBytes,
} from "../namespaces/gitvault.crypto.js";
import type {
  GitvaultAllocation,
  GitvaultKeyEnvelope,
  GitvaultKeyEnvelopeReceipt,
  GitvaultRecoveryReceipt,
  GitvaultSignedObject,
  GitvaultVaultGenesis,
} from "../namespaces/gitvault.types.js";
import { GitvaultKeystore, readFileNoFollow, writeFileAtomic0600 } from "./gitvault-keystore.js";

// ─── Stages + journal shape ──────────────────────────────────────────────────

export const GITVAULT_CREATION_STAGES = [
  "LOCAL_KEYS_PREPARED",
  "ALLOCATED",
  "OBJECTS_PREPARED",
  "OBJECTS_FINALIZED",
  "GENESIS_PREPARED",
  "ACTIVE",
] as const;

export type GitvaultCreationStage = (typeof GITVAULT_CREATION_STAGES)[number];

/** One prepared object: exact bytes + identity, durable before any PUT. */
export interface GitvaultJournaledObject {
  object_kind: "key_envelope";
  /** Storage path relative to the vault root (`envelopes/<epoch>/<recipient_fingerprint>`). */
  path: string;
  /** The exact stored bytes, base64url (the §1 "base64url-jcs" convention). */
  stored_bytes_b64u: string;
  stored_bytes_sha256: string;
  size_bytes: string;
  /** The genesis receipt for this object. */
  receipt: GitvaultKeyEnvelopeReceipt;
  /** Set once the server receipt was compared equal to the local manifest. */
  finalized: boolean;
}

/** `journal/<client_creation_id>.json`. Stage-monotonic; every field from an earlier stage survives. */
export interface GitvaultCreationJournal {
  version: 1;
  stage: GitvaultCreationStage;
  client_creation_id: string;
  org_id: string;
  project_id: string;
  creator_signing_fingerprint: string;
  creator_encryption_fingerprint: string;
  created_at: string;
  updated_at: string;
  /** ALLOCATED — the verified allocation verbatim. */
  allocation: GitvaultAllocation | null;
  /** OBJECTS_PREPARED — K_repo (hex) lives ONLY here until ACTIVE moves it to the repo file. */
  k_repo_hex: string | null;
  objects: GitvaultJournaledObject[];
  /** GENESIS_PREPARED — the exact signed genesis and its stored-bytes hash. */
  genesis: GitvaultVaultGenesis | null;
  genesis_sha256: string | null;
  /** ACTIVE — the emitted recovery receipt. */
  recovery_receipt: GitvaultRecoveryReceipt | null;
  /** A terminal refusal, if reconciliation hit one (the journal is kept for diagnosis, never retried destructively). */
  refusal: { code: "VAULT_CREATION_CONFLICT" | "ALLOCATION_SUPERSEDED"; at: string; details?: Record<string, unknown> } | null;
}

// ─── Transport (injected; 5.4 wires HTTP) ───────────────────────────────────

/**
 * `POST /gitvault/v1/vaults` — the allocate REQUEST.
 *
 * READ THIS BEFORE CHANGING THESE FIELD NAMES. The request carries the raw
 * PUBLIC KEYS; the signed `allocation` RECORD the gateway returns carries the
 * FINGERPRINTS derived from them. The two shapes differ on exactly these two
 * fields, so building the request from `schemas/allocation.json` — the obvious
 * thing to do — produces a body the gateway ignores, and it answers
 * `400 VALIDATION_FAILED field=creator_signing_pubkey` as if the field were
 * simply missing. That is the production failure this comment exists to stop
 * from recurring.
 *
 * Pubkeys, not fingerprints, because a fingerprint is one-way: every later head
 * signature is verified against the stored creator signing key, and a hash
 * cannot verify a signature. The gateway derives the fingerprints itself, and
 * `checkAllocation` compares the record's fingerprints back against this
 * principal's — which is what proves the keys we sent are the keys it stored.
 */
export interface GitvaultAllocateRequest {
  client_creation_id: string;
  org_id: string;
  project_id: string;
  /** Raw Ed25519 public key, canonical base64url (43 chars, decodes to 32 bytes). */
  creator_signing_pubkey: string;
  /** Raw X25519 public key, canonical base64url (43 chars, decodes to 32 bytes). */
  creator_encryption_pubkey: string;
}

export interface GitvaultPutObjectRequest {
  repo_id: string;
  path: string;
  bytes: Uint8Array;
  /** What the client expects the server to acknowledge — the server's receipt is compared against it. */
  expected_sha256: string;
  expected_size_bytes: string;
}

export interface GitvaultObjectReceipt {
  stored_bytes_sha256: string;
  size_bytes: string;
}

export interface GitvaultAdmitGenesisRequest {
  repo_id: string;
  allocation_generation: string;
  stored_bytes: Uint8Array;
  stored_bytes_sha256: string;
}

export type GitvaultAdmitGenesisResult =
  | { outcome: "admitted"; admitted_sha256: string }
  /** Someone already canonized generation zero — the resume path decides whether it is ours (read-back) or foreign. */
  | { outcome: "already_admitted"; admitted_sha256: string }
  | { outcome: "allocation_superseded" };

/**
 * The control-plane + bucket operations creation needs. Every method is
 * idempotent from the journal's point of view; the journal never relies on a
 * call having NOT happened.
 */
export interface GitvaultCreationTransport {
  /** Idempotent on `client_creation_id`; returns the current representation (which may be `superseded`). */
  allocate(request: GitvaultAllocateRequest): Promise<GitvaultAllocation>;
  /** Create-only PUT; on a pre-existing object the server MAY return its receipt instead of overwriting. */
  putObject(request: GitvaultPutObjectRequest): Promise<GitvaultObjectReceipt>;
  /** Read an object back (`null` when absent) — the read-and-compare primitive. */
  getObject(request: { repo_id: string; path: string }): Promise<Uint8Array | null>;
  /** Generation-zero admission (the §5A machine at generation zero). */
  admitGenesis(request: GitvaultAdmitGenesisRequest): Promise<GitvaultAdmitGenesisResult>;
  /** Read the admitted genesis bytes back (`null` when none). */
  getGenesis(request: { repo_id: string }): Promise<Uint8Array | null>;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface GitvaultCreationOptions {
  keystore: GitvaultKeystore;
  transport: GitvaultCreationTransport;
  org_id: string;
  project_id: string;
  /** Resume an existing journal, or pin the idempotency key (tests). Fresh CSPRNG when omitted. */
  client_creation_id?: string;
  /** Clock injection. */
  now?: () => Date;
  /** Optional pinned service public key for allocation-signature verification (5.4 supplies it from the registry). */
  service_public_key?: Uint8Array | string;
  /** Test hook: called after each stage is durable, BEFORE the next step — throw to simulate a crash. */
  onStage?: (stage: GitvaultCreationStage, journal: GitvaultCreationJournal) => void | Promise<void>;
}

export interface GitvaultCreationResult {
  repo_id: string;
  genesis_sha256: string;
  recovery_receipt: GitvaultRecoveryReceipt;
  journal: GitvaultCreationJournal;
  /** `created` on the first pass; `reconciled` when a restart completed an earlier attempt. */
  how: "created" | "reconciled";
}

function fail(code: string, message: string, context: string, details?: unknown): never {
  throw new LocalError(message, context, { code, details });
}

function envelopePath(epoch: string, recipientFingerprint: string): string {
  return `envelopes/${epoch}/${recipientFingerprint}`;
}

/** Journal file for one creation attempt. */
export function gitvaultJournalPath(keystore: GitvaultKeystore, clientCreationId: string): string {
  if (!/^[0-9a-f]{32}$/.test(clientCreationId)) fail("GITVAULT_BAD_ID", "client_creation_id must be 32 lowercase hex", "resolving gitvault journal path");
  return join(keystore.journalDir, `${clientCreationId}.json`);
}

export function readGitvaultJournal(keystore: GitvaultKeystore, clientCreationId: string): GitvaultCreationJournal | null {
  const text = readFileNoFollow(gitvaultJournalPath(keystore, clientCreationId));
  if (!text) return null;
  const journal = JSON.parse(text) as GitvaultCreationJournal;
  if (journal.version !== 1 || !GITVAULT_CREATION_STAGES.includes(journal.stage)) {
    fail("GITVAULT_JOURNAL_CORRUPT", "creation journal is not a version-1 gitvault journal", "reading gitvault creation journal", { client_creation_id: clientCreationId });
  }
  return journal;
}

/** Every journal on disk that has not reached ACTIVE (what `doctor` lists as "creation in progress"). */
export function listIncompleteGitvaultJournals(keystore: GitvaultKeystore): GitvaultCreationJournal[] {
  if (!existsSync(keystore.journalDir)) return [];
  const out: GitvaultCreationJournal[] = [];
  for (const entry of readdirSync(keystore.journalDir)) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    if (!/^[0-9a-f]{32}$/.test(id)) continue;
    const j = readGitvaultJournal(keystore, id);
    if (j && j.stage !== "ACTIVE") out.push(j);
  }
  return out;
}

/**
 * The client-side half of D2's resumability guarantee (repo-first-onramp
 * task 2.2): find an in-progress LOCAL creation attempt for this exact
 * (org, project) pair, so a second lazy-create call after a crash RESUMES
 * that attempt's `client_creation_id` instead of starting a fresh one.
 *
 * A fresh random id every call would still converge on one vault in
 * practice (the gateway's own allocate route is idempotent per project),
 * but only this local check makes it provable client-side, with no
 * dependency on that server behavior: interrupt a creation mid-flight,
 * call this again, and the SAME journal — not a second competing one —
 * drives to ACTIVE.
 *
 * Refused journals (`VAULT_CREATION_CONFLICT` / `ALLOCATION_SUPERSEDED`) are
 * skipped: `GitvaultCreation.run()` refuses to retry a refused journal
 * destructively, so resuming one here would only reproduce the refusal.
 * When more than one live candidate exists (should not happen in practice —
 * this function is what prevents it — but a manually-edited keystore or a
 * pre-D2 stray journal could produce one), the most recently updated one is
 * preferred, on the theory that it is the attempt most likely still moving.
 */
export function findResumableGitvaultJournal(keystore: GitvaultKeystore, orgId: string, projectId: string): GitvaultCreationJournal | null {
  const candidates = listIncompleteGitvaultJournals(keystore).filter(
    (j) => j.org_id === orgId && j.project_id === projectId && j.refusal === null,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return candidates[0]!;
}

export class GitvaultCreation {
  private readonly keystore: GitvaultKeystore;
  private readonly transport: GitvaultCreationTransport;
  private readonly now: () => Date;
  private readonly options: GitvaultCreationOptions;
  private journal: GitvaultCreationJournal;
  private resumed = false;

  private constructor(options: GitvaultCreationOptions, journal: GitvaultCreationJournal, resumed: boolean) {
    this.options = options;
    this.keystore = options.keystore;
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date());
    this.journal = journal;
    this.resumed = resumed;
  }

  /**
   * Open a creation: resume the journal for `client_creation_id` when one
   * exists, else write stage 1 (LOCAL_KEYS_PREPARED). Nothing here touches the
   * network; no ciphertext exists yet.
   */
  static open(options: GitvaultCreationOptions): GitvaultCreation {
    const ks = options.keystore;
    const identity = ks.ensureIdentity();
    const signing = ks.signingKeypair(identity);
    const encryption = ks.encryptionKeypair(identity);
    if (!signing || !encryption) {
      fail("GITVAULT_READ_ONLY", "this principal cannot create a vault: a private key is missing from identity.json", "opening gitvault creation", { signing_key_present: Boolean(signing), encryption_key_present: Boolean(encryption) });
    }
    const id = options.client_creation_id ?? newHex32();
    const existing = readGitvaultJournal(ks, id);
    if (existing) {
      if (existing.org_id !== options.org_id || existing.project_id !== options.project_id) {
        fail("VAULT_CREATION_CONFLICT", "journal belongs to a different org/project", "resuming gitvault creation", { client_creation_id: id });
      }
      if (existing.creator_signing_fingerprint !== identity.signing_fingerprint || existing.creator_encryption_fingerprint !== identity.encryption_fingerprint) {
        fail("VAULT_CREATION_CONFLICT", "journal was prepared by a different identity; refusing the destructive retry", "resuming gitvault creation", { client_creation_id: id });
      }
      return new GitvaultCreation(options, existing, true);
    }
    const at = formatGitvaultTimestamp((options.now ?? (() => new Date()))());
    const journal: GitvaultCreationJournal = {
      version: 1,
      stage: "LOCAL_KEYS_PREPARED",
      client_creation_id: id,
      org_id: options.org_id,
      project_id: options.project_id,
      creator_signing_fingerprint: identity.signing_fingerprint,
      creator_encryption_fingerprint: identity.encryption_fingerprint,
      created_at: at,
      updated_at: at,
      allocation: null,
      k_repo_hex: null,
      objects: [],
      genesis: null,
      genesis_sha256: null,
      recovery_receipt: null,
      refusal: null,
    };
    const c = new GitvaultCreation(options, journal, false);
    c.persist();
    return c;
  }

  get current(): GitvaultCreationJournal {
    return this.journal;
  }

  private persist(): void {
    this.journal = { ...this.journal, updated_at: formatGitvaultTimestamp(this.now()) };
    writeFileAtomic0600(gitvaultJournalPath(this.keystore, this.journal.client_creation_id), JSON.stringify(this.journal, null, 2));
    this.keystore.audit("journal_stage", this.journal.allocation?.repo_id, { client_creation_id: this.journal.client_creation_id, stage: this.journal.stage });
  }

  private async advance(stage: GitvaultCreationStage, patch: Partial<GitvaultCreationJournal>): Promise<void> {
    this.journal = { ...this.journal, ...patch, stage };
    this.persist();
    await this.options.onStage?.(stage, this.journal);
  }

  private refuse(code: "VAULT_CREATION_CONFLICT" | "ALLOCATION_SUPERSEDED", message: string, details?: Record<string, unknown>): never {
    this.journal = { ...this.journal, refusal: { code, at: formatGitvaultTimestamp(this.now()), ...(details ? { details } : {}) } };
    this.persist();
    fail(code, message, "reconciling gitvault creation", { client_creation_id: this.journal.client_creation_id, ...details });
  }

  /**
   * Drive the journal to ACTIVE from whatever stage is durable. Safe to call
   * again after any crash; a refused journal stays refused.
   */
  async run(): Promise<GitvaultCreationResult> {
    if (this.journal.refusal) {
      fail(this.journal.refusal.code, "this creation attempt was refused earlier; start a new attempt (the journal is kept for diagnosis)", "resuming gitvault creation", {
        client_creation_id: this.journal.client_creation_id,
        refused_at: this.journal.refusal.at,
        ...this.journal.refusal.details,
      });
    }
    const identity = this.keystore.ensureIdentity();
    const signing = this.keystore.signingKeypair(identity)!;
    const encryption = this.keystore.encryptionKeypair(identity)!;

    // ── 2. ALLOCATED ──
    if (this.journal.stage === "LOCAL_KEYS_PREPARED") {
      const allocation = await this.transport.allocate({
        client_creation_id: this.journal.client_creation_id,
        org_id: this.journal.org_id,
        project_id: this.journal.project_id,
        // PUBKEYS on the request; the returned record carries the fingerprints
        // the gateway derives from them. See GitvaultAllocateRequest.
        creator_signing_pubkey: identity.signing_pubkey,
        creator_encryption_pubkey: identity.encryption_pubkey,
      });
      this.verifyAllocation(allocation);
      await this.advance("ALLOCATED", { allocation });
    }
    const allocation = this.journal.allocation!;
    const repoId = allocation.repo_id;
    const epoch = GITVAULT_GENESIS_EPOCH;

    // ── 3. OBJECTS_PREPARED — the FIRST point at which ciphertext exists ──
    if (this.journal.stage === "ALLOCATED") {
      const kRepo = randomBytes(32);
      const sealed = await sealKeyEnvelope({
        k_repo: kRepo,
        repo_id: repoId,
        epoch,
        recipient_public_key: encryption.public_key,
        signer: signing,
        created_at: formatGitvaultTimestamp(this.now()),
      });
      const object: GitvaultJournaledObject = {
        object_kind: "key_envelope",
        path: envelopePath(epoch, sealed.receipt.recipient_fingerprint),
        stored_bytes_b64u: b64u(sealed.stored_bytes),
        stored_bytes_sha256: sealed.stored_bytes_sha256,
        size_bytes: sealed.size_bytes,
        receipt: sealed.receipt,
        finalized: false,
      };
      await this.advance("OBJECTS_PREPARED", { k_repo_hex: bytesToHex(kRepo), objects: [object] });
    }

    // ── 4. OBJECTS_FINALIZED — PUT (or read-and-compare after a crash), never re-encrypt ──
    if (this.journal.stage === "OBJECTS_PREPARED") {
      const objects = this.journal.objects.map((o) => ({ ...o }));
      for (const object of objects) {
        if (object.finalized) continue;
        const bytes = unb64u(object.stored_bytes_b64u);
        if (sha256Hex(bytes) !== object.stored_bytes_sha256 || String(bytes.length) !== object.size_bytes) {
          this.refuse("VAULT_CREATION_CONFLICT", "journaled object bytes do not match their journaled hash; refusing the destructive retry", { path: object.path });
        }
        const remote = await this.transport.getObject({ repo_id: repoId, path: object.path });
        if (remote) {
          if (!bytesEqual(remote, bytes)) {
            this.refuse("VAULT_CREATION_CONFLICT", "an object already exists at this path with different bytes", { path: object.path, remote_sha256: sha256Hex(remote) });
          }
          object.finalized = true;
          continue;
        }
        const receipt = await this.transport.putObject({ repo_id: repoId, path: object.path, bytes, expected_sha256: object.stored_bytes_sha256, expected_size_bytes: object.size_bytes });
        if (receipt.stored_bytes_sha256 !== object.stored_bytes_sha256 || receipt.size_bytes !== object.size_bytes) {
          this.refuse("VAULT_CREATION_CONFLICT", "the server's finalization receipt does not match the local manifest", { path: object.path, receipt });
        }
        object.finalized = true;
      }
      await this.advance("OBJECTS_FINALIZED", { objects });
    }

    // ── 5. GENESIS_PREPARED — exact stored bytes + hash journaled before the admission PUT ──
    if (this.journal.stage === "OBJECTS_FINALIZED") {
      const envelopeObject = this.journal.objects.find((o) => o.object_kind === "key_envelope");
      if (!envelopeObject) this.refuse("VAULT_CREATION_CONFLICT", "journal has no finalized key_envelope");
      const genesis = buildVaultGenesis({
        repo_id: repoId,
        org_id: this.journal.org_id,
        project_id: this.journal.project_id,
        allocation_nonce: allocation.allocation_nonce,
        creator_signing: signing,
        creator_encryption_public_key: encryption.public_key,
        envelope_receipt: envelopeObject.receipt,
        created_at: formatGitvaultTimestamp(this.now()),
      });
      const storedEnvelope = parseGitvaultStrict(new TextDecoder().decode(unb64u(envelopeObject.stored_bytes_b64u))) as GitvaultKeyEnvelope;
      const bindings = checkGenesisKeyBindings(genesis, storedEnvelope);
      if (bindings.length > 0) this.refuse("VAULT_CREATION_CONFLICT", "prepared genesis fails its own key bindings", { problems: bindings });
      await this.advance("GENESIS_PREPARED", { genesis, genesis_sha256: sha256Hex(storedBytes(genesis as unknown as GitvaultSignedObject)) });
    }

    // ── 6. ACTIVE — admit; on resume read back; foreign genesis is a refusal ──
    if (this.journal.stage === "GENESIS_PREPARED") {
      const genesis = this.journal.genesis!;
      const bytes = storedBytes(genesis as unknown as GitvaultSignedObject);
      const hash = sha256Hex(bytes);
      if (hash !== this.journal.genesis_sha256) this.refuse("VAULT_CREATION_CONFLICT", "journaled genesis bytes do not match their journaled hash");
      const existing = await this.transport.getGenesis({ repo_id: repoId });
      if (existing) {
        if (!bytesEqual(existing, bytes)) {
          this.refuse("VAULT_CREATION_CONFLICT", "a different genesis is already admitted for this repo_id (foreign genesis); never overwritten", { admitted_sha256: sha256Hex(existing) });
        }
      } else {
        const result = await this.transport.admitGenesis({ repo_id: repoId, allocation_generation: allocation.allocation_generation, stored_bytes: bytes, stored_bytes_sha256: hash });
        if (result.outcome === "allocation_superseded") {
          this.refuse("ALLOCATION_SUPERSEDED", "the allocation was reclaimed by the owner; this client must not publish", { allocation_generation: allocation.allocation_generation });
        }
        if (result.admitted_sha256 !== hash) {
          this.refuse("VAULT_CREATION_CONFLICT", "admission canonized a different genesis than the one prepared here", { admitted_sha256: result.admitted_sha256 });
        }
      }
      const receipt = buildRecoveryReceipt({
        repo_id: repoId,
        org_id: this.journal.org_id,
        project_id: this.journal.project_id,
        genesis_sha256: hash,
        creator_signing: signing,
        creator_encryption_public_key: encryption.public_key,
      });
      // Pin + K_repo move into the repo file, then the receipt, then the journal flips — so a
      // crash between them leaves a GENESIS_PREPARED journal whose resume is an idempotent read-back.
      this.keystore.saveRepo({
        repo_id: repoId,
        org_id: this.journal.org_id,
        project_id: this.journal.project_id,
        k_repo_hex: this.journal.k_repo_hex!,
        epoch,
        genesis_sha256: hash,
        head_pin: null,
        last_ref_transaction: null,
        provenance: "created",
      });
      this.keystore.saveRecoveryReceipt(receipt);
      await this.advance("ACTIVE", { recovery_receipt: receipt });
    }

    return {
      repo_id: repoId,
      genesis_sha256: this.journal.genesis_sha256!,
      recovery_receipt: this.journal.recovery_receipt!,
      journal: this.journal,
      how: this.resumed ? "reconciled" : "created",
    };
  }

  private verifyAllocation(allocation: GitvaultAllocation): void {
    const problems = checkAllocation(
      allocation,
      {
        client_creation_id: this.journal.client_creation_id,
        creator_signing_fingerprint: this.journal.creator_signing_fingerprint,
        creator_encryption_fingerprint: this.journal.creator_encryption_fingerprint,
        org_id: this.journal.org_id,
        project_id: this.journal.project_id,
      },
      this.options.service_public_key,
    );
    if (problems.length > 0) {
      fail("GITVAULT_ALLOCATION_INVALID", "allocation does not match this creation attempt", "verifying gitvault allocation", { problems });
    }
    if (allocation.status === "superseded") {
      this.refuse("ALLOCATION_SUPERSEDED", "the allocation was reclaimed by the owner; this client must not resume", { allocation_generation: allocation.allocation_generation });
    }
  }
}

/** Convenience: open + run in one call. */
export async function createGitvault(options: GitvaultCreationOptions): Promise<GitvaultCreationResult> {
  return GitvaultCreation.open(options).run();
}

// ─── Doctor text ─────────────────────────────────────────────────────────────

/** What `doctor`/`status` print about V0-A recovery — the verbatim statement plus the pointers it must carry. */
export interface GitvaultDoctorRecoveryText {
  statement: typeof GITVAULT_TERMINAL_LOSS_STATEMENT;
  doctor_text: typeof GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT;
  /** The platform's custodial restore of deployed artifacts (the deploy lane's CAS) — the support path when every principal envelope is lost. */
  cas_restore_pointer: string;
}

export function gitvaultDoctorRecoveryText(): GitvaultDoctorRecoveryText {
  return {
    statement: GITVAULT_TERMINAL_LOSS_STATEMENT,
    doctor_text: GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT,
    cas_restore_pointer: "The platform custodially holds the plaintext source artifacts of every DEPLOY in its CAS; ask support for a custodial restore of deployed artifacts. Vault HISTORY (commits never deployed) is not recoverable without a surviving principal keystore.",
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function unb64u(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
