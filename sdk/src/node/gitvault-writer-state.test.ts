import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { gitvaultWithoutSignature, jcs, keyFingerprintHex, sha256Hex, signaturePreimage, toBase64url } from "../namespaces/gitvault.crypto.js";
import {
  applyAddWriterKey,
  applyWriterSetUpdate,
  buildAddWriterKeyActivationPayload,
  initialWriterState,
  MAX_VAULT_WRITERS,
  replayWriterState,
  resolveActiveWriter,
  validateAddWriterKeyPayload,
  validateWriterSetUpdate,
  writerSetSha256,
  type AddWriterKeyPayload,
  type WriterChainState,
} from "./gitvault-writer-state.js";

// --------------------------------------------------------------- fixtures ---

function keypair() {
  const seed = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64u: toBase64url(pub), writerKeyId: "vk_" + keyFingerprintHex(pub) };
}

function sign(seed: Uint8Array, message: Uint8Array): string {
  return toBase64url(ed25519.sign(message, seed));
}

const REPO_ID = "src_deadbeefdeadbeefdeadbeefdeadbeef";

function genesisFor(creator: ReturnType<typeof keypair>): { creator_signing_pubkey: string } {
  return { creator_signing_pubkey: creator.pubB64u };
}

/**
 * Build a fully-signed handoff grant + acceptance for adding `added` under
 * `grantor`, with a real ephemeral keypair standing in for the third HKDF
 * output (task 5.4's job) — this module only verifies signatures, it never
 * derives the admission keypair itself.
 */
function buildHandoffAuthorization(opts: {
  grantor: ReturnType<typeof keypair>;
  added: ReturnType<typeof keypair>;
  handoffId: string;
  authHash: string;
}) {
  const admission = keypair();
  const grant: Record<string, unknown> = {
    format: "r402s/v0",
    object_kind: "writer_admission_grant",
    suite: "r402s-1",
    repo_id: REPO_ID,
    handoff_id: opts.handoffId,
    auth_hash: opts.authHash,
    checkpoint_generation: "0000000000000001",
    checkpoint_head_sha256: sha256Hex(new Uint8Array(32)),
    grantor_writer_key_id: opts.grantor.writerKeyId,
    handoff_admission_pubkey: admission.pubB64u,
    minted_role: "owner",
    claim_not_after: "2026-09-10T00:00:00.000Z",
    created_at: "2026-09-03T00:00:00.000Z",
  };
  grant.signature = sign(opts.grantor.seed, signaturePreimage("writer_admission_grant", gitvaultWithoutSignature(grant) as Record<string, unknown>));

  const statement: Record<string, unknown> = {
    domain: "r402s/v0/handoff-writer-accept/v1",
    handoff_id: opts.handoffId,
    auth_hash: opts.authHash,
    writer_key_id: opts.added.writerKeyId,
    signing_pubkey: opts.added.pubB64u,
    encryption_pubkey: opts.added.pubB64u, // stand-in; this module never inspects the X25519 half's realism
    encryption_fingerprint: "ek_" + keyFingerprintHex(opts.added.pub),
  };
  const statementBytes = signaturePreimage("handoff-writer-accept/v1", statement);
  const acceptance: Record<string, unknown> = {
    statement,
    acceptance_signature: sign(admission.seed, statementBytes),
    possession_signature: sign(opts.added.seed, statementBytes),
  };

  return { kind: "handoff" as const, grant, acceptance };
}

function buildAddWriterKeyPayload(opts: {
  base: WriterChainState;
  added: ReturnType<typeof keypair>;
  principalId: string;
  authorization: AddWriterKeyPayload["authorization"];
}): AddWriterKeyPayload {
  const nextVersion = (BigInt("0x" + opts.base.version) + 1n).toString(16).padStart(16, "0");
  const nextWriters = [...opts.base.writers, { writer_key_id: opts.added.writerKeyId, signing_pubkey: opts.added.pubB64u }].sort((a, b) =>
    a.writer_key_id < b.writer_key_id ? -1 : a.writer_key_id > b.writer_key_id ? 1 : 0,
  );
  return {
    schema: "r402s.add-writer-key/v1",
    repo_id: REPO_ID,
    base_writer_set: { version: opts.base.version, sha256: opts.base.sha256 },
    next_writer_set: { version: nextVersion, writers: nextWriters, sha256: writerSetSha256(REPO_ID, nextVersion, nextWriters) },
    added_writer: { writer_key_id: opts.added.writerKeyId, signing_pubkey: opts.added.pubB64u, principal_id: opts.principalId },
    authorization: opts.authorization,
  };
}

// ------------------------------------------------------------------ tests ---

describe("gitvault writer-state (protocol §4.15-§4.18, D221-D228) — client mirror of the gateway module", () => {
  it("genesis alone yields the creator singleton; init->create->push stays byte-identical", () => {
    const creator = keypair();
    const state = initialWriterState(REPO_ID, genesisFor(creator));
    assert.equal(state.version, "0000000000000000");
    assert.deepEqual([...state.writers], [{ writer_key_id: creator.writerKeyId, signing_pubkey: creator.pubB64u }]);
    assert.equal(state.sha256, writerSetSha256(REPO_ID, "0000000000000000", state.writers));
    assert.equal(state.burnedWriterKeyIds.size, 0);
    assert.equal(state.consumedHandoffIds.size, 0);
  });

  it("initialWriterState throws on a malformed creator_signing_pubkey (never silently substitutes)", () => {
    assert.throws(() => initialWriterState(REPO_ID, { creator_signing_pubkey: "not-base64url!!" }));
  });

  it("writerSetSha256 is exactly SHA-256(JCS({format, repo_id, version, writers}))", () => {
    const creator = keypair();
    const writers = [{ writer_key_id: creator.writerKeyId, signing_pubkey: creator.pubB64u }];
    const expected = sha256Hex(jcs({ format: "r402s/writer-set/v1", repo_id: REPO_ID, version: "0000000000000000", writers }));
    assert.equal(writerSetSha256(REPO_ID, "0000000000000000", writers), expected);
  });

  it("resolveActiveWriter finds an active key and returns null for an absent one", () => {
    const creator = keypair();
    const state = initialWriterState(REPO_ID, genesisFor(creator));
    assert.deepEqual(resolveActiveWriter(state, creator.writerKeyId), { writer_key_id: creator.writerKeyId, signing_pubkey: creator.pubB64u });
    assert.equal(resolveActiveWriter(state, "vk_" + "0".repeat(32)), null);
  });

  describe('authorization.kind:"writer" — the membership-driven default door (D223/D224)', () => {
    it("accepts: an active writer adds an eligible member's key; the pure module leaves org eligibility to the caller", () => {
      const creator = keypair();
      const member = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const payload = buildAddWriterKeyPayload({ base, added: member, principalId: "principal-member", authorization: { kind: "writer" } });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, creator.writerKeyId);
      assert.deepEqual(v, { ok: true });
    });

    it("rejects: the added key cannot self-sign its own writer-kind admission", () => {
      const creator = keypair();
      const member = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const payload = buildAddWriterKeyPayload({ base, added: member, principalId: "p", authorization: { kind: "writer" } });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, member.writerKeyId);
      assert.equal(v.ok, false);
    });

    it("rejects: an unknown signer with no add_writer_key transition — GITVAULT_WRITER_NOT_ADMITTED for a signer that ISN'T the added key either", () => {
      const creator = keypair();
      const member = keypair();
      const stranger = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const payload = buildAddWriterKeyPayload({ base, added: member, principalId: "p", authorization: { kind: "writer" } });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, stranger.writerKeyId);
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.code, "GITVAULT_WRITER_NOT_ADMITTED");
    });

    it("rejects: next_writer_set that drops the existing writer (full-map violation)", () => {
      const creator = keypair();
      const member = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const payload = buildAddWriterKeyPayload({ base, added: member, principalId: "p", authorization: { kind: "writer" } });
      payload.next_writer_set.writers = [{ writer_key_id: member.writerKeyId, signing_pubkey: member.pubB64u }];
      payload.next_writer_set.sha256 = writerSetSha256(REPO_ID, payload.next_writer_set.version, payload.next_writer_set.writers);
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, creator.writerKeyId);
      assert.equal(v.ok, false);
    });

    it("rejects: adding two writers in one transition", () => {
      const creator = keypair();
      const memberA = keypair();
      const memberB = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const payload = buildAddWriterKeyPayload({ base, added: memberA, principalId: "p", authorization: { kind: "writer" } });
      payload.next_writer_set.writers.push({ writer_key_id: memberB.writerKeyId, signing_pubkey: memberB.pubB64u });
      payload.next_writer_set.sha256 = writerSetSha256(REPO_ID, payload.next_writer_set.version, payload.next_writer_set.writers);
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, creator.writerKeyId);
      assert.equal(v.ok, false);
    });

    it("rejects: a stale base_writer_set (the generation-CAS-conflict shape)", () => {
      const creator = keypair();
      const member = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const payload = buildAddWriterKeyPayload({ base, added: member, principalId: "p", authorization: { kind: "writer" } });
      payload.base_writer_set = { version: "0000000000000099", sha256: "0".repeat(64) };
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, creator.writerKeyId);
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.code, "VALIDATION_FAILED");
    });

    it("rejects: a burned key can never return", () => {
      const creator = keypair();
      const member = keypair();
      let state = initialWriterState(REPO_ID, genesisFor(creator));
      state = applyAddWriterKey(REPO_ID, state, { writer_key_id: member.writerKeyId, signing_pubkey: member.pubB64u }, null);
      state = applyWriterSetUpdate(REPO_ID, state, [member.writerKeyId]); // removed
      const payload = buildAddWriterKeyPayload({ base: state, added: member, principalId: "p", authorization: { kind: "writer" } });
      const v = validateAddWriterKeyPayload(REPO_ID, state, payload, creator.writerKeyId);
      assert.equal(v.ok, false);
    });
  });

  describe('authorization.kind:"handoff" — the bearer-completable door (D225)', () => {
    it("accepts the full chain: grantor active, grant verifies, both acceptance signatures verify, field bindings agree", () => {
      const creator = keypair();
      const recipient = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const auth = buildHandoffAuthorization({ grantor: creator, added: recipient, handoffId: "hid-1", authHash: "a".repeat(64) });
      const payload = buildAddWriterKeyPayload({ base, added: recipient, principalId: "p", authorization: auth });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, recipient.writerKeyId);
      assert.deepEqual(v, { ok: true });
    });

    it("the sender is gone after claim: only the grantor's PUBLIC key (already in state) is needed, never any private material", () => {
      const creator = keypair();
      const recipient = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const auth = buildHandoffAuthorization({ grantor: creator, added: recipient, handoffId: "hid-gone", authHash: "b".repeat(64) });
      const payload = buildAddWriterKeyPayload({ base, added: recipient, principalId: "p", authorization: auth });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, recipient.writerKeyId);
      assert.deepEqual(v, { ok: true });
    });

    it("rejects: a grantor not active in the predecessor writer state (HANDOFF_KEY_REVOKED, grantor_not_active)", () => {
      const creator = keypair();
      const outsider = keypair();
      const recipient = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const auth = buildHandoffAuthorization({ grantor: outsider, added: recipient, handoffId: "hid-2", authHash: "c".repeat(64) });
      const payload = buildAddWriterKeyPayload({ base, added: recipient, principalId: "p", authorization: auth });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, recipient.writerKeyId);
      assert.equal(v.ok, false);
      if (!v.ok) {
        assert.equal(v.code, "HANDOFF_KEY_REVOKED");
        assert.equal(v.detail, "grantor_not_active");
      }
    });

    it("rejects: a grant not signed by the declared grantor (forged grantor_writer_key_id)", () => {
      const creator = keypair();
      const recipient = keypair();
      const impostor = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const auth = buildHandoffAuthorization({ grantor: impostor, added: recipient, handoffId: "hid-3", authHash: "d".repeat(64) });
      // Claim the grant came from the real, active creator, but it was signed by impostor's key.
      auth.grant.grantor_writer_key_id = creator.writerKeyId;
      const payload = buildAddWriterKeyPayload({ base, added: recipient, principalId: "p", authorization: auth });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, recipient.writerKeyId);
      assert.equal(v.ok, false);
    });

    it("rejects: the acceptance's possession_signature does not verify under the added writer's own key", () => {
      const creator = keypair();
      const recipient = keypair();
      const attacker = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const auth = buildHandoffAuthorization({ grantor: creator, added: recipient, handoffId: "hid-4", authHash: "e".repeat(64) });
      const statementBytes = signaturePreimage("handoff-writer-accept/v1", auth.acceptance.statement as Record<string, unknown>);
      auth.acceptance.possession_signature = sign(attacker.seed, statementBytes); // wrong signer
      const payload = buildAddWriterKeyPayload({ base, added: recipient, principalId: "p", authorization: auth });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, recipient.writerKeyId);
      assert.equal(v.ok, false);
    });

    it("rejects: the acceptance's acceptance_signature does not verify under the grant's admission key", () => {
      const creator = keypair();
      const recipient = keypair();
      const wrongAdmission = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const auth = buildHandoffAuthorization({ grantor: creator, added: recipient, handoffId: "hid-5", authHash: "f".repeat(64) });
      const statementBytes = signaturePreimage("handoff-writer-accept/v1", auth.acceptance.statement as Record<string, unknown>);
      auth.acceptance.acceptance_signature = sign(wrongAdmission.seed, statementBytes); // not the grant's own admission key
      const payload = buildAddWriterKeyPayload({ base, added: recipient, principalId: "p", authorization: auth });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, recipient.writerKeyId);
      assert.equal(v.ok, false);
    });

    it("rejects: handoff_id / auth_hash mismatch between grant and acceptance statement", () => {
      const creator = keypair();
      const recipient = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const auth = buildHandoffAuthorization({ grantor: creator, added: recipient, handoffId: "hid-6", authHash: "1".repeat(64) });
      auth.grant.handoff_id = "hid-DIFFERENT";
      const payload = buildAddWriterKeyPayload({ base, added: recipient, principalId: "p", authorization: auth });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, recipient.writerKeyId);
      assert.equal(v.ok, false);
    });

    it("rejects: a grant cannot be spent twice (single-use handoff_id burn)", () => {
      const creator = keypair();
      const recipient = keypair();
      const second = keypair();
      let state = initialWriterState(REPO_ID, genesisFor(creator));
      const auth1 = buildHandoffAuthorization({ grantor: creator, added: recipient, handoffId: "hid-reuse", authHash: "2".repeat(64) });
      const payload1 = buildAddWriterKeyPayload({ base: state, added: recipient, principalId: "p1", authorization: auth1 });
      assert.deepEqual(validateAddWriterKeyPayload(REPO_ID, state, payload1, recipient.writerKeyId), { ok: true });
      state = applyAddWriterKey(REPO_ID, state, { writer_key_id: recipient.writerKeyId, signing_pubkey: recipient.pubB64u }, "hid-reuse");

      // A second add_writer_key head embeds a DIFFERENT signature pair but the SAME handoff_id.
      const auth2 = buildHandoffAuthorization({ grantor: creator, added: second, handoffId: "hid-reuse", authHash: "2".repeat(64) });
      const payload2 = buildAddWriterKeyPayload({ base: state, added: second, principalId: "p2", authorization: auth2 });
      const v = validateAddWriterKeyPayload(REPO_ID, state, payload2, second.writerKeyId);
      assert.equal(v.ok, false);
    });

    it("rejects: a grant with its signature stripped (malformed 'handoff' authorization)", () => {
      const creator = keypair();
      const recipient = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const auth = buildHandoffAuthorization({ grantor: creator, added: recipient, handoffId: "hid-7", authHash: "3".repeat(64) });
      delete auth.grant.signature;
      const payload = buildAddWriterKeyPayload({ base, added: recipient, principalId: "p", authorization: auth });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, recipient.writerKeyId);
      assert.equal(v.ok, false);
    });

    it("rejects: grant.object_kind is not writer_admission_grant (cross-domain signature reuse defense)", () => {
      const creator = keypair();
      const recipient = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));
      const auth = buildHandoffAuthorization({ grantor: creator, added: recipient, handoffId: "hid-8", authHash: "6".repeat(64) });
      auth.grant.object_kind = "head";
      const payload = buildAddWriterKeyPayload({ base, added: recipient, principalId: "p", authorization: auth });
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, recipient.writerKeyId);
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.code, "VALIDATION_FAILED");
    });
  });

  describe("two writers / two activations race (D229) — apply is pure and re-derivable, no receipt to unwind", () => {
    it("a CAS loser recomputes its base from the winner's next map and reuses its own unconsumed grant", () => {
      const creator = keypair();
      const b = keypair();
      const c = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(creator));

      // B wins first.
      const authB = buildHandoffAuthorization({ grantor: creator, added: b, handoffId: "hid-b", authHash: "4".repeat(64) });
      const payloadB = buildAddWriterKeyPayload({ base, added: b, principalId: "pb", authorization: authB });
      assert.deepEqual(validateAddWriterKeyPayload(REPO_ID, base, payloadB, b.writerKeyId), { ok: true });
      const afterB = applyAddWriterKey(REPO_ID, base, { writer_key_id: b.writerKeyId, signing_pubkey: b.pubB64u }, "hid-b");

      // C's own grant/acceptance were built against the ORIGINAL base; C rebuilds against afterB.
      const authC = buildHandoffAuthorization({ grantor: creator, added: c, handoffId: "hid-c", authHash: "5".repeat(64) });
      const payloadC = buildAddWriterKeyPayload({ base: afterB, added: c, principalId: "pc", authorization: authC });
      const v = validateAddWriterKeyPayload(REPO_ID, afterB, payloadC, c.writerKeyId);
      assert.deepEqual(v, { ok: true });
      const afterC = applyAddWriterKey(REPO_ID, afterB, { writer_key_id: c.writerKeyId, signing_pubkey: c.pubB64u }, "hid-c");
      assert.equal(afterC.writers.length, 3);
    });
  });

  describe("rotate_epoch{writer_set_update} — removal (D227/D228)", () => {
    it("accepts: the survivor's rotation removes exactly the blocked key", () => {
      const creator = keypair();
      const b = keypair();
      let state = initialWriterState(REPO_ID, genesisFor(creator));
      state = applyAddWriterKey(REPO_ID, state, { writer_key_id: b.writerKeyId, signing_pubkey: b.pubB64u }, null);

      const nextVersion = (BigInt("0x" + state.version) + 1n).toString(16).padStart(16, "0");
      const nextWriters = [{ writer_key_id: creator.writerKeyId, signing_pubkey: creator.pubB64u }];
      const update = {
        base_version: state.version,
        base_sha256: state.sha256,
        next_version: nextVersion,
        next_sha256: writerSetSha256(REPO_ID, nextVersion, nextWriters),
        removed: [{ writer_key_id: b.writerKeyId, principal_id: "pb", reason: "member_removed" }],
        writers: nextWriters,
      };
      const v = validateWriterSetUpdate(REPO_ID, state, update, creator.writerKeyId, new Set([b.writerKeyId]), false);
      assert.deepEqual(v, { ok: true });
    });

    it("rejects: a rotation that forgets a blocked writer (RECIPIENT_SET_MISMATCH)", () => {
      const creator = keypair();
      const b = keypair();
      const dCompromised = keypair();
      let state = initialWriterState(REPO_ID, genesisFor(creator));
      state = applyAddWriterKey(REPO_ID, state, { writer_key_id: b.writerKeyId, signing_pubkey: b.pubB64u }, null);
      state = applyAddWriterKey(REPO_ID, state, { writer_key_id: dCompromised.writerKeyId, signing_pubkey: dCompromised.pubB64u }, null);

      // Blocked set = {b, d}, but the declared removal only names b.
      const nextVersion = (BigInt("0x" + state.version) + 1n).toString(16).padStart(16, "0");
      const nextWriters = [
        { writer_key_id: creator.writerKeyId, signing_pubkey: creator.pubB64u },
        { writer_key_id: dCompromised.writerKeyId, signing_pubkey: dCompromised.pubB64u },
      ].sort((x, y) => (x.writer_key_id < y.writer_key_id ? -1 : 1));
      const update = {
        base_version: state.version,
        base_sha256: state.sha256,
        next_version: nextVersion,
        next_sha256: writerSetSha256(REPO_ID, nextVersion, nextWriters),
        removed: [{ writer_key_id: b.writerKeyId, principal_id: "pb", reason: "member_removed" }],
        writers: nextWriters,
      };
      const v = validateWriterSetUpdate(REPO_ID, state, update, creator.writerKeyId, new Set([b.writerKeyId, dCompromised.writerKeyId]), false);
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.code, "RECIPIENT_SET_MISMATCH");
    });

    it("rejects: the last writer is removed without the explicit sole-writer force (EPOCH_ROTATION_WOULD_LEAVE_VAULT_UNCOVERED)", () => {
      const creator = keypair();
      const state = initialWriterState(REPO_ID, genesisFor(creator));
      const nextVersion = (BigInt("0x" + state.version) + 1n).toString(16).padStart(16, "0");
      const update = {
        base_version: state.version,
        base_sha256: state.sha256,
        next_version: nextVersion,
        next_sha256: writerSetSha256(REPO_ID, nextVersion, []),
        removed: [{ writer_key_id: creator.writerKeyId, principal_id: "pc", reason: "writer_key_revoked" }],
        writers: [],
      };
      const v = validateWriterSetUpdate(REPO_ID, state, update, creator.writerKeyId, new Set([creator.writerKeyId]), false);
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.code, "EPOCH_ROTATION_WOULD_LEAVE_VAULT_UNCOVERED");
    });

    it("accepts the explicit forced sole-writer removal: the vault enters the read-only terminal, not an error", () => {
      const creator = keypair();
      const state = initialWriterState(REPO_ID, genesisFor(creator));
      const nextVersion = (BigInt("0x" + state.version) + 1n).toString(16).padStart(16, "0");
      const update = {
        base_version: state.version,
        base_sha256: state.sha256,
        next_version: nextVersion,
        next_sha256: writerSetSha256(REPO_ID, nextVersion, []),
        removed: [{ writer_key_id: creator.writerKeyId, principal_id: "pc", reason: "writer_key_revoked" }],
        writers: [],
      };
      const v = validateWriterSetUpdate(REPO_ID, state, update, creator.writerKeyId, new Set([creator.writerKeyId]), true);
      assert.deepEqual(v, { ok: true });
      const after = applyWriterSetUpdate(REPO_ID, state, [creator.writerKeyId]);
      assert.equal(after.writers.length, 0);
      assert.ok(after.burnedWriterKeyIds.has(creator.writerKeyId));
    });

    it("rejects: the rotation head's own signer must remain in the next writer set", () => {
      const creator = keypair();
      const b = keypair();
      let state = initialWriterState(REPO_ID, genesisFor(creator));
      state = applyAddWriterKey(REPO_ID, state, { writer_key_id: b.writerKeyId, signing_pubkey: b.pubB64u }, null);
      const nextVersion = (BigInt("0x" + state.version) + 1n).toString(16).padStart(16, "0");
      const nextWriters = [{ writer_key_id: b.writerKeyId, signing_pubkey: b.pubB64u }];
      const update = {
        base_version: state.version,
        base_sha256: state.sha256,
        next_version: nextVersion,
        next_sha256: writerSetSha256(REPO_ID, nextVersion, nextWriters),
        removed: [{ writer_key_id: creator.writerKeyId, principal_id: "pc", reason: "writer_key_revoked" }],
        writers: nextWriters,
      };
      // creator signs its OWN removal head -- refused, the signer must survive.
      const v = validateWriterSetUpdate(REPO_ID, state, update, creator.writerKeyId, new Set([creator.writerKeyId]), false);
      assert.equal(v.ok, false);
    });
  });

  describe("DR replay (protocol §5A 'Writer-set DR') — pure re-derivation from genesis + admitted transitions alone", () => {
    it("replays to the identical state applyAddWriterKey/applyWriterSetUpdate would reach incrementally", () => {
      const creator = keypair();
      const b = keypair();
      const c = keypair();
      const genesis = genesisFor(creator);

      let incremental = initialWriterState(REPO_ID, genesis);
      incremental = applyAddWriterKey(REPO_ID, incremental, { writer_key_id: b.writerKeyId, signing_pubkey: b.pubB64u }, "hid-x");
      incremental = applyAddWriterKey(REPO_ID, incremental, { writer_key_id: c.writerKeyId, signing_pubkey: c.pubB64u }, null);
      incremental = applyWriterSetUpdate(REPO_ID, incremental, [b.writerKeyId]);

      const replayed = replayWriterState(REPO_ID, genesis, [
        { kind: "add_writer_key", addedWriter: { writer_key_id: b.writerKeyId, signing_pubkey: b.pubB64u }, consumedHandoffId: "hid-x" },
        { kind: "add_writer_key", addedWriter: { writer_key_id: c.writerKeyId, signing_pubkey: c.pubB64u }, consumedHandoffId: null },
        { kind: "writer_set_update", removedWriterKeyIds: [b.writerKeyId] },
      ]);

      assert.equal(replayed.version, incremental.version);
      assert.equal(replayed.sha256, incremental.sha256);
      assert.deepEqual([...replayed.writers], [...incremental.writers]);
      assert.deepEqual([...replayed.burnedWriterKeyIds], [...incremental.burnedWriterKeyIds]);
    });
  });

  it("MAX_VAULT_WRITERS is the protocol constant (64)", () => {
    assert.equal(MAX_VAULT_WRITERS, 64);
  });

  it("rejects: a vault already at MAX_VAULT_WRITERS refuses one more, regardless of authorization.kind", () => {
    const creator = keypair();
    const member = keypair();
    const fullWriters = Array.from({ length: MAX_VAULT_WRITERS }, (_, i) => ({
      writer_key_id: "vk_" + i.toString(16).padStart(32, "0"),
      signing_pubkey: creator.pubB64u,
    })).sort((a, b) => (a.writer_key_id < b.writer_key_id ? -1 : a.writer_key_id > b.writer_key_id ? 1 : 0));
    const version = "0000000000000005";
    const full: WriterChainState = {
      version,
      writers: fullWriters,
      sha256: writerSetSha256(REPO_ID, version, fullWriters),
      burnedWriterKeyIds: new Set(),
      consumedHandoffIds: new Set(),
    };
    const payload = buildAddWriterKeyPayload({ base: full, added: member, principalId: "p", authorization: { kind: "writer" } });
    const v = validateAddWriterKeyPayload(REPO_ID, full, payload, fullWriters[0]!.writer_key_id);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.detail, /MAX_VAULT_WRITERS/);
  });

  it("accepts: a vault at MAX_VAULT_WRITERS - 1 can still add one more (the boundary is inclusive, not off-by-one)", () => {
    const creator = keypair();
    const member = keypair();
    const almostFullWriters = Array.from({ length: MAX_VAULT_WRITERS - 1 }, (_, i) => ({
      writer_key_id: "vk_" + i.toString(16).padStart(32, "0"),
      signing_pubkey: creator.pubB64u,
    })).sort((a, b) => (a.writer_key_id < b.writer_key_id ? -1 : a.writer_key_id > b.writer_key_id ? 1 : 0));
    const version = "0000000000000005";
    const almostFull: WriterChainState = {
      version,
      writers: almostFullWriters,
      sha256: writerSetSha256(REPO_ID, version, almostFullWriters),
      burnedWriterKeyIds: new Set(),
      consumedHandoffIds: new Set(),
    };
    const payload = buildAddWriterKeyPayload({ base: almostFull, added: member, principalId: "p", authorization: { kind: "writer" } });
    const v = validateAddWriterKeyPayload(REPO_ID, almostFull, payload, almostFullWriters[0]!.writer_key_id);
    assert.deepEqual(v, { ok: true });
  });

  describe("meetsWriterEligibleRole (developer or above)", () => {
    it("developer, admin, owner meet the threshold; billing, viewer, unknown, null, undefined do not", async () => {
      const { meetsWriterEligibleRole } = await import("./gitvault-writer-state.js");
      for (const r of ["developer", "admin", "owner"]) assert.equal(meetsWriterEligibleRole(r), true);
      for (const r of ["billing", "viewer", "superuser", "", null, undefined]) assert.equal(meetsWriterEligibleRole(r), false);
    });
  });

  describe("predictMintedRole (gitvault-multi-writer task 5.5 — mirrors mintHandoff's own attenuation formula)", () => {
    it("no requested role: predicts the minter's own role, for every role", async () => {
      const { predictMintedRole } = await import("./gitvault-writer-state.js");
      for (const minter of ["owner", "admin", "developer", "billing", "viewer"]) {
        assert.equal(predictMintedRole(undefined, minter), minter);
      }
    });

    it("requested role BELOW the minter's own: honored (narrower is fine) — matches mintHandoff's own attenuation test precedent", async () => {
      const { predictMintedRole } = await import("./gitvault-writer-state.js");
      assert.equal(predictMintedRole("developer", "owner"), "developer");
      assert.equal(predictMintedRole("viewer", "admin"), "viewer");
    });

    it("requested role ABOVE the minter's own: clamped to the minter's role, never widened", async () => {
      const { predictMintedRole } = await import("./gitvault-writer-state.js");
      assert.equal(predictMintedRole("owner", "developer"), "developer");
      assert.equal(predictMintedRole("admin", "viewer"), "viewer");
    });

    it("requested role EQUAL to the minter's own: predicts that same role (the tie is not \"below\", so it is honored either way)", async () => {
      const { predictMintedRole } = await import("./gitvault-writer-state.js");
      assert.equal(predictMintedRole("developer", "developer"), "developer");
    });

    it("an unrecognized requested role string is never predicted verbatim — falls back to the minter's own role", async () => {
      const { predictMintedRole } = await import("./gitvault-writer-state.js");
      assert.equal(predictMintedRole("superuser", "developer"), "developer");
      assert.equal(predictMintedRole("", "owner"), "owner");
    });
  });

  describe("buildAddWriterKeyActivationPayload (gitvault-multi-writer task 5.6 — GitvaultVault.submitWriterActivationHead's pure assembly step)", () => {
    it("round-trips through validateAddWriterKeyPayload: a real grantor, a real grant+acceptance (task 5.4's own builders), and this function's payload — accepted end to end", () => {
      const grantor = keypair();
      const added = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(grantor));
      const handoffId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      const authHash = sha256Hex(new Uint8Array(32));
      const authorization = buildHandoffAuthorization({ grantor, added, handoffId, authHash });

      const payload = buildAddWriterKeyActivationPayload(REPO_ID, base, { writer_key_id: added.writerKeyId, signing_pubkey: added.pubB64u, principal_id: "prin_bob" }, handoffId, authorization.grant, authorization.acceptance);

      assert.equal(payload.schema, "r402s.add-writer-key/v1");
      assert.equal(payload.base_writer_set.version, base.version);
      assert.equal(payload.base_writer_set.sha256, base.sha256);
      assert.equal(payload.next_writer_set.version, "0000000000000001");
      assert.deepEqual(
        [...payload.next_writer_set.writers].map((w) => w.writer_key_id).sort(),
        [grantor.writerKeyId, added.writerKeyId].sort(),
      );
      assert.equal(payload.added_writer.writer_key_id, added.writerKeyId);
      assert.equal(payload.added_writer.principal_id, "prin_bob");

      // The added key itself signs the carrying head in the real flow — "handoff" doors are self-signed by the added key (protocol §4.17).
      const v = validateAddWriterKeyPayload(REPO_ID, base, payload, added.writerKeyId);
      assert.deepEqual(v, { ok: true });
    });

    it("computes the SAME next_writer_set a manual application of applyAddWriterKey would (no drift between this function and the chain-replay logic it wraps)", () => {
      const grantor = keypair();
      const added = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(grantor));
      const expected = applyAddWriterKey(REPO_ID, base, { writer_key_id: added.writerKeyId, signing_pubkey: added.pubB64u }, "some-handoff-id");

      const payload = buildAddWriterKeyActivationPayload(REPO_ID, base, { writer_key_id: added.writerKeyId, signing_pubkey: added.pubB64u, principal_id: "prin_bob" }, "some-handoff-id", {}, {});

      assert.equal(payload.next_writer_set.version, expected.version);
      assert.equal(payload.next_writer_set.sha256, expected.sha256);
      assert.deepEqual([...payload.next_writer_set.writers], [...expected.writers]);
    });

    it("accepts a bare {version, sha256, writers} predecessor pin — the exact shape GitvaultRepoFile.writer_set_pin persists, no WriterChainState (with its Sets) required", () => {
      const grantor = keypair();
      const added = keypair();
      const base = initialWriterState(REPO_ID, genesisFor(grantor));
      // Simulates reading `repoFile().writer_set_pin` directly: a plain object with no burnedWriterKeyIds/consumedHandoffIds.
      const pin = { version: base.version, sha256: base.sha256, writers: base.writers };
      const payload = buildAddWriterKeyActivationPayload(REPO_ID, pin, { writer_key_id: added.writerKeyId, signing_pubkey: added.pubB64u, principal_id: "prin_bob" }, "some-handoff-id", {}, {});
      assert.equal(payload.base_writer_set.sha256, base.sha256);
    });
  });
});
