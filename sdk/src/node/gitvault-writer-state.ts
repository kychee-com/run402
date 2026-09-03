/**
 * r402s/v0 rev 47 — the writer set as CHAIN STATE (protocol §4.15), and the
 * pure cryptographic half of `add_writer_key` / `rotate_epoch{writer_set_update}`
 * admission (§4.16–§4.18, D221–D227). Client-side mirror of the gateway's
 * `services/gitvault/writer-state.ts` (task gitvault-multi-writer 2.3) — same
 * functions, same Verdict shape, same crypto rules — so both sides reach the
 * SAME conclusion from the SAME chain bytes with no shared network call.
 *
 * Deliberately pure and isomorphic (no I/O, no Node-only APIs): a recovering
 * client, the browser viewer, and `r402s-verify` all need to replay writer
 * state from nothing but genesis + admitted chain objects. `checkChainLink`'s
 * own asserts stay ignorant of transition PAYLOADS (protocol discipline); this
 * module is where a transition's writer-set content gets opened and verified,
 * once the caller has already established the transition is admitted or is
 * validating a candidate before submission.
 *
 * One deliberate divergence from the gateway's file: `initialWriterState`
 * DERIVES the version-0 writer_key_id from `creator_signing_pubkey` rather
 * than reading a `genesis.writer_key_id` field — the gateway's own genesis
 * admission already asserts `writerKeyIdOf(creator_signing_pubkey) ===
 * genesis.writer_key_id` (chain.ts), so for any validly-admitted genesis both
 * approaches agree; deriving is simpler for a client that has no reason to
 * trust an extra redundant field over the pubkey it already verified.
 */
import { LocalError } from "../errors.js";
import {
  GITVAULT_B64U_32_RE,
  GITVAULT_B64U_64_RE,
  ed25519VerifyStrict,
  fromBase64url,
  gitvaultWithoutSignature,
  isCanonicalBase64url,
  jcs,
  sha256Hex,
  signaturePreimage,
  vkFingerprint,
} from "../namespaces/gitvault.crypto.js";

// ─── Refusal codes + Verdict ─────────────────────────────────────────────────

/**
 * The exact, closed set of refusal codes this module can ever return —
 * mirrors the gateway's `WriterStateRefusalCode` exactly (same union, same
 * names) so a caller's error mapping needs no translation table.
 */
export type WriterStateRefusalCode =
  | "VALIDATION_FAILED"
  | "GITVAULT_WRITER_NOT_ADMITTED"
  | "HANDOFF_KEY_REVOKED"
  | "RECIPIENT_SET_MISMATCH"
  | "EPOCH_ROTATION_WOULD_LEAVE_VAULT_UNCOVERED";

export type WriterStateVerdict = { ok: true } | { ok: false; code: WriterStateRefusalCode; detail: string };

// ─── Org role lattice (mirrors org-owned-control-plane's owner > admin > developer > billing > viewer) ──

export const ORG_ROLE_RANK: Readonly<Record<string, number>> = Object.freeze({
  viewer: 0,
  billing: 1,
  developer: 2,
  admin: 3,
  owner: 4,
});
export const WRITER_ELIGIBLE_ROLE_RANK = ORG_ROLE_RANK.developer;

/** Does `role` meet the writer-eligibility threshold (developer or above)? An unknown/absent role never does. */
export function meetsWriterEligibleRole(role: string | null | undefined): boolean {
  return !!role && (ORG_ROLE_RANK[role] ?? -1) >= WRITER_ELIGIBLE_ROLE_RANK;
}

/**
 * gitvault-multi-writer rev 47 (task 5.5) — predicts the role a handoff mint
 * will actually confer, mirroring the gateway's OWN attenuation exactly
 * (`services/gitvault/claims.ts mintHandoff`: `requestedRole &&
 * roleRank(requestedRole) < roleRank(minterRole) ? requestedRole :
 * minterRole`). The mint's `writer_admission_grant.minted_role` must equal
 * this prediction byte-for-byte or the gateway refuses VALIDATION_FAILED —
 * after the checkpoint push has already been paid for — so getting the
 * comparison direction right matters. An unrecognized `requestedRole`
 * (never a legal `OrgRole` server-side either) is treated as "no request":
 * a garbage role string fails the gateway's OWN mint validation before its
 * attenuation logic — and therefore before this grant-mismatch check —
 * ever runs, so predicting `minterRole` for that case is never observed as
 * wrong, only moot.
 */
export function predictMintedRole(requestedRole: string | undefined, minterRole: string): string {
  return requestedRole !== undefined && requestedRole in ORG_ROLE_RANK && ORG_ROLE_RANK[requestedRole]! < ORG_ROLE_RANK[minterRole]! ? requestedRole : minterRole;
}

// ─── Writer chain state ──────────────────────────────────────────────────────

export interface WriterKeyEntry {
  writer_key_id: string;
  signing_pubkey: string;
}

/** The full chain-derived writer state at some generation — protocol §4.15. */
export interface WriterChainState {
  version: string; // hex16
  writers: readonly WriterKeyEntry[]; // sorted by writer_key_id, distinct ids, distinct raw pubkeys
  sha256: string;
  /** Permanently burned writer_key_ids — protocol §4.15, never re-addable, on this vault, ever. */
  burnedWriterKeyIds: ReadonlySet<string>;
  /** Permanently consumed handoff_ids — protocol §4.17, a writer_admission_grant is single-use. */
  consumedHandoffIds: ReadonlySet<string>;
}

const WRITER_SET_FORMAT = "r402s/writer-set/v1";

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function sortWriters(writers: readonly WriterKeyEntry[]): WriterKeyEntry[] {
  return [...writers].sort((a, b) => (a.writer_key_id < b.writer_key_id ? -1 : a.writer_key_id > b.writer_key_id ? 1 : 0));
}

function writersArraysEqual(a: readonly WriterKeyEntry[], b: readonly WriterKeyEntry[]): boolean {
  return a.length === b.length && a.every((w, i) => w.writer_key_id === b[i]!.writer_key_id && w.signing_pubkey === b[i]!.signing_pubkey);
}

function nextVersionHex16(hex16: string): string {
  return (BigInt("0x" + hex16) + 1n).toString(16).padStart(16, "0");
}

/**
 * `vk_` fingerprint of a base64url-encoded Ed25519 public key, or `null` for
 * anything that doesn't decode as a canonical 32-byte base64url scalar —
 * mirrors the gateway's `writerKeyIdOf` (never throws on a malformed key).
 */
export function writerKeyIdOf(signingPubkeyB64u: string): string | null {
  if (!GITVAULT_B64U_32_RE.test(signingPubkeyB64u) || !isCanonicalBase64url(signingPubkeyB64u)) return null;
  return vkFingerprint(fromBase64url(signingPubkeyB64u));
}

/**
 * Strict Ed25519 verification of a detached (b64u-encoded) signature over
 * `message`, given a b64u-encoded public key. Never throws — a malformed
 * scalar is simply `false`, matching `ed25519VerifyStrict`'s own contract.
 */
function verifyDetachedB64u(publicKeyB64u: string, signatureB64u: string, message: Uint8Array): boolean {
  if (!GITVAULT_B64U_32_RE.test(publicKeyB64u) || !isCanonicalBase64url(publicKeyB64u)) return false;
  if (!GITVAULT_B64U_64_RE.test(signatureB64u) || !isCanonicalBase64url(signatureB64u)) return false;
  return ed25519VerifyStrict(fromBase64url(signatureB64u), message, fromBase64url(publicKeyB64u));
}

/** protocol §4.15: writer_set_sha256 = SHA-256(JCS({format, repo_id, version, writers})). */
export function writerSetSha256(repoId: string, version: string, writers: readonly WriterKeyEntry[]): string {
  const writersJson = writers.map((w) => ({ writer_key_id: w.writer_key_id, signing_pubkey: w.signing_pubkey }));
  return sha256Hex(jcs({ format: WRITER_SET_FORMAT, repo_id: repoId, version, writers: writersJson }));
}

/**
 * protocol §4.15: the version-0 singleton, derived from `creator_signing_pubkey`
 * (see the module doc for why this diverges from reading a `writer_key_id`
 * field directly).
 */
export function initialWriterState(repoId: string, genesis: { creator_signing_pubkey: string }): WriterChainState {
  const writerKeyId = writerKeyIdOf(genesis.creator_signing_pubkey);
  if (writerKeyId === null) {
    throw new LocalError(
      "genesis.creator_signing_pubkey is not a canonical base64url Ed25519 public key",
      "computing the vault's initial writer state",
      { code: "GITVAULT_BAD_GENESIS" },
    );
  }
  const writers: WriterKeyEntry[] = [{ writer_key_id: writerKeyId, signing_pubkey: genesis.creator_signing_pubkey }];
  return {
    version: "0000000000000000",
    writers,
    sha256: writerSetSha256(repoId, "0000000000000000", writers),
    burnedWriterKeyIds: new Set(),
    consumedHandoffIds: new Set(),
  };
}

/**
 * protocol §4.16: apply an ALREADY-ADMITTED `add_writer_key` transition.
 * Caller MUST have validated it first (`validateAddWriterKeyPayload`) — this
 * function performs no checks, it only advances state.
 */
/**
 * gitvault-multi-writer (task 5.6) — builds a well-formed `handoff`-door
 * `add_writer_key` payload (schema `r402s.add-writer-key/v1`) from a
 * predecessor writer-set pin and the claimant's own key — the pure
 * assembly step `GitvaultVault.submitWriterActivationHead` delegates to,
 * kept separate so it can be unit-tested directly against
 * {@link validateAddWriterKeyPayload} without a full vault/keystore/git
 * harness. `predecessorPin` needs only `{version, sha256, writers}` — the
 * caller's persisted `writer_set_pin` shape already matches, no
 * `WriterChainState` (with its Sets) is required to build an OUTGOING
 * payload; only to VALIDATE an incoming one.
 */
export function buildAddWriterKeyActivationPayload(
  repoId: string,
  predecessorPin: { version: string; sha256: string; writers: readonly WriterKeyEntry[] },
  addedWriter: WriterKeyEntry & { principal_id: string },
  handoffId: string,
  grant: Record<string, unknown>,
  acceptance: Record<string, unknown>,
): AddWriterKeyPayload {
  const predecessorState: WriterChainState = { version: predecessorPin.version, writers: predecessorPin.writers, sha256: predecessorPin.sha256, burnedWriterKeyIds: new Set(), consumedHandoffIds: new Set() };
  const nextState = applyAddWriterKey(repoId, predecessorState, { writer_key_id: addedWriter.writer_key_id, signing_pubkey: addedWriter.signing_pubkey }, handoffId);
  return {
    schema: "r402s.add-writer-key/v1",
    repo_id: repoId,
    base_writer_set: { version: predecessorPin.version, sha256: predecessorPin.sha256 },
    next_writer_set: { version: nextState.version, writers: [...nextState.writers], sha256: nextState.sha256 },
    added_writer: { writer_key_id: addedWriter.writer_key_id, signing_pubkey: addedWriter.signing_pubkey, principal_id: addedWriter.principal_id },
    authorization: { kind: "handoff", grant, acceptance },
  };
}

export function applyAddWriterKey(
  repoId: string,
  state: WriterChainState,
  addedWriter: WriterKeyEntry,
  consumedHandoffId: string | null,
): WriterChainState {
  const writers = sortWriters([...state.writers, addedWriter]);
  const version = nextVersionHex16(state.version);
  return {
    version,
    writers,
    sha256: writerSetSha256(repoId, version, writers),
    burnedWriterKeyIds: state.burnedWriterKeyIds,
    consumedHandoffIds:
      consumedHandoffId === null ? state.consumedHandoffIds : new Set([...state.consumedHandoffIds, consumedHandoffId]),
  };
}

/**
 * protocol §4.18: apply an ALREADY-ADMITTED `rotate_epoch{writer_set_update}`.
 * Caller MUST have validated it first (`validateWriterSetUpdate`). `writers`
 * MAY be empty — the explicit sole-writer `writer_key_revoked` read-only
 * terminal (D228) is a legal resulting state, not an error at this layer.
 */
export function applyWriterSetUpdate(
  repoId: string,
  state: WriterChainState,
  removedWriterKeyIds: readonly string[],
): WriterChainState {
  const removed = new Set(removedWriterKeyIds);
  const writers = sortWriters(state.writers.filter((w) => !removed.has(w.writer_key_id)));
  const version = nextVersionHex16(state.version);
  return {
    version,
    writers,
    sha256: writerSetSha256(repoId, version, writers),
    burnedWriterKeyIds: new Set([...state.burnedWriterKeyIds, ...removed]),
    consumedHandoffIds: state.consumedHandoffIds,
  };
}

/**
 * The FIRST, ordinary-case lookup (protocol §5A step 1): is this head's own
 * `writer_key_id` already active in the predecessor writer state? A null
 * result does not by itself mean refusal — the caller still checks for a
 * qualifying `add_writer_key{"handoff"}` transition naming exactly this key
 * before concluding `GITVAULT_WRITER_NOT_ADMITTED`.
 */
export function resolveActiveWriter(state: WriterChainState, headWriterKeyId: string): WriterKeyEntry | null {
  return state.writers.find((w) => w.writer_key_id === headWriterKeyId) ?? null;
}

export interface AddWriterKeyPayload {
  schema: "r402s.add-writer-key/v1";
  repo_id: string;
  base_writer_set: { version: string; sha256: string };
  next_writer_set: { version: string; writers: WriterKeyEntry[]; sha256: string };
  added_writer: { writer_key_id: string; signing_pubkey: string; principal_id: string };
  authorization: { kind: "writer" } | { kind: "handoff"; grant: Record<string, unknown>; acceptance: Record<string, unknown> };
}

/**
 * The FULL cryptographic + structural validation of an `add_writer_key`
 * payload (protocol §4.16/§4.17), given the writer state at the PREDECESSOR
 * generation and the carrying head's own `writer_key_id`. Does NOT check
 * `authorization.kind:"writer"`'s org-membership eligibility (active
 * membership >= developer, directory possession-verification) — that is
 * gateway-only, live-state-dependent, and re-checked under the admission
 * fence server-side; a client validating its OWN candidate transition before
 * submission relies on the gateway's fence-time re-check as the backstop.
 */
export function validateAddWriterKeyPayload(
  repoId: string,
  predecessorState: WriterChainState,
  payload: AddWriterKeyPayload,
  headWriterKeyId: string,
): WriterStateVerdict {
  if (payload.base_writer_set.version !== predecessorState.version || payload.base_writer_set.sha256 !== predecessorState.sha256) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "base_writer_set does not match the writer state at the predecessor generation" };
  }

  const addedKeyId = writerKeyIdOf(payload.added_writer.signing_pubkey);
  if (addedKeyId === null || addedKeyId !== payload.added_writer.writer_key_id) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "added_writer.writer_key_id does not derive from added_writer.signing_pubkey" };
  }
  if (predecessorState.burnedWriterKeyIds.has(addedKeyId)) {
    return { ok: false, code: "VALIDATION_FAILED", detail: `writer_key_id ${addedKeyId} was permanently removed and can never be re-added` };
  }
  if (predecessorState.writers.some((w) => w.writer_key_id === addedKeyId)) {
    return { ok: false, code: "VALIDATION_FAILED", detail: `writer_key_id ${addedKeyId} is already an active writer` };
  }
  if (predecessorState.writers.length >= MAX_VAULT_WRITERS) {
    return { ok: false, code: "VALIDATION_FAILED", detail: `this vault already has ${MAX_VAULT_WRITERS} active writers, the protocol maximum (MAX_VAULT_WRITERS)` };
  }

  const expectedNextWriters = sortWriters([
    ...predecessorState.writers,
    { writer_key_id: addedKeyId, signing_pubkey: payload.added_writer.signing_pubkey },
  ]);
  const expectedNextVersion = nextVersionHex16(predecessorState.version);
  const expectedNextSha = writerSetSha256(repoId, expectedNextVersion, expectedNextWriters);
  if (
    payload.next_writer_set.version !== expectedNextVersion ||
    payload.next_writer_set.sha256 !== expectedNextSha ||
    !writersArraysEqual(payload.next_writer_set.writers, expectedNextWriters)
  ) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "next_writer_set is not exactly base_writer_set plus added_writer" };
  }

  if (payload.authorization.kind === "writer") {
    if (headWriterKeyId === addedKeyId) {
      return { ok: false, code: "VALIDATION_FAILED", detail: 'authorization.kind:"writer" cannot be self-signed by the added key' };
    }
    if (!predecessorState.writers.some((w) => w.writer_key_id === headWriterKeyId)) {
      return { ok: false, code: "GITVAULT_WRITER_NOT_ADMITTED", detail: "the carrying head's signer is not an active writer at the predecessor generation" };
    }
    return { ok: true };
  }

  // authorization.kind === "handoff"
  if (headWriterKeyId !== addedKeyId) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "a handoff activation head must be signed by the added key itself" };
  }
  const { grant, acceptance } = payload.authorization;

  const grantorKeyId = asStr(grant.grantor_writer_key_id);
  const grantorEntry = grantorKeyId === null ? null : (predecessorState.writers.find((w) => w.writer_key_id === grantorKeyId) ?? null);
  if (grantorEntry === null) {
    return { ok: false, code: "HANDOFF_KEY_REVOKED", detail: "grantor_not_active" };
  }
  if (asStr(grant.object_kind) !== "writer_admission_grant") {
    return { ok: false, code: "VALIDATION_FAILED", detail: "writer_admission_grant.object_kind is not writer_admission_grant" };
  }
  const grantSignature = asStr(grant.signature);
  const grantPreimage = signaturePreimage("writer_admission_grant", gitvaultWithoutSignature(grant) as Record<string, unknown>);
  if (grantSignature === null || !verifyDetachedB64u(grantorEntry.signing_pubkey, grantSignature, grantPreimage)) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "writer_admission_grant signature does not verify under the grantor's writer key" };
  }

  const statementRaw = acceptance.statement;
  if (typeof statementRaw !== "object" || statementRaw === null || Array.isArray(statementRaw)) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "writer_acceptance.statement is missing or malformed" };
  }
  const statement = statementRaw as Record<string, unknown>;
  const statementPreimage = signaturePreimage("handoff-writer-accept/v1", statement);

  const handoffAdmissionPubkey = asStr(grant.handoff_admission_pubkey);
  const acceptanceSignature = asStr(acceptance.acceptance_signature);
  if (
    handoffAdmissionPubkey === null ||
    acceptanceSignature === null ||
    !verifyDetachedB64u(handoffAdmissionPubkey, acceptanceSignature, statementPreimage)
  ) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "writer_acceptance.acceptance_signature does not verify under the grant's admission key" };
  }
  const possessionSignature = asStr(acceptance.possession_signature);
  if (
    possessionSignature === null ||
    !verifyDetachedB64u(payload.added_writer.signing_pubkey, possessionSignature, statementPreimage)
  ) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "writer_acceptance.possession_signature does not verify under the added writer's own key" };
  }

  const handoffId = asStr(grant.handoff_id);
  if (handoffId === null || handoffId !== asStr(statement.handoff_id)) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "grant.handoff_id != acceptance.statement.handoff_id" };
  }
  if (asStr(grant.auth_hash) !== asStr(statement.auth_hash)) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "grant.auth_hash != acceptance.statement.auth_hash" };
  }
  if (asStr(statement.writer_key_id) !== addedKeyId || asStr(statement.signing_pubkey) !== payload.added_writer.signing_pubkey) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "acceptance.statement writer identity does not match added_writer" };
  }
  if (predecessorState.consumedHandoffIds.has(handoffId)) {
    return { ok: false, code: "VALIDATION_FAILED", detail: `handoff_id ${handoffId} has already been consumed in this vault's writer history` };
  }

  return { ok: true };
}

export interface WriterSetUpdatePayload {
  base_version: string;
  base_sha256: string;
  next_version: string;
  next_sha256: string;
  removed: readonly { writer_key_id: string; principal_id: string; reason: string }[];
  writers: readonly WriterKeyEntry[];
}

/**
 * The FULL cryptographic + structural validation of a `rotate_epoch`
 * transition's `writer_set_update` field (protocol §4.18, D227), given the
 * writer state at the PREDECESSOR generation, the carrying head's own
 * `writer_key_id`, and the caller's own belief about which writer keys are
 * due for removal (`gatewayBlockedWriterKeyIds` — for a client building a
 * CANDIDATE rotation this is `state read (blocked set)`; the gateway's own
 * fence-time re-check is the source of truth at admission). `allowEmptyResult`
 * is true ONLY for the explicit, owner+step-up, sole remaining writer
 * `writer_key_revoked` removal (D228); every other call site passes `false`.
 */
export function validateWriterSetUpdate(
  repoId: string,
  predecessorState: WriterChainState,
  update: WriterSetUpdatePayload,
  headWriterKeyId: string,
  gatewayBlockedWriterKeyIds: ReadonlySet<string>,
  allowEmptyResult: boolean,
): WriterStateVerdict {
  if (update.base_version !== predecessorState.version || update.base_sha256 !== predecessorState.sha256) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "writer_set_update base does not match the writer state at the predecessor generation" };
  }

  const removedIds = new Set(update.removed.map((r) => r.writer_key_id));
  const blockedSorted = [...gatewayBlockedWriterKeyIds].sort();
  const removedSorted = [...removedIds].sort();
  const exactMatch = blockedSorted.length === removedSorted.length && blockedSorted.every((id, i) => id === removedSorted[i]);
  if (!exactMatch) {
    return { ok: false, code: "RECIPIENT_SET_MISMATCH", detail: "writer_set_update.removed does not equal exactly the blocked writer key set" };
  }

  const expectedWriters = sortWriters(predecessorState.writers.filter((w) => !removedIds.has(w.writer_key_id)));
  if (!writersArraysEqual(update.writers, expectedWriters)) {
    return { ok: false, code: "RECIPIENT_SET_MISMATCH", detail: "writer_set_update.writers is not base_writer_set minus exactly the removed set" };
  }

  if (expectedWriters.length === 0 && !allowEmptyResult) {
    return { ok: false, code: "EPOCH_ROTATION_WOULD_LEAVE_VAULT_UNCOVERED", detail: "this rotation would leave the vault with zero writers" };
  }
  if (expectedWriters.length > 0 && !expectedWriters.some((w) => w.writer_key_id === headWriterKeyId)) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "the rotation head's own signer must remain in the next writer set" };
  }

  const expectedNextVersion = nextVersionHex16(predecessorState.version);
  const expectedNextSha = writerSetSha256(repoId, expectedNextVersion, expectedWriters);
  if (update.next_version !== expectedNextVersion || update.next_sha256 !== expectedNextSha) {
    return { ok: false, code: "VALIDATION_FAILED", detail: "writer_set_update next commitment does not match the recomputed removal" };
  }

  return { ok: true };
}

/**
 * DR / offline replay (protocol §5A "Writer-set DR"): rebuild the writer
 * state purely from genesis + admitted writer-changing transitions, in
 * order. Every transition MUST already be admitted (this performs no
 * validation — apply-only, mirroring `applyAddWriterKey`/`applyWriterSetUpdate`).
 */
export type AdmittedWriterTransition =
  | { kind: "add_writer_key"; addedWriter: WriterKeyEntry; consumedHandoffId: string | null }
  | { kind: "writer_set_update"; removedWriterKeyIds: readonly string[] };

export function replayWriterState(
  repoId: string,
  genesis: { creator_signing_pubkey: string },
  transitions: readonly AdmittedWriterTransition[],
): WriterChainState {
  let state = initialWriterState(repoId, genesis);
  for (const t of transitions) {
    state =
      t.kind === "add_writer_key"
        ? applyAddWriterKey(repoId, state, t.addedWriter, t.consumedHandoffId)
        : applyWriterSetUpdate(repoId, state, t.removedWriterKeyIds);
  }
  return state;
}

/** protocol §4.15: `MAX_VAULT_WRITERS`. A writer-changing transition producing more active writers than this is refused. */
export const MAX_VAULT_WRITERS = 64;
