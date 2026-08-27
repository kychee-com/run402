/**
 * gitvault-mirror-and-recover — `r402s-recover`, the offline recovery engine
 * (design D4/D5, tasks 3.1–3.5).
 *
 * Turns a mirrored `source/<repo_id>/` prefix (any {@link GitvaultMirrorBackend}
 * — S3 or a local directory) plus a pin (the keystore's recovery receipt, or
 * one supplied explicitly) into a working git repository, with NO SERVER
 * INVOLVED: everything here reads from the {@link GitvaultMirrorBackend}
 * alone. Only the decrypt/materialize step touches key material (design D5)
 * — discovery, chain verification, and closure/absence adjudication run
 * keylessly and are a first-class outcome on their own (`run402 repos fsck
 * --mirror`), not a degraded mode of the keyed path.
 *
 * Reuses the SAME pure protocol functions the live SDK verifies pushes with
 * ({@link checkChainLink}, {@link assertNoTransition}, {@link
 * checkClaimSetEquality}, {@link gitvaultPaths}) — this file adds no new
 * protocol semantics, exactly per the design doc's "recovery is the keyed
 * offline subset of machinery that already exists."
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { LocalError } from "../errors.js";
import {
  GITVAULT_GENESIS_EPOCH,
  GITVAULT_GENESIS_GENERATION,
  GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
  GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
  checkGenesisKeyBindings,
  checkRecoveryReceipt,
  deriveDigestKey,
  deriveObjectKey,
  generateEncryptionKeypair,
  hexToBytes,
  keyedCommitment,
  objectsetContent,
  openFrame,
  openKeyEnvelope,
  parseGitvaultStrict,
  verifyGitvaultObject,
} from "../namespaces/gitvault.crypto.js";
import type {
  GitvaultCheckpointClaimSet,
  GitvaultCheckpointManifest,
  GitvaultHead,
  GitvaultKeyEnvelope,
  GitvaultRecoveryReceipt,
  GitvaultRefState,
  GitvaultRetentionRoots,
  GitvaultSignedObject,
  GitvaultVaultGenesis,
} from "../namespaces/gitvault.types.js";
import { assertNoTransition, checkChainLink, checkClaimSetEquality, gitvaultPaths, nextGeneration } from "./gitvault-publication.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { hardenedGit, hasObject } from "./gitvault-snapshot.js";
import type { GitvaultMirrorBackend } from "./gitvault-mirror-backend.js";

function fail(code: string, message: string, context: string, details?: unknown, nextActions?: unknown[]): never {
  throw new LocalError(message, context, { code, details, ...(nextActions ? { next_actions: nextActions } : {}) });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ─── Discovery + chain verification (task 3.1) ────────────────────────────────

export interface GitvaultChainEntry {
  generation: string;
  head: GitvaultHead;
  head_sha256: string;
}

export interface GitvaultChainBreak {
  generation: string;
  reason: string;
}

export interface GitvaultDiscoveryResult {
  repo_id: string;
  genesis: GitvaultVaultGenesis;
  genesis_sha256: string;
  /** How the genesis was authenticated. `unauthenticated_salvage` is a real, first-class outcome (protocol §5.1 vocabulary) — never silently upgraded to "trusted". */
  pin_trust: "receipt" | "unauthenticated_salvage";
  /** Every fully chain-verified head, genesis excluded, generation 1..N ascending. */
  chain: GitvaultChainEntry[];
  /** The newest fully-verified generation — `"0000000000000000"` (genesis) when the chain is empty. */
  newest_generation: string;
  newest_head_sha256: string;
  /** Non-null when the walk stopped because a head FAILED verification (a broken chain, not merely "nothing further is mirrored"). Recovery falls back to `newest_generation` either way — this field is what distinguishes an honest fallback from a quiet one. */
  chain_break: GitvaultChainBreak | null;
}

export interface GitvaultDiscoverOptions {
  backend: GitvaultMirrorBackend;
  /** An explicit pin, overriding the keystore's stored receipt. */
  recovery_receipt?: GitvaultRecoveryReceipt;
  /** Consulted only when `recovery_receipt` is omitted, keyed by the genesis's OWN `repo_id` (read from the mirror first). */
  keystore?: GitvaultKeystore;
}

/**
 * List `head/`, pin-check the genesis, and walk `prev_sha256` from genesis to
 * the newest generation this mirror both HOLDS and can VERIFY. A signature or
 * chain-link failure at generation K stops the walk at K-1 (`chain_break`
 * names why); a generation simply absent from the mirror also stops the walk
 * there, with `chain_break: null` (nothing further was ever pushed here, or
 * hasn't been synced yet — not evidence of corruption).
 *
 * A PIN MISMATCH is the one hard, no-fallback refusal (`VAULT_CREATION_CONFLICT`):
 * a substituted vault must never be silently accepted at "whatever chain
 * verifies", because a substituted vault's own chain verifies perfectly
 * against ITS OWN (different) creator key.
 */
export async function discoverAndVerifyChain(options: GitvaultDiscoverOptions): Promise<GitvaultDiscoveryResult> {
  const { backend } = options;
  const genesisBytes = await backend.get(gitvaultPaths.head(GITVAULT_GENESIS_GENERATION));
  if (!genesisBytes) fail("CHAIN_BROKEN", "the mirror holds no genesis (head/0000000000000000) — nothing to recover", "discovering gitvault vault from mirror", { destination: backend.describe() });
  const genesis = parseGitvaultStrict(new TextDecoder().decode(genesisBytes)) as GitvaultVaultGenesis;
  if (genesis.object_kind !== "vault_genesis") fail("CHAIN_BROKEN", "head/0000000000000000 is not a vault_genesis object", "discovering gitvault vault from mirror");
  if (!verifyGitvaultObject(genesis as unknown as GitvaultSignedObject, genesis.creator_signing_pubkey)) {
    fail("GITVAULT_SIGNATURE_INVALID", "vault_genesis signature does not verify under its own claimed creator key", "discovering gitvault vault from mirror", { repo_id: genesis.repo_id });
  }
  const genesisSha = sha256Hex(genesisBytes);

  const receipt = options.recovery_receipt ?? options.keystore?.readRecoveryReceipt(genesis.repo_id) ?? null;
  let pinTrust: "receipt" | "unauthenticated_salvage" = "unauthenticated_salvage";
  if (receipt) {
    const problems = checkRecoveryReceipt(receipt, genesis);
    if (problems.length > 0) {
      fail(
        "VAULT_CREATION_CONFLICT",
        `the recovery receipt does not pin this mirror's genesis (${problems.join(", ")}) — this mirror may hold a SUBSTITUTED vault; refusing to recover from it`,
        "discovering gitvault vault from mirror",
        { repo_id: genesis.repo_id, problems, expected_genesis_sha256: receipt.genesis_sha256, observed_genesis_sha256: genesisSha },
        [{ action: "verify the mirror destination and pin are the ones you intend — do not retry with a different receipt to make this pass" }],
      );
    }
    pinTrust = "receipt";
  }

  const chain: GitvaultChainEntry[] = [];
  let prevHash = genesisSha;
  let prevGen: string = GITVAULT_GENESIS_GENERATION;
  let chainBreak: GitvaultChainBreak | null = null;
  for (;;) {
    const nextGen = nextGeneration(prevGen);
    const bytes = await backend.get(gitvaultPaths.head(nextGen));
    if (!bytes) break; // natural end — the mirror holds nothing further at this generation
    let head: GitvaultHead;
    try {
      head = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
      checkChainLink({
        head, stored_bytes: bytes, listed_sha256: sha256Hex(bytes), expected_generation: nextGen, prev_sha256: prevHash,
        repo_id: genesis.repo_id, writer_public_key: genesis.creator_signing_pubkey, writer_key_id: genesis.writer_key_id,
      });
      assertNoTransition(head);
    } catch (e) {
      chainBreak = { generation: nextGen, reason: e instanceof Error ? e.message : String(e) };
      break;
    }
    const headSha = sha256Hex(bytes);
    chain.push({ generation: nextGen, head, head_sha256: headSha });
    prevHash = headSha;
    prevGen = nextGen;
  }

  return {
    repo_id: genesis.repo_id, genesis, genesis_sha256: genesisSha, pin_trust: pinTrust, chain,
    newest_generation: prevGen, newest_head_sha256: prevHash, chain_break: chainBreak,
  };
}

// ─── Closure resolution + absence adjudication (task 3.2) — KEYLESS ──────────

export interface GitvaultRequiredObject {
  key: string;
  object_id: string;
  kind: "ref_state" | "retention_roots" | "wal_pack" | "checkpoint_claim_set" | "checkpoint_manifest" | "checkpoint_pack";
}

export interface GitvaultAbsenceAdjudication {
  object_id: string;
  key: string;
  /** `intentionally_pruned` when a stored `prune_intent` names this object id — never corruption; `unexplained_absence` otherwise — a real loss, named rather than silently skipped. */
  adjudication: "intentionally_pruned" | "unexplained_absence";
  prune_intent_object_id: string | null;
}

/**
 * The required object set for one generation, resolved KEYLESSLY:
 * `checkpoint_claim_set` is plaintext-structured (never encrypted, protocol
 * §4.7) precisely so ITS ordered pack receipts enumerate every checkpoint
 * pack + manifest id without decryption — closure resolution never needs a
 * key. Walks back from `head` to the nearest checkpoint-bearing ancestor (or
 * genesis) collecting each head's own carriers + WAL entries along the way.
 */
export async function closureForGeneration(backend: GitvaultMirrorBackend, chain: readonly GitvaultChainEntry[], targetGeneration: string): Promise<GitvaultRequiredObject[]> {
  const byGen = new Map(chain.map((e) => [e.generation, e]));
  const out: GitvaultRequiredObject[] = [];
  let gen = targetGeneration;
  for (;;) {
    if (gen === GITVAULT_GENESIS_GENERATION) break;
    const entry = byGen.get(gen);
    if (!entry) fail("CHAIN_BROKEN", `generation ${gen} is not in the verified chain`, "resolving gitvault recovery closure", { generation: gen });
    out.push({ key: gitvaultPaths.refState(entry.head.ref_state.object_id), object_id: entry.head.ref_state.object_id, kind: "ref_state" });
    out.push({ key: gitvaultPaths.retentionRoots(entry.head.retention_roots.object_id), object_id: entry.head.retention_roots.object_id, kind: "retention_roots" });
    if (entry.head.checkpoint) {
      const claimSetId = entry.head.checkpoint.claim_set.object_id;
      out.push({ key: gitvaultPaths.claimSet(claimSetId), object_id: claimSetId, kind: "checkpoint_claim_set" });
      // The claim set's OWN content (plaintext-structured — no decryption)
      // enumerates the manifest + every pack. Missing claim-set bytes stop
      // enumeration here; the caller's adjudication loop reports it, and
      // enumeration simply cannot go further without it (honest, not silent).
      const claimBytes = await backend.get(gitvaultPaths.claimSet(claimSetId));
      if (claimBytes) {
        const claimSet = parseGitvaultStrict(new TextDecoder().decode(claimBytes)) as GitvaultCheckpointClaimSet;
        out.push({ key: gitvaultPaths.checkpointManifest(claimSet.manifest_receipt.object_id), object_id: claimSet.manifest_receipt.object_id, kind: "checkpoint_manifest" });
        for (const p of claimSet.ordered_pack_receipts) out.push({ key: gitvaultPaths.checkpointPack(p.object_id), object_id: p.object_id, kind: "checkpoint_pack" });
      }
      break; // the checkpoint's recovery bundle is self-contained; no earlier WAL is needed
    }
    for (const w of entry.head.wal_entries) out.push({ key: gitvaultPaths.wal(w.object_id), object_id: w.object_id, kind: "wal_pack" });
    gen = generationMinusOne(gen);
  }
  return out;
}

function generationMinusOne(generation: string): string {
  return (BigInt(`0x${generation}`) - 1n).toString(16).padStart(16, "0");
}

/**
 * Check presence of every required object; for each ABSENT one, check the
 * mirror's OWN stored `prune_intent` objects (plaintext-structured, keyless)
 * for a delete-set entry naming it. Never a silent skip: every absence is
 * adjudicated one way or the other, and the caller decides what to do with an
 * `unexplained_absence` (typically: fall back one generation, see {@link
 * recoverWithFallback}).
 */
export async function adjudicateAbsences(backend: GitvaultMirrorBackend, required: readonly GitvaultRequiredObject[]): Promise<GitvaultAbsenceAdjudication[]> {
  const missing: GitvaultRequiredObject[] = [];
  for (const r of required) {
    const meta = await backend.head(r.key);
    if (!meta) missing.push(r);
  }
  if (missing.length === 0) return [];
  const pruneKeys = (await backend.list("prune/")).filter((k) => k.endsWith(".intent.json"));
  const intents: Array<{ object_id: string; delete_set: Set<string> }> = [];
  for (const key of pruneKeys) {
    const bytes = await backend.get(key);
    if (!bytes) continue;
    try {
      const intent = parseGitvaultStrict(new TextDecoder().decode(bytes)) as { object_id: string; core?: { delete_set?: Array<{ object_id: string }> } };
      intents.push({ object_id: intent.object_id, delete_set: new Set((intent.core?.delete_set ?? []).map((d) => d.object_id)) });
    } catch {
      /* an unreadable prune intent adjudicates nothing; the missing object stays unexplained */
    }
  }
  return missing.map((m): GitvaultAbsenceAdjudication => {
    const covering = intents.find((i) => i.delete_set.has(m.object_id));
    return {
      object_id: m.object_id, key: m.key,
      adjudication: covering ? "intentionally_pruned" : "unexplained_absence",
      prune_intent_object_id: covering?.object_id ?? null,
    };
  });
}

// ─── Recovery report shape (verify + full recover share it) ──────────────────

export interface GitvaultRecoveryReport {
  repo_id: string;
  genesis_sha256: string;
  pin_trust: "receipt" | "unauthenticated_salvage";
  /** The generation recovery actually landed on — may be BELOW the chain's newest fully-verified generation when generation fallback fired. */
  recovered_generation: string;
  /** Non-null iff the chain walk itself broke (see {@link GitvaultDiscoveryResult.chain_break}). */
  chain_break: GitvaultChainBreak | null;
  /** Every absence encountered while resolving closures, across every generation tried, oldest attempt first. */
  absences: GitvaultAbsenceAdjudication[];
  /** True iff any absence was `unexplained_absence` — the loud, un-missable flag; never buried in a nested field. */
  data_loss_detected: boolean;
  validity_not_freshness: typeof GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT;
  keystore_still_required: typeof GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT;
}

// ─── Keyless mode (task 3.3) ──────────────────────────────────────────────────

export interface GitvaultVerifyReport extends GitvaultRecoveryReport {
  mode: "keyless_verify";
  /** Object kinds present + confirmed reachable for the recovered generation, counted (never bytes, never plaintext). */
  inventory: Record<string, number>;
}

/**
 * Discovery + chain verification + closure/absence adjudication, WITHOUT
 * touching any key material — `run402 repos fsck --mirror`. Reports the
 * recoverable generation and an inventory; never decrypts, never
 * materializes. A genuinely keyless integrity probe (design D5) — useful as a
 * CI check that never needs a secret.
 */
export async function verifyGitvaultMirror(backend: GitvaultMirrorBackend, options: { recovery_receipt?: GitvaultRecoveryReceipt; keystore?: GitvaultKeystore } = {}): Promise<GitvaultVerifyReport> {
  const discovery = await discoverAndVerifyChain({ backend, ...options });
  const { generation, absences } = await resolveWithFallback(backend, discovery, { requireMaterializable: false });
  const inventory: Record<string, number> = {};
  if (generation !== GITVAULT_GENESIS_GENERATION) {
    const required = await closureForGeneration(backend, discovery.chain, generation);
    for (const r of required) inventory[r.kind] = (inventory[r.kind] ?? 0) + 1;
  }
  return {
    repo_id: discovery.repo_id, genesis_sha256: discovery.genesis_sha256, pin_trust: discovery.pin_trust,
    recovered_generation: generation, chain_break: discovery.chain_break, absences,
    data_loss_detected: absences.some((a) => a.adjudication === "unexplained_absence"),
    validity_not_freshness: GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
    keystore_still_required: GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
    mode: "keyless_verify", inventory,
  };
}

/** Try `discovery.newest_generation`, then fall back one generation at a time on `unexplained_absence`, recording every adjudication along the way (never a silent skip — task 3.2). */
async function resolveWithFallback(backend: GitvaultMirrorBackend, discovery: GitvaultDiscoveryResult, options: { requireMaterializable: boolean }): Promise<{ generation: string; absences: GitvaultAbsenceAdjudication[] }> {
  const allAbsences: GitvaultAbsenceAdjudication[] = [];
  let gen = discovery.newest_generation;
  for (;;) {
    if (gen === GITVAULT_GENESIS_GENERATION) return { generation: gen, absences: allAbsences };
    const required = await closureForGeneration(backend, discovery.chain, gen);
    const absences = await adjudicateAbsences(backend, required);
    allAbsences.push(...absences);
    const unexplained = absences.filter((a) => a.adjudication === "unexplained_absence");
    if (unexplained.length === 0) return { generation: gen, absences: allAbsences };
    if (!options.requireMaterializable) {
      // Keyless verify still names the generation it landed on as the OLDEST
      // one with no unexplained gap, same fallback the keyed path takes.
      gen = generationMinusOne(gen);
      continue;
    }
    gen = generationMinusOne(gen);
  }
}

// ─── Materialization + §4.7 acceptance (task 3.4/3.5) ─────────────────────────

export interface GitvaultRecoverResult extends GitvaultRecoveryReport {
  mode: "recovered";
  out_dir: string;
  refs: Record<string, string>;
  head_target: { kind: "symref"; ref: string } | { kind: "detached"; oid: string };
  /**
   * `out_dir` is a BARE repository (`git init --bare`) — objects/refs/HEAD
   * directly in `out_dir`, no working files. This is deliberate and matches
   * every other on-disk gitvault layout; it is named explicitly here (rather
   * than left for the reader to discover via `ls`) because a bare directory
   * with no working tree reads as a failed or empty recovery otherwise
   * (dogfood item 3). See `next_actions` for how to get working files.
   */
  layout: "bare";
  /** `git clone <out_dir> <out_dir>-worktree` — materializes working files from the bare recovery above. */
  next_actions: { action: string; command: string }[];
}

export interface GitvaultRecoverOptions {
  backend: GitvaultMirrorBackend;
  out_dir: string;
  recovery_receipt?: GitvaultRecoveryReceipt;
  keystore?: GitvaultKeystore;
}

/** Open the recipient's key envelope for this genesis and decrypt K_repo — the ONE step in this whole file that touches key material. */
async function resolveKRepo(backend: GitvaultMirrorBackend, genesis: GitvaultVaultGenesis, keystore: GitvaultKeystore): Promise<Uint8Array> {
  const identity = keystore.readIdentity();
  if (!identity?.encryption_private_key_hex) {
    fail("VAULT_UNRECOVERABLE", "no encryption key in this keystore — recovery can verify and adjudicate but cannot decrypt or materialize anything", "materializing gitvault recovery", undefined, [
      { action: "restore the principal keystore (identity.json) from backup, then re-run recover" },
      { action: "run `run402 repos fsck --mirror` for the verify-only outcome" },
    ]);
  }
  if (genesis.envelopes.length === 0) fail("VAULT_CREATION_CONFLICT", "genesis carries no key envelope", "materializing gitvault recovery");
  // Task 5.3 follow-up (gateway diagnosis confirmed 2026-08-26: a real vault
  // can carry MORE than one key_envelope ledger row — a foreign recipient's
  // envelope is the norm on a multi-recipient vault, never an anomaly). A
  // genesis's own `envelopes[]` has always had exactly one entry so far (the
  // creator's, minted at the six-stage creation — later reconcile-added
  // envelopes are separate ledger rows, never appended to the SIGNED
  // genesis), which is why blindly reading index 0 happened to be correct.
  // SELECT BY FINGERPRINT EXPLICITLY instead of by position: this machine
  // can only ever decrypt ITS OWN envelope (the recipient-only read gate
  // means the mirror never even holds anyone else's — see
  // `keyEnvelopeRecipientFingerprintFromKey`/`skipped_foreign_recipient` in
  // `gitvault-mirror.ts`), so this function never looks for, and never fails
  // on, a FOREIGN envelope being absent — that is silent-OK. A missing OWN
  // envelope in genesis.envelopes (no entry matches our fingerprint at all)
  // is its own distinct, honest refusal, separate from "the mirror never
  // synced the bytes for an envelope genesis DOES name for us" below.
  const envelopeReceipt = genesis.envelopes.find((e) => e.recipient_fingerprint === identity.encryption_fingerprint);
  if (!envelopeReceipt) {
    fail("GITVAULT_ENVELOPE_NOT_FOR_RECIPIENT", "genesis carries no key envelope for this machine's identity — this keystore is not a recipient of this vault", "materializing gitvault recovery", { own_fingerprint: identity.encryption_fingerprint });
  }
  // `key-envelopes/<epoch>/<recipient_fingerprint>.env` — the GATEWAY's real
  // §3 wire key (`upload-sessions.ts` `UPLOADABLE_KINDS.key_envelope.key()`,
  // mirrored by `storage-keys.ts` `objectKeyFor`), matching protocol §3
  // exactly. The SDK's OWN `gitvault-creation-journal.ts` envelope `path`
  // string (`envelopes/<epoch>/<fp>`) is a DIFFERENT, client-local label used
  // only for the upload manifest ("never rides the wire") — the gateway
  // derives its own key independently and never echoes that string back, so
  // a mirror synced from the real objects listing never contains it.
  const envelopeBytes = await backend.get(`key-envelopes/${envelopeReceipt.epoch}/${envelopeReceipt.recipient_fingerprint}.env`);
  if (!envelopeBytes) fail("VAULT_UNRECOVERABLE", "the mirror holds no key envelope for this genesis — cannot derive K_repo", "materializing gitvault recovery");
  const envelope = parseGitvaultStrict(new TextDecoder().decode(envelopeBytes)) as GitvaultKeyEnvelope;
  const bindingProblems = checkGenesisKeyBindings(genesis, envelope);
  if (bindingProblems.length > 0) fail("VAULT_CREATION_CONFLICT", `genesis key bindings do not hold for the stored envelope (${bindingProblems.join(", ")})`, "materializing gitvault recovery", { problems: bindingProblems });
  if (envelope.recipient_fingerprint !== identity.encryption_fingerprint) {
    fail("GITVAULT_ENVELOPE_NOT_FOR_RECIPIENT", "the stored envelope is addressed to another principal — this keystore cannot open it", "materializing gitvault recovery", { recipient_fingerprint: envelope.recipient_fingerprint });
  }
  const kp = generateEncryptionKeypair(hexToBytes(identity.encryption_private_key_hex));
  return openKeyEnvelope({ envelope, recipient: kp, signer_public_key: genesis.creator_signing_pubkey });
}

async function openCarrier<T>(backend: GitvaultMirrorBackend, kRepo: Uint8Array, repoId: string, kind: "ref_state" | "retention_roots" | "checkpoint_manifest", objectId: string, ciphertextSha256: string, key: string): Promise<T> {
  const frame = await backend.get(key);
  if (!frame) fail("CHAIN_UNUSABLE", `${kind} ${objectId} is absent from the mirror`, "materializing gitvault recovery", { object_id: objectId });
  const plaintext = openFrame({ k_obj: deriveObjectKey(kRepo, repoId, GITVAULT_GENESIS_EPOCH, kind, objectId), repo_id: repoId, object_kind: kind, object_id: objectId, epoch: GITVAULT_GENESIS_EPOCH, frame, expected_ciphertext_sha256: ciphertextSha256 });
  return parseGitvaultStrict(new TextDecoder().decode(plaintext)) as T;
}

/**
 * Materialize the resolved generation into `out_dir` and run §4.7 restorer
 * acceptance: scratch restore, every covered ref at its EXACT oid, `git fsck`
 * full connectivity, recompute the three keyed commitments against the
 * checkpoint manifest when one covers this generation. Acceptance failure is
 * a typed non-zero exit (throws) — never a partial, silently-accepted repo.
 */
export async function recoverGitvaultMirror(options: GitvaultRecoverOptions): Promise<GitvaultRecoverResult> {
  // Task 5.3 follow-up (found via the live drill 2026-08-26): `out_dir` is
  // "where to materialize the recovered repository" — the CLI's own
  // documented example (`--out ./restored`) is a path that naturally does
  // NOT already exist, same expectation as `git clone <url> restored-dir`.
  // Every unit test happened to pass an already-`mkdtempSync`'d directory,
  // which is exactly why nothing ever created it here. Create it FIRST,
  // before any discovery/decrypt work, so a bad `out_dir` fails fast with a
  // truthful, typed error instead of the misleading `GIT_UNAVAILABLE` the
  // first `hardenedGit` call used to throw (see that function's own
  // `GIT_CWD_MISSING` disambiguation in `gitvault-snapshot.ts` — this is the
  // belt; that is the suspenders).
  try {
    mkdirSync(options.out_dir, { recursive: true });
  } catch (e) {
    fail("GITVAULT_RECOVER_OUT_DIR_UNWRITABLE", `could not create the recovery output directory: ${options.out_dir}`, "materializing gitvault recovery", { out_dir: options.out_dir, cause: e instanceof Error ? e.message : String(e) });
  }
  const { backend } = options;
  const keystore = options.keystore ?? GitvaultKeystore.open();
  const discovery = await discoverAndVerifyChain({ backend, ...(options.recovery_receipt ? { recovery_receipt: options.recovery_receipt } : {}), keystore });
  const { generation, absences } = await resolveWithFallback(backend, discovery, { requireMaterializable: true });
  if (generation === GITVAULT_GENESIS_GENERATION) {
    fail("CHECKPOINT_INCOMPLETE", "no generation could be fully materialized — every generation back to genesis has an unexplained missing object", "materializing gitvault recovery", { absences });
  }
  const kRepo = await resolveKRepo(backend, discovery.genesis, keystore);
  const entry = discovery.chain.find((e) => e.generation === generation)!;
  const repoId = discovery.repo_id;

  const refState = await openCarrier<GitvaultRefState>(backend, kRepo, repoId, "ref_state", entry.head.ref_state.object_id, entry.head.ref_state.ciphertext_sha256, gitvaultPaths.refState(entry.head.ref_state.object_id));
  const roots = await openCarrier<GitvaultRetentionRoots>(backend, kRepo, repoId, "retention_roots", entry.head.retention_roots.object_id, entry.head.retention_roots.ciphertext_sha256, gitvaultPaths.retentionRoots(entry.head.retention_roots.object_id));

  // ── restore into scratch: newest checkpoint's packs, then every later WAL pack ──
  const chainUpTo = discovery.chain.filter((e) => e.generation <= generation);
  const heads: GitvaultChainEntry[] = [];
  for (let i = chainUpTo.length - 1; i >= 0; i--) {
    heads.unshift(chainUpTo[i]!);
    if (chainUpTo[i]!.head.checkpoint) break;
  }
  await hardenedGit(options.out_dir, ["init", "-q", "--bare", "--object-format=sha1", "."]);
  let manifest: GitvaultCheckpointManifest | null = null;
  const first = heads[0]!;
  if (first.head.checkpoint) {
    const claimBytes = await backend.get(gitvaultPaths.claimSet(first.head.checkpoint.claim_set.object_id));
    if (!claimBytes) fail("CHECKPOINT_INCOMPLETE", "checkpoint claim set absent from the mirror", "materializing gitvault recovery");
    const claimSet = parseGitvaultStrict(new TextDecoder().decode(claimBytes)) as GitvaultCheckpointClaimSet;
    if (!verifyGitvaultObject(claimSet as unknown as GitvaultSignedObject, discovery.genesis.creator_signing_pubkey)) fail("CHECKPOINT_INCOMPLETE", "checkpoint claim set signature fails", "materializing gitvault recovery");
    manifest = await openCarrier<GitvaultCheckpointManifest>(backend, kRepo, repoId, "checkpoint_manifest", claimSet.manifest_receipt.object_id, claimSet.manifest_receipt.ciphertext_sha256, gitvaultPaths.checkpointManifest(claimSet.manifest_receipt.object_id));
    checkClaimSetEquality(claimSet, manifest, first.head.checkpoint.covers_through_generation);
    for (const p of manifest.packs) {
      const frame = await backend.get(gitvaultPaths.checkpointPack(p.object_id));
      if (!frame) fail("CHECKPOINT_INCOMPLETE", `checkpoint pack ${p.object_id} absent`, "materializing gitvault recovery");
      const plain = openFrame({ k_obj: deriveObjectKey(kRepo, repoId, GITVAULT_GENESIS_EPOCH, "checkpoint_pack", p.object_id), repo_id: repoId, object_kind: "checkpoint_pack", object_id: p.object_id, epoch: GITVAULT_GENESIS_EPOCH, frame, expected_ciphertext_sha256: p.ciphertext_sha256 });
      if (sha256Hex(plain) !== p.plaintext_sha256 || String(plain.length) !== p.plaintext_size_bytes) fail("CHECKPOINT_INCOMPLETE", `checkpoint pack ${p.object_id} plaintext mismatch`, "materializing gitvault recovery");
      await hardenedGit(options.out_dir, ["index-pack", "--stdin", "--strict"], { input: plain });
    }
  }
  for (const h of heads) {
    for (const w of h.head.wal_entries) {
      const frame = await backend.get(gitvaultPaths.wal(w.object_id));
      if (!frame) fail("CHAIN_UNUSABLE", `WAL pack ${w.object_id} absent`, "materializing gitvault recovery", { object_id: w.object_id });
      const plain = openFrame({ k_obj: deriveObjectKey(kRepo, repoId, GITVAULT_GENESIS_EPOCH, "wal_pack", w.object_id), repo_id: repoId, object_kind: "wal_pack", object_id: w.object_id, epoch: GITVAULT_GENESIS_EPOCH, frame, expected_ciphertext_sha256: w.ciphertext_sha256 });
      await hardenedGit(options.out_dir, ["index-pack", "--stdin", "--strict"], { input: plain });
    }
  }

  // ── every covered ref at its EXACT oid + HEAD (task 3.4) ──
  const coverageTips = new Set<string>(Object.values(refState.refs));
  for (const r of roots.roots) coverageTips.add(r.oid);
  if (refState.head_target.kind === "detached") coverageTips.add(refState.head_target.oid);
  for (const tip of coverageTips) {
    if (!(await hasObject(options.out_dir, tip))) fail("CHAIN_UNUSABLE", `covered tip ${tip} does not resolve after restore`, "materializing gitvault recovery", { oid: tip });
  }
  for (const [ref, oid] of Object.entries(refState.refs)) {
    await hardenedGit(options.out_dir, ["update-ref", ref, oid]);
  }
  if (refState.head_target.kind === "symref") await hardenedGit(options.out_dir, ["symbolic-ref", "HEAD", refState.head_target.ref]);
  else await hardenedGit(options.out_dir, ["update-ref", "--no-deref", "HEAD", refState.head_target.oid]);

  // ── git fsck --no-dangling, full connectivity (task 3.4) ──
  const fsck = await hardenedGit(options.out_dir, ["fsck", "--no-dangling", "--full", "--strict"], { okStatuses: [1, 2] });
  if (fsck.status !== 0) fail("CHECKPOINT_INCOMPLETE", `fsck reports missing connectivity after restore: ${fsck.stderr.slice(0, 500)}`, "materializing gitvault recovery");

  // ── recompute the three keyed commitments against the covering manifest (§4.7) ──
  if (manifest) {
    const kDigestRefmap = deriveDigestKey(kRepo, repoId, GITVAULT_GENESIS_EPOCH, "refmap");
    const kDigestRootset = deriveDigestKey(kRepo, repoId, GITVAULT_GENESIS_EPOCH, "rootset");
    const kDigestObjectset = deriveDigestKey(kRepo, repoId, GITVAULT_GENESIS_EPOCH, "objectset");
    const { signature: _s1, ...refStateContent } = refState;
    const { signature: _s2, ...rootsContent } = roots;
    const refmapOk = keyedCommitment(kDigestRefmap, refStateContent) === manifest.ref_state_hmac;
    const rootsetOk = keyedCommitment(kDigestRootset, rootsContent) === manifest.retention_roots_hmac;
    const sortedTips = [...coverageTips].sort();
    const restoredOids = sortedTips.length === 0 ? [] : (await hardenedGit(options.out_dir, ["rev-list", "--objects", "--no-object-names", ...sortedTips])).lines().map((l) => l.trim());
    const objectsetOk = keyedCommitment(kDigestObjectset, objectsetContent(restoredOids)) === manifest.object_set_hmac;
    if (!refmapOk || !rootsetOk || !objectsetOk) {
      fail("CHECKPOINT_INCOMPLETE", `restored state does not match the checkpoint's keyed commitments (refmap ${refmapOk ? "ok" : "MISMATCH"}, rootset ${rootsetOk ? "ok" : "MISMATCH"}, objectset ${objectsetOk ? "ok" : "MISMATCH"})`, "materializing gitvault recovery", { refmapOk, rootsetOk, objectsetOk });
    }
  }

  return {
    repo_id: repoId, genesis_sha256: discovery.genesis_sha256, pin_trust: discovery.pin_trust,
    recovered_generation: generation, chain_break: discovery.chain_break, absences,
    data_loss_detected: absences.some((a) => a.adjudication === "unexplained_absence"),
    validity_not_freshness: GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
    keystore_still_required: GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
    mode: "recovered", out_dir: options.out_dir, refs: refState.refs, head_target: refState.head_target,
    layout: "bare",
    next_actions: [
      { action: "the recovered repository is bare (no working files) — clone it to get a working tree", command: `git clone ${options.out_dir} ${options.out_dir}-worktree` },
    ],
  };
}
