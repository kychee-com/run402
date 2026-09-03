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
import { LocalError, isRun402Error } from "../errors.js";
import {
  GITVAULT_GENESIS_EPOCH,
  GITVAULT_GENESIS_GENERATION,
  GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
  GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
  bytesToHex,
  checkGenesisKeyBindings,
  checkRecoveryReceipt,
  deriveDigestKey,
  deriveObjectKey,
  ekFingerprint,
  generateEncryptionKeypair,
  hexToBytes,
  keyedCommitment,
  objectsetContent,
  openEpochRotationForRecipient,
  openFrame,
  openKeyEnvelope,
  parseGitvaultStrict,
  parseRotateEpochPayload,
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
import { assertNoTransition, checkChainLink, checkClaimSetEquality, gitvaultPaths, nextGeneration, reconcileRetainedTipRefs } from "./gitvault-publication.js";
import type { GitvaultEncounteredRotation, GitvaultEpochDecryptFailure, GitvaultRetainedRefsReconcileResult } from "./gitvault-publication.js";
import { GitvaultKeystore, type GitvaultIdentityFile } from "./gitvault-keystore.js";
import {
  discoverMemberBundles,
  parseMemberRecoveryBundle,
  unwrapMemberRecoveryBundle,
  type GitvaultMemberBundleHint,
  type GitvaultMemberRecoveryBundle,
} from "./gitvault-member-bundle.js";
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
  /**
   * Every admitted `rotate_epoch` transition this KEYLESS chain walk saw,
   * oldest first (D193, rev 42 — `checkChainLink`/`assertNoTransition` admit
   * it structurally without ever opening an envelope; recovery's keyed
   * decrypt step, below, is the only place a rotation's envelope is opened).
   */
  rotations: GitvaultEncounteredRotation[];
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
  let prevEpoch: string = GITVAULT_GENESIS_EPOCH;
  let chainBreak: GitvaultChainBreak | null = null;
  const rotations: GitvaultEncounteredRotation[] = [];
  for (;;) {
    const nextGen = nextGeneration(prevGen);
    const bytes = await backend.get(gitvaultPaths.head(nextGen));
    if (!bytes) break; // natural end — the mirror holds nothing further at this generation
    let head: GitvaultHead;
    try {
      head = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
      checkChainLink({
        head, stored_bytes: bytes, listed_sha256: sha256Hex(bytes), expected_generation: nextGen, prev_sha256: prevHash,
        repo_id: genesis.repo_id, writer_public_key: genesis.creator_signing_pubkey, writer_key_id: genesis.writer_key_id, prev_epoch: prevEpoch,
      });
      // D193, rev 42: `rotate_epoch` is a NO-THROW pass here — the keyless
      // chain walk continues right through it (`checkChainLink`'s own D194
      // epoch-continuity check already validated it structurally); the other
      // three transition kinds remain the genuine fail-closed stop.
      assertNoTransition(head);
      if (head.transition !== null && head.transition.kind === "rotate_epoch") {
        rotations.push({ generation: head.generation, epoch: head.epoch, payload: parseRotateEpochPayload(head) });
      }
    } catch (e) {
      chainBreak = { generation: nextGen, reason: e instanceof Error ? e.message : String(e) };
      break;
    }
    prevEpoch = head.epoch;
    const headSha = sha256Hex(bytes);
    chain.push({ generation: nextGen, head, head_sha256: headSha });
    prevHash = headSha;
    prevGen = nextGen;
  }

  return {
    repo_id: genesis.repo_id, genesis, genesis_sha256: genesisSha, pin_trust: pinTrust, chain,
    newest_generation: prevGen, newest_head_sha256: prevHash, chain_break: chainBreak, rotations,
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
  /**
   * The generation recovery actually landed on — may be BELOW
   * `chain_verified_to_generation` when either absence fallback (keyless or
   * keyed) OR — Request 4, D193-D203 rev 42 — an epoch this keystore cannot
   * open (`epoch_decrypt_failure`, non-null) capped it first, whichever is
   * more restrictive.
   */
  recovered_generation: string;
  /**
   * The newest generation the PURELY STRUCTURAL chain walk verified,
   * independent of any key material — this is `discoverAndVerifyChain`'s
   * own `newest_generation`, restated here under fsck's own vocabulary so a
   * caller can see, honestly, how far signature verification reached versus
   * how far `recovered_generation` actually materialized.
   */
  chain_verified_to_generation: string;
  /** Non-null iff the chain walk itself broke (see {@link GitvaultDiscoveryResult.chain_break}). */
  chain_break: GitvaultChainBreak | null;
  /**
   * Non-null iff an admitted `rotate_epoch` transition capped
   * `recovered_generation` below `chain_verified_to_generation` because this
   * keystore holds no envelope for the new epoch (or the envelope is absent/
   * altered on this mirror) — Request 4's named epoch boundary, never a bare
   * generic absence. Always `null` on {@link GitvaultVerifyReport} (mode
   * `keyless_verify` never opens a key).
   */
  epoch_decrypt_failure: GitvaultEpochDecryptFailure | null;
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
  /**
   * Member recovery-bundle sidecars found under `member-recovery-bundles/` in
   * this prefix — UNVERIFIED availability hints (gitvault-recovery-custody):
   * nothing about them is authenticated by the chain; they only tell a human
   * holder "a bundle travels with this mirror, so bundle + source recovery
   * code can recover it with no server." Empty when the prefix carries none.
   */
  member_recovery_bundles: GitvaultMemberBundleHint[];
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
  // Member recovery-bundle sidecars — reported keylessly as UNVERIFIED
  // availability hints (the bundle itself never becomes part of the chain
  // verdict; the parsed blobs are not carried on the report, only identity
  // hints — a keyless report should never embed ciphertext).
  const memberBundles = (await discoverMemberBundles(backend)).map(({ bundle: _b, ...hint }) => hint);
  return {
    repo_id: discovery.repo_id, genesis_sha256: discovery.genesis_sha256, pin_trust: discovery.pin_trust,
    recovered_generation: generation, chain_verified_to_generation: discovery.newest_generation, chain_break: discovery.chain_break,
    epoch_decrypt_failure: null, absences,
    data_loss_detected: absences.some((a) => a.adjudication === "unexplained_absence"),
    validity_not_freshness: GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
    keystore_still_required: GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
    mode: "keyless_verify", inventory,
    member_recovery_bundles: memberBundles,
  };
}

/**
 * Try `options.start_generation` (default `discovery.newest_generation`),
 * then fall back one generation at a time on `unexplained_absence`,
 * recording every adjudication along the way (never a silent skip — task
 * 3.2). Request 4 (D193-D203, rev 42): the KEYED recovery path caps
 * `start_generation` at the epoch-decrypt boundary BEFORE calling this —
 * an unopenable epoch is adjudicated as its OWN named cause (`epoch_decrypt_failure`
 * on the report), never folded into this function's generic absence
 * vocabulary.
 */
async function resolveWithFallback(backend: GitvaultMirrorBackend, discovery: GitvaultDiscoveryResult, options: { requireMaterializable: boolean; start_generation?: string }): Promise<{ generation: string; absences: GitvaultAbsenceAdjudication[] }> {
  const allAbsences: GitvaultAbsenceAdjudication[] = [];
  let gen = options.start_generation ?? discovery.newest_generation;
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
   * Non-null iff this recovery decrypted via the human-member path (a member
   * recovery bundle opened with the source recovery code) rather than a
   * keystore — names WHICH bundle sidecar (`bundle_key`, null when supplied
   * directly), which wrapper opened, and the rp_id the context was built
   * with. Faithful: a keystore recovery and a bundle recovery produce the
   * same repository, but the caller can always tell which happened.
   */
  member_recovery: { bundle_key: string | null; wrapper_id: string; rp_id_used: string; ek_fingerprint: string } | null;
  /**
   * clone-installs-retained-refs (D2): the same `refs/r402/retain/<oid>`
   * bookkeeping `restoreObjectsInto` (clone/fetch) and `fsck` install, applied
   * here so a recovered bare repo's `git fsck` is silent too — a disaster
   * drill should never see dangling-commit noise for tips this recovery
   * itself just proved are retained. D3: a bookkeeping failure degrades to a
   * `warning` on this field; recovery itself never fails on it.
   */
  retained_refs: GitvaultRetainedRefsReconcileResult;
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
  /**
   * gitvault-recovery-custody — the human-member path: a member recovery
   * bundle (exported wrapper ciphertexts + key identity) opened with
   * `source_recovery_code` substitutes for the keystore's encryption
   * identity. When `source_recovery_code` is supplied WITHOUT a bundle, the
   * mirror's own `member-recovery-bundles/` sidecars are tried; none found
   * is the truthful `RECOVERY_BUNDLE_MISSING` refusal (a server-side
   * wrapper row that was never exported is not an offline backup). The
   * recovery-receipt pin is still required for trusted recovery — key
   * material never substitutes for the trust anchor.
   */
  member_bundle?: GitvaultMemberRecoveryBundle;
  source_recovery_code?: string;
  /** Seal-time ceremony host for the wrapper context; default = bundle's own `rp_id`, then `console.run402.com`. */
  rp_id?: string;
}

/** The two identity fields recovery actually decrypts with — a keystore's `identity.json` or a member bundle opened by the source recovery code both project onto this. */
export type GitvaultRecoveryIdentity = Pick<GitvaultIdentityFile, "encryption_private_key_hex" | "encryption_fingerprint">;

/** Open the recipient's genesis key envelope and decrypt `K_1` — the FIRST step in this file that touches key material (a genesis's own envelope, `rotation_id` absent — D203). */
async function resolveGenesisEpochKey(backend: GitvaultMirrorBackend, genesis: GitvaultVaultGenesis, identity: GitvaultRecoveryIdentity): Promise<Uint8Array> {
  if (!identity.encryption_private_key_hex) {
    fail("VAULT_UNRECOVERABLE", "no encryption key available — recovery can verify and adjudicate but cannot decrypt or materialize anything", "materializing gitvault recovery", undefined, [
      { action: "restore the principal keystore (identity.json) from backup, then re-run recover" },
      { action: "run `run402 repos fsck --mirror` for the verify-only outcome" },
    ]);
  }
  if (genesis.envelopes.length === 0) fail("VAULT_CREATION_CONFLICT", "genesis carries no key envelope", "materializing gitvault recovery");
  // A real vault can carry MORE than one key_envelope ledger row — a
  // foreign recipient's envelope is the norm on a multi-recipient vault,
  // never an anomaly. A
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

/** The mirror's own `key-envelopes/<epoch>/<rotation_id>/<fingerprint>.env` wire key (protocol §3) — a rotation-attempt envelope's path, distinct from a genesis/ADD envelope's `key-envelopes/<epoch>/<fingerprint>.env`. */
/**
 * Parameter order MUST match {@link openEpochRotationForRecipient}'s own
 * `envelope_path` field type — `(epoch, recipient_fingerprint, rotation_id)`
 * — exactly, not the storage path's OWN left-to-right key-segment order
 * (`key-envelopes/<epoch>/<rotation_id>/<fingerprint>.env`, protocol §3).
 * Getting this backwards type-checks fine (it is a positional function
 * type, so TypeScript cannot catch the swap) but silently resolves every
 * rotation envelope to the WRONG mirror key — caught by
 * `gitvault-epoch-reader.test.ts`'s own offline-recovery test, which is
 * exactly why the parameter names spell it out here too.
 */
function mirrorRotationEnvelopePath(epoch: string, recipientFingerprint: string, rotationId: string): string {
  return `key-envelopes/${epoch}/${rotationId}/${recipientFingerprint}.env`;
}

/**
 * Traverse every admitted `rotate_epoch` transition {@link discoverAndVerifyChain}
 * saw, opening THIS keystore's own rotation-attempt envelope for each new
 * epoch from the mirror (recipient-only rule: only this keystore's own
 * envelopes are ever present on a mirror synced under the recipient-only
 * read gate — see {@link resolveGenesisEpochKey}'s own comment on the
 * genesis case). NEVER throws: a rotation this keystore cannot open stops
 * traversal and is recorded as `failure` — the caller decides what that
 * means for `recovered_generation` (Request 4's honest fallback, named at
 * the epoch boundary rather than folded into a generic absence).
 */
async function resolveRotationEpochKeys(
  backend: GitvaultMirrorBackend,
  genesis: GitvaultVaultGenesis,
  rotations: readonly GitvaultEncounteredRotation[],
  identity: GitvaultRecoveryIdentity,
): Promise<{ epoch_keys_hex: Record<string, string>; failure: GitvaultEpochDecryptFailure | null }> {
  const epochKeys: Record<string, string> = {};
  if (!identity.encryption_private_key_hex) return { epoch_keys_hex: epochKeys, failure: null };
  const ownKeypair = generateEncryptionKeypair(hexToBytes(identity.encryption_private_key_hex));
  const ownFingerprint = identity.encryption_fingerprint;
  for (const rot of rotations) {
    try {
      const kE = await openEpochRotationForRecipient({
        repo_id: genesis.repo_id,
        payload: rot.payload,
        own_fingerprint: ownFingerprint,
        own_encryption_keypair: ownKeypair,
        writer_signing_public_key: genesis.creator_signing_pubkey,
        get_envelope_bytes: (path) => backend.get(path),
        envelope_path: mirrorRotationEnvelopePath,
      });
      epochKeys[rot.epoch] = bytesToHex(kE);
    } catch (e) {
      const code = isRun402Error(e) && e.code ? e.code : "GITVAULT_EPOCH_NOT_OPENABLE";
      return { epoch_keys_hex: epochKeys, failure: { generation: rot.generation, epoch: rot.epoch, rotation_id: rot.payload.rotation_id, code, message: e instanceof Error ? e.message : String(e) } };
    }
  }
  return { epoch_keys_hex: epochKeys, failure: null };
}

/**
 * Pure (Request 4): given every locally-openable epoch key, compute the
 * newest generation this keystore can actually DECRYPT — the last
 * generation before the first rotation whose epoch is missing from
 * `epochKeysHex`, or `newestGeneration` if every rotation opened. Mirrors
 * the live publication read path's identical boundary computation
 * (`GitvaultVault.materialize`) so both surfaces report the same concept
 * under the same name.
 */
function computeDecryptableBoundaryGeneration(
  rotations: readonly GitvaultEncounteredRotation[],
  epochKeysHex: Record<string, string>,
  newestGeneration: string,
): { generation: string; failure: GitvaultEpochDecryptFailure | null } {
  let boundary = rotations.length > 0 ? generationMinusOne(rotations[0]!.generation) : newestGeneration;
  for (let i = 0; i < rotations.length; i++) {
    const rot = rotations[i]!;
    if (!epochKeysHex[rot.epoch]) {
      return {
        generation: boundary,
        failure: { generation: rot.generation, epoch: rot.epoch, rotation_id: rot.payload.rotation_id, code: "GITVAULT_EPOCH_NOT_OPENABLE", message: `epoch ${rot.epoch} (rotation ${rot.payload.rotation_id}) could not be opened by this keystore — recovery caps at the last generation under the prior, openable epoch` },
      };
    }
    boundary = i + 1 < rotations.length ? generationMinusOne(rotations[i + 1]!.generation) : newestGeneration;
  }
  return { generation: boundary, failure: null };
}

async function openCarrier<T>(backend: GitvaultMirrorBackend, kRepo: Uint8Array, repoId: string, epoch: string, kind: "ref_state" | "retention_roots" | "checkpoint_manifest", objectId: string, ciphertextSha256: string, key: string): Promise<T> {
  const frame = await backend.get(key);
  if (!frame) fail("CHAIN_UNUSABLE", `${kind} ${objectId} is absent from the mirror`, "materializing gitvault recovery", { object_id: objectId });
  const plaintext = openFrame({ k_obj: deriveObjectKey(kRepo, repoId, epoch, kind, objectId), repo_id: repoId, object_kind: kind, object_id: objectId, epoch, frame, expected_ciphertext_sha256: ciphertextSha256 });
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
  // `out_dir` is "where to materialize the recovered repository" — the CLI's own
  // documented example (`--out ./restored`) is a path that naturally does
  // NOT already exist, same expectation as `git clone <url> restored-dir`.
  // Create it FIRST, before any discovery/decrypt work, so a bad `out_dir`
  // fails fast with a truthful, typed error instead of the misleading
  // `GIT_UNAVAILABLE` the first `hardenedGit` call would throw (see that function's own
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
  const repoId = discovery.repo_id;

  // ── Request 4 (D193-D203, rev 42): resolve every locally-openable epoch
  // key, then cap the materializable range at the DECRYPT boundary BEFORE
  // running the (keyless) absence fallback — an unopenable epoch is its OWN
  // named cause, never folded into the generic "unexplained_absence"
  // vocabulary `resolveWithFallback` already owns for missing bytes.
  //
  // gitvault-recovery-custody: the decrypt identity comes from EITHER the
  // keystore (the original path) OR a member recovery bundle opened with the
  // source recovery code (the human-member path, no keystore involved). A
  // code with no bundle — explicit or discovered in the mirror's own
  // `member-recovery-bundles/` sidecars — is the truthful refusal by name:
  // a server-side wrapper row that was never exported is not offline backup.
  let identity: GitvaultRecoveryIdentity;
  let memberRecovery: GitvaultRecoverResult["member_recovery"] = null;
  if (options.source_recovery_code != null || options.member_bundle != null) {
    if (options.source_recovery_code == null) {
      fail("SOURCE_RECOVERY_CODE_REQUIRED", "a member recovery bundle was supplied without its source recovery code — the bundle is ciphertext; the code is what opens it", "materializing gitvault recovery", undefined, [
        { action: "re-run with the source recovery code (SRC1-…) you saved at enrollment" },
      ]);
    }
    const code = options.source_recovery_code;
    if (options.member_bundle) {
      // Re-validate even the typed input — the CLI hands over whatever JSON the
      // file held, and a malformed bundle should refuse by name, not TypeError.
      const suppliedBundle = parseMemberRecoveryBundle(options.member_bundle);
      const member = unwrapMemberRecoveryBundle({ bundle: suppliedBundle, source_recovery_code: code, ...(options.rp_id ? { rp_id: options.rp_id } : {}) });
      identity = { encryption_private_key_hex: member.private_key_hex, encryption_fingerprint: member.fingerprint };
      memberRecovery = { bundle_key: null, wrapper_id: member.wrapper_id, rp_id_used: member.rp_id_used, ek_fingerprint: member.fingerprint };
    } else {
      const discovered = (await discoverMemberBundles(backend)).filter((b) => b.bundle != null);
      if (discovered.length === 0) {
        fail(
          "RECOVERY_BUNDLE_MISSING",
          "a source recovery code was supplied but no member recovery bundle is available — none was passed and this mirror carries no member-recovery-bundles/ sidecar. The code alone cannot recover anything: export the bundle (console.run402.com/account → Download recovery bundle, or `run402 repos recovery-bundle`) and keep it with the mirror.",
          "materializing gitvault recovery",
          undefined,
          [{ action: "re-run with --bundle <exported-bundle.json>" }],
        );
      }
      // Try each discovered bundle — the AEAD authenticates, so a foreign
      // member's bundle simply fails to open and the loop moves on.
      let opened: { member: ReturnType<typeof unwrapMemberRecoveryBundle>; bundle_key: string } | null = null;
      let lastErr: unknown = null;
      for (const d of discovered) {
        try {
          opened = { member: unwrapMemberRecoveryBundle({ bundle: d.bundle!, source_recovery_code: code, ...(options.rp_id ? { rp_id: options.rp_id } : {}) }), bundle_key: d.key };
          break;
        } catch (e) {
          if (isRun402Error(e) && e.code === "RECOVERY_CODE_CHECKSUM_INVALID") throw e; // a local typo is the same typo for every bundle
          lastErr = e;
        }
      }
      if (!opened) {
        fail("WRAPPER_DID_NOT_OPEN", `this mirror carries ${discovered.length} member recovery-bundle sidecar(s) but the supplied code opened none of them — a wrong code, or a bundle belonging to a different member`, "materializing gitvault recovery", { tried: discovered.map((d) => d.key), cause: lastErr instanceof Error ? lastErr.message : String(lastErr) });
      }
      identity = { encryption_private_key_hex: opened.member.private_key_hex, encryption_fingerprint: opened.member.fingerprint };
      memberRecovery = { bundle_key: opened.bundle_key, wrapper_id: opened.member.wrapper_id, rp_id_used: opened.member.rp_id_used, ek_fingerprint: opened.member.fingerprint };
    }
  } else {
    const stored = keystore.readIdentity();
    if (!stored?.encryption_private_key_hex) {
      fail("VAULT_UNRECOVERABLE", "no encryption key in this keystore — recovery can verify and adjudicate but cannot decrypt or materialize anything", "materializing gitvault recovery", undefined, [
        { action: "restore the principal keystore (identity.json) from backup, then re-run recover" },
        { action: "a human member under wrapper custody: re-run with --bundle <exported-bundle.json> + the source recovery code" },
        { action: "run `run402 repos fsck --mirror` for the verify-only outcome" },
      ]);
    }
    identity = stored;
  }
  const k1 = await resolveGenesisEpochKey(backend, discovery.genesis, identity);
  const rotationKeys = await resolveRotationEpochKeys(backend, discovery.genesis, discovery.rotations, identity);
  const epochKeysHex: Record<string, string> = { [GITVAULT_GENESIS_EPOCH]: bytesToHex(k1), ...rotationKeys.epoch_keys_hex };
  const decryptBoundary = computeDecryptableBoundaryGeneration(discovery.rotations, epochKeysHex, discovery.newest_generation);
  // The two possible epoch-decrypt failure sources (an unopenable rotation
  // envelope, or the boundary walk simply never reaching one) agree by
  // construction — `resolveRotationEpochKeys` stops at the SAME rotation
  // `computeDecryptableBoundaryGeneration` would independently name; prefer
  // whichever is non-null (both name the identical rotation when both fire).
  const epochDecryptFailure = decryptBoundary.failure ?? rotationKeys.failure;
  const startGeneration = decryptBoundary.generation < discovery.newest_generation ? decryptBoundary.generation : discovery.newest_generation;

  const { generation, absences } = await resolveWithFallback(backend, discovery, { requireMaterializable: true, start_generation: startGeneration });
  if (generation === GITVAULT_GENESIS_GENERATION) {
    fail(
      "CHECKPOINT_INCOMPLETE",
      epochDecryptFailure && startGeneration === GITVAULT_GENESIS_GENERATION
        ? `no generation could be materialized — epoch ${epochDecryptFailure.epoch} (rotation ${epochDecryptFailure.rotation_id}) could not be opened by this keystore and the vault's history begins there`
        : "no generation could be fully materialized — every generation back to genesis has an unexplained missing object",
      "materializing gitvault recovery",
      { absences, epoch_decrypt_failure: epochDecryptFailure },
    );
  }
  const entry = discovery.chain.find((e) => e.generation === generation)!;
  const epoch = entry.head.epoch;
  const kRepo = hexToBytes(epochKeysHex[epoch]!); // guaranteed present — `generation` never exceeds `decryptBoundary.generation`

  const refState = await openCarrier<GitvaultRefState>(backend, kRepo, repoId, epoch, "ref_state", entry.head.ref_state.object_id, entry.head.ref_state.ciphertext_sha256, gitvaultPaths.refState(entry.head.ref_state.object_id));
  const roots = await openCarrier<GitvaultRetentionRoots>(backend, kRepo, repoId, epoch, "retention_roots", entry.head.retention_roots.object_id, entry.head.retention_roots.ciphertext_sha256, gitvaultPaths.retentionRoots(entry.head.retention_roots.object_id));

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
  // Every object below is decrypted under ITS OWN carrying head's `epoch`
  // (D194) — a covered span crossing a rotation mixes epochs, exactly like
  // the live publication read path's `restoreObjectsInto`. `epochKeysHex`
  // is guaranteed to cover every epoch from genesis through `epoch`
  // (`decryptBoundary` capped `generation` at the last generation with a
  // fully-resolved epoch key).
  const kRepoForEpoch = (e: string): Uint8Array => hexToBytes(epochKeysHex[e]!);
  if (first.head.checkpoint) {
    const claimBytes = await backend.get(gitvaultPaths.claimSet(first.head.checkpoint.claim_set.object_id));
    if (!claimBytes) fail("CHECKPOINT_INCOMPLETE", "checkpoint claim set absent from the mirror", "materializing gitvault recovery");
    const claimSet = parseGitvaultStrict(new TextDecoder().decode(claimBytes)) as GitvaultCheckpointClaimSet;
    if (!verifyGitvaultObject(claimSet as unknown as GitvaultSignedObject, discovery.genesis.creator_signing_pubkey)) fail("CHECKPOINT_INCOMPLETE", "checkpoint claim set signature fails", "materializing gitvault recovery");
    manifest = await openCarrier<GitvaultCheckpointManifest>(backend, kRepoForEpoch(first.head.epoch), repoId, first.head.epoch, "checkpoint_manifest", claimSet.manifest_receipt.object_id, claimSet.manifest_receipt.ciphertext_sha256, gitvaultPaths.checkpointManifest(claimSet.manifest_receipt.object_id));
    checkClaimSetEquality(claimSet, manifest, first.head.checkpoint.covers_through_generation);
    for (const p of manifest.packs) {
      const frame = await backend.get(gitvaultPaths.checkpointPack(p.object_id));
      if (!frame) fail("CHECKPOINT_INCOMPLETE", `checkpoint pack ${p.object_id} absent`, "materializing gitvault recovery");
      const plain = openFrame({ k_obj: deriveObjectKey(kRepoForEpoch(first.head.epoch), repoId, first.head.epoch, "checkpoint_pack", p.object_id), repo_id: repoId, object_kind: "checkpoint_pack", object_id: p.object_id, epoch: first.head.epoch, frame, expected_ciphertext_sha256: p.ciphertext_sha256 });
      if (sha256Hex(plain) !== p.plaintext_sha256 || String(plain.length) !== p.plaintext_size_bytes) fail("CHECKPOINT_INCOMPLETE", `checkpoint pack ${p.object_id} plaintext mismatch`, "materializing gitvault recovery");
      await hardenedGit(options.out_dir, ["index-pack", "--stdin", "--strict"], { input: plain });
    }
  }
  for (const h of heads) {
    for (const w of h.head.wal_entries) {
      const frame = await backend.get(gitvaultPaths.wal(w.object_id));
      if (!frame) fail("CHAIN_UNUSABLE", `WAL pack ${w.object_id} absent`, "materializing gitvault recovery", { object_id: w.object_id });
      const plain = openFrame({ k_obj: deriveObjectKey(kRepoForEpoch(h.head.epoch), repoId, h.head.epoch, "wal_pack", w.object_id), repo_id: repoId, object_kind: "wal_pack", object_id: w.object_id, epoch: h.head.epoch, frame, expected_ciphertext_sha256: w.ciphertext_sha256 });
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

  // clone-installs-retained-refs (D2): every retained tip this recovery just
  // proved connective above is now present in the bare repo — install/
  // reconcile its refs/r402/retain/* ref so a disaster-drill `git fsck`
  // reports nothing dangling. Runs AFTER fsck (and thus after coverage
  // verification) so a reconcile never references an object the restore
  // itself failed to land — same ordering `restoreObjectsInto` (clone/fetch)
  // uses.
  const retained_refs = await reconcileRetainedTipRefs(options.out_dir, { refs: refState.refs, roots: roots.roots, head_target: refState.head_target });

  // ── recompute the three keyed commitments against the covering manifest (§4.7) ──
  // Keyed under the CHECKPOINT-bearing head's OWN epoch (`first.head.epoch`)
  // — the commitments are checkpoint-build-time artifacts, sealed under
  // whatever epoch was current when the checkpoint was minted, which can
  // differ from the (later) target generation's own epoch across a rotation.
  if (manifest) {
    const kDigestRefmap = deriveDigestKey(kRepoForEpoch(first.head.epoch), repoId, first.head.epoch, "refmap");
    const kDigestRootset = deriveDigestKey(kRepoForEpoch(first.head.epoch), repoId, first.head.epoch, "rootset");
    const kDigestObjectset = deriveDigestKey(kRepoForEpoch(first.head.epoch), repoId, first.head.epoch, "objectset");
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
    recovered_generation: generation, chain_verified_to_generation: discovery.newest_generation, chain_break: discovery.chain_break,
    epoch_decrypt_failure: generation === decryptBoundary.generation ? epochDecryptFailure : null,
    absences,
    data_loss_detected: absences.some((a) => a.adjudication === "unexplained_absence"),
    validity_not_freshness: GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
    keystore_still_required: GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
    mode: "recovered", out_dir: options.out_dir, refs: refState.refs, head_target: refState.head_target,
    member_recovery: memberRecovery,
    retained_refs,
    layout: "bare",
    next_actions: [
      { action: "the recovered repository is bare (no working files) — clone it to get a working tree", command: `git clone ${options.out_dir} ${options.out_dir}-worktree` },
    ],
  };
}
