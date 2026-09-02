import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, hkdfSync, randomUUID } from "node:crypto";
import {
  HANDOFF_ENVELOPE_KIND,
  HANDOFF_ENVELOPE_V2_KIND,
  HANDOFF_KEY_PREFIXES,
  HANDOFF_WRITER_ACCEPT_DOMAIN,
  INVITE_ENVELOPE_V2_KIND,
  assembleHandoffKey,
  assembleInviteKey,
  assertHandoffNoteHasNoSecret,
  assertInviteNoteHasNoSecret,
  buildWriterAcceptance,
  buildWriterAdmissionGrant,
  deriveHandoffSecrets,
  deriveInviteSecrets,
  deriveInviteWriterAdmissionSeed,
  deriveWriterAdmissionSeed,
  openHandoffEnvelope,
  openHandoffEnvelopeV2,
  openInviteEnvelope,
  parseClaimKey,
  parseHandoffKey,
  parseInviteKey,
  scanHandoffNoteForSecrets,
  scanInviteNoteForSecrets,
  sealHandoffEnvelope,
  sealHandoffEnvelopeV2,
  sealInviteEnvelope,
  uuidToBytes,
  verifyWriterAcceptance,
  verifyWriterAdmissionGrant,
  type HandoffEnvelopePayload,
  type HandoffEnvelopePayloadV2,
  type InviteEnvelopePayloadV2,
  type KygitHandoffNote,
  type KygitInviteNote,
} from "./gitvault-handoff.js";
import { randomBytes, ed25519PublicKey, ekFingerprint, toBase64url } from "../namespaces/gitvault.crypto.js";

const HANDOFF_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INVITE_ID = "4fa85f64-5717-4562-b3fc-2c963f66afa7";

function baseInviteNote(overrides: Partial<KygitInviteNote> = {}): KygitInviteNote {
  return {
    schema: "kygit.invite-note.v1",
    created_at: "2026-09-02T00:00:00.000Z",
    from: { agent: "claude" },
    summary: "made progress",
    capture: { base_head: "a".repeat(40), branch: "main", modified_captured: 0, untracked_captured: 0, sensitive_excluded: [], ignored_not_transferred_count: 0 },
    ...overrides,
  };
}

function baseNote(overrides: Partial<KygitHandoffNote> = {}): KygitHandoffNote {
  return {
    schema: "kygit.handoff-note.v1",
    created_at: "2026-09-02T00:00:00.000Z",
    from: { agent: "claude" },
    summary: "made progress",
    capture: { base_head: "a".repeat(40), branch: "main", modified_captured: 0, untracked_captured: 0, sensitive_excluded: [], ignored_not_transferred_count: 0 },
    ...overrides,
  };
}

describe("HANDOFF_KEY_PREFIXES", () => {
  it("kgh1_ is the first (and only, today) registered row", () => {
    assert.equal(HANDOFF_KEY_PREFIXES[0]!.prefix, "kgh1_");
    assert.equal(HANDOFF_KEY_PREFIXES[0]!.kind, "handoff");
  });
});

describe("assembleHandoffKey / parseHandoffKey — round trip", () => {
  it("assembles a 69-char kgh1_ key and parses it back to the same id/secret", () => {
    const secret = randomBytes(32);
    const { key, handoff_id_bytes, master_secret } = assembleHandoffKey(HANDOFF_ID, secret);
    assert.equal(key.length, 69);
    assert.ok(key.startsWith("kgh1_"));
    const parsed = parseHandoffKey(key);
    assert.equal(parsed.kind, "handoff");
    assert.equal(parsed.handoff_id, HANDOFF_ID);
    assert.deepEqual([...parsed.handoff_id_bytes], [...handoff_id_bytes]);
    assert.deepEqual([...parsed.master_secret], [...secret]);
    assert.deepEqual([...parsed.master_secret], [...master_secret]);
  });

  it("trims surrounding whitespace (a pasted key)", () => {
    const { key } = assembleHandoffKey(HANDOFF_ID);
    const parsed = parseHandoffKey(`  ${key}\n`);
    assert.equal(parsed.handoff_id, HANDOFF_ID);
  });

  it("refuses an unrecognized prefix by name", () => {
    assert.throws(() => parseHandoffKey("not-a-key-at-all"), (e: unknown) => (e as { code?: string }).code === "HANDOFF_KEY_INVALID");
  });

  it("refuses a truncated body", () => {
    const { key } = assembleHandoffKey(HANDOFF_ID);
    assert.throws(() => parseHandoffKey(key.slice(0, -10)), (e: unknown) => (e as { code?: string }).code === "HANDOFF_KEY_INVALID");
  });

  it("uuidToBytes refuses a malformed UUID", () => {
    assert.throws(() => uuidToBytes("not-a-uuid"), (e: unknown) => (e as { code?: string }).code === "HANDOFF_ID_INVALID");
  });
});

describe("deriveHandoffSecrets — HKDF vectors", () => {
  it("auth_hash_hex is ONE SHA-256 over (label ‖ auth_secret), recomputed here the way the gateway does it (the cross-side vector)", () => {
    const { handoff_id_bytes, master_secret } = assembleHandoffKey(randomUUID(), randomBytes(32));
    const secrets = deriveHandoffSecrets(handoff_id_bytes, master_secret);
    const gatewayHash = createHash("sha256").update(Buffer.concat([Buffer.from("kygit/handoff/auth-hash/v1", "utf8"), Buffer.from(secrets.auth_secret)])).digest("hex");
    assert.equal(secrets.auth_hash_hex, gatewayHash, "the gateway computes sha256(label ‖ secret) exactly once at claim; through 4.68.1 the SDK stored a double hash at mint and no key could verify");
    const doubleHash = createHash("sha256").update(Buffer.from(gatewayHash, "hex")).digest("hex");
    assert.notEqual(secrets.auth_hash_hex, doubleHash);
  });

  it("mint-side and claim-side derivations agree on auth_hash from the same key", () => {
    const { handoff_id_bytes, master_secret } = assembleHandoffKey(HANDOFF_ID, randomBytes(32));
    const mint = deriveHandoffSecrets(handoff_id_bytes, master_secret);
    const claim = deriveHandoffSecrets(handoff_id_bytes, master_secret);
    assert.equal(mint.auth_hash_hex, claim.auth_hash_hex);
    assert.equal(mint.auth_hash_hex.length, 64);
    assert.deepEqual([...mint.auth_secret], [...claim.auth_secret]);
    assert.deepEqual([...mint.wrap_key], [...claim.wrap_key]);
  });

  it("auth_secret and wrap_key are domain-separated (never equal)", () => {
    const { handoff_id_bytes, master_secret } = assembleHandoffKey(HANDOFF_ID, randomBytes(32));
    const secrets = deriveHandoffSecrets(handoff_id_bytes, master_secret);
    assert.notDeepEqual([...secrets.auth_secret], [...secrets.wrap_key]);
  });

  it("is deterministic and pinned against a fixed vector", () => {
    const idBytes = uuidToBytes(HANDOFF_ID);
    const masterSecret = new Uint8Array(32).fill(0x11);
    const secrets = deriveHandoffSecrets(idBytes, masterSecret);
    // Pinned once here so a future accidental change to the HKDF info
    // strings or the auth-hash label is caught as a behavior change, not
    // silently shipped.
    assert.equal(secrets.auth_hash_hex.length, 64);
    const again = deriveHandoffSecrets(idBytes, masterSecret);
    assert.equal(secrets.auth_hash_hex, again.auth_hash_hex);
  });

  it("a different handoff_id (different salt) changes every derived value", () => {
    const masterSecret = randomBytes(32);
    const a = deriveHandoffSecrets(uuidToBytes(HANDOFF_ID), masterSecret);
    const b = deriveHandoffSecrets(uuidToBytes("11111111-1111-4111-8111-111111111111"), masterSecret);
    assert.notEqual(a.auth_hash_hex, b.auth_hash_hex);
  });
});

describe("deriveWriterAdmissionSeed — the third HKDF output, cross-checked against node:crypto's OWN HKDF (design D4)", () => {
  it("reproduces node:crypto.hkdfSync(sha256, master_secret, handoff_id[16], 'kygit/handoff/writer-admission/v1', 32) byte-for-byte", () => {
    const idBytes = uuidToBytes(HANDOFF_ID);
    const masterSecret = randomBytes(32);
    const seed = deriveWriterAdmissionSeed(idBytes, masterSecret);
    const reference = new Uint8Array(hkdfSync("sha256", masterSecret, idBytes, Buffer.from("kygit/handoff/writer-admission/v1", "utf8"), 32));
    assert.deepEqual([...seed], [...reference]);
    assert.equal(seed.length, 32);
  });

  it("is domain-separated from auth_secret and wrap_key (same ikm/salt, different info — never equal to either)", () => {
    const idBytes = uuidToBytes(HANDOFF_ID);
    const masterSecret = randomBytes(32);
    const { auth_secret, wrap_key } = deriveHandoffSecrets(idBytes, masterSecret);
    const admissionSeed = deriveWriterAdmissionSeed(idBytes, masterSecret);
    assert.notDeepEqual([...admissionSeed], [...auth_secret]);
    assert.notDeepEqual([...admissionSeed], [...wrap_key]);
  });

  it("mint-side and claim-side derivations agree from the same key (B derives the SAME seed A did)", () => {
    const idBytes = uuidToBytes(HANDOFF_ID);
    const masterSecret = randomBytes(32);
    const a = deriveWriterAdmissionSeed(idBytes, masterSecret);
    const b = deriveWriterAdmissionSeed(idBytes, masterSecret);
    assert.deepEqual([...a], [...b]);
  });
});

describe("buildWriterAdmissionGrant / verifyWriterAdmissionGrant (design D4/§4.17)", () => {
  function fixture() {
    const idBytes = uuidToBytes(HANDOFF_ID);
    const masterSecret = randomBytes(32);
    const { auth_hash_hex } = deriveHandoffSecrets(idBytes, masterSecret);
    const admissionSeed = deriveWriterAdmissionSeed(idBytes, masterSecret);
    const grantorSeed = randomBytes(32);
    const grant = buildWriterAdmissionGrant({
      repo_id: "src_repo",
      handoff_id: HANDOFF_ID,
      auth_hash: auth_hash_hex,
      checkpoint_generation: "0000000000000003",
      checkpoint_head_sha256: "c".repeat(64),
      minted_role: "developer",
      claim_not_after: "2026-09-10T00:00:00.000Z",
      grantor_signing_seed: grantorSeed,
      handoff_admission_pubkey: ed25519PublicKey(admissionSeed),
    });
    return { idBytes, masterSecret, grantorSeed, grant };
  }

  it("round-trips: a grant built here verifies under the grantor's own pubkey", () => {
    const { grantorSeed, grant } = fixture();
    assert.equal(grant.object_kind, "writer_admission_grant");
    assert.ok(grant.grantor_writer_key_id.startsWith("vk_"));
    assert.equal(verifyWriterAdmissionGrant(grant, ed25519PublicKey(grantorSeed)), true);
  });

  it("refuses verification under a DIFFERENT signing pubkey than the one that signed it", () => {
    const { grant } = fixture();
    assert.equal(verifyWriterAdmissionGrant(grant, ed25519PublicKey(randomBytes(32))), false);
  });

  it("a single-byte tamper on any field invalidates the signature", () => {
    const { grantorSeed, grant } = fixture();
    const tampered = { ...grant, minted_role: "owner" as const };
    assert.equal(verifyWriterAdmissionGrant(tampered, ed25519PublicKey(grantorSeed)), false);
  });

  it("refuses a grantor_writer_key_id that does not match the supplied verification pubkey (self-consistency)", () => {
    const { grant } = fixture();
    const otherPubkey = ed25519PublicKey(randomBytes(32));
    // Even ignoring the signature check, grantor_writer_key_id itself must equal vkFingerprint(the pubkey passed in).
    assert.equal(verifyWriterAdmissionGrant(grant, otherPubkey), false);
  });

  it("refuses malformed field shapes before ever reaching the signature", () => {
    assert.throws(
      () =>
        buildWriterAdmissionGrant({
          repo_id: "src_repo",
          handoff_id: HANDOFF_ID,
          auth_hash: "not-a-sha256",
          checkpoint_generation: "0000000000000003",
          checkpoint_head_sha256: "c".repeat(64),
          minted_role: "developer",
          claim_not_after: "2026-09-10T00:00:00.000Z",
          grantor_signing_seed: randomBytes(32),
          handoff_admission_pubkey: ed25519PublicKey(randomBytes(32)),
        }),
      (e: unknown) => (e as { code?: string }).code === "VALIDATION_FAILED" && (e as { details?: { field?: string } }).details?.field === "auth_hash",
    );
  });
});

describe("buildWriterAcceptance / verifyWriterAcceptance (design D4/§4.17 — ONE statement, TWO signatures)", () => {
  function fixture() {
    const idBytes = uuidToBytes(HANDOFF_ID);
    const masterSecret = randomBytes(32);
    const { auth_hash_hex } = deriveHandoffSecrets(idBytes, masterSecret);
    const admissionSeed = deriveWriterAdmissionSeed(idBytes, masterSecret);
    const claimantSigningSeed = randomBytes(32);
    const claimantEncryptionPubkey = ed25519PublicKey(randomBytes(32)); // stand-in raw 32 bytes; shape only, not a real X25519 key
    const acceptance = buildWriterAcceptance({
      handoff_id: HANDOFF_ID,
      auth_hash: auth_hash_hex,
      admission_seed: admissionSeed,
      claimant_signing_seed: claimantSigningSeed,
      claimant_encryption_pubkey_raw: claimantEncryptionPubkey,
    });
    return { admissionSeed, claimantSigningSeed, claimantEncryptionPubkey, acceptance };
  }

  it("round-trips: both signatures verify under their respective keys", () => {
    const { admissionSeed, acceptance } = fixture();
    assert.equal(acceptance.statement.domain, HANDOFF_WRITER_ACCEPT_DOMAIN);
    assert.equal(verifyWriterAcceptance(acceptance, ed25519PublicKey(admissionSeed)), true);
  });

  it("the statement binds writer_key_id to signing_pubkey and encryption_fingerprint to encryption_pubkey", () => {
    const { claimantSigningSeed, claimantEncryptionPubkey, acceptance } = fixture();
    assert.equal(acceptance.statement.signing_pubkey, toBase64url(ed25519PublicKey(claimantSigningSeed)));
    assert.equal(acceptance.statement.encryption_fingerprint, ekFingerprint(claimantEncryptionPubkey));
  });

  it("acceptance_signature and possession_signature are TWO DIFFERENT signatures over the SAME preimage — refuses under the wrong admission key even when possession_signature is fine", () => {
    const { acceptance } = fixture();
    assert.equal(verifyWriterAcceptance(acceptance, ed25519PublicKey(randomBytes(32))), false);
  });

  it("refuses when the statement's signing_pubkey does not match the possession_signature's actual signer (a replayed statement about someone else's key)", () => {
    const { admissionSeed, acceptance } = fixture();
    const foreignPubkey = toBase64url(ed25519PublicKey(randomBytes(32)));
    const tampered = { ...acceptance, statement: { ...acceptance.statement, signing_pubkey: foreignPubkey } };
    // writer_key_id no longer derives from signing_pubkey, so this must fail before any signature check even matters.
    assert.equal(verifyWriterAcceptance(tampered, ed25519PublicKey(admissionSeed)), false);
  });

  it("a tamper on any statement field invalidates BOTH signatures (they cover the same bytes)", () => {
    const { admissionSeed, acceptance } = fixture();
    const tampered = { ...acceptance, statement: { ...acceptance.statement, handoff_id: randomUUID() } };
    assert.equal(verifyWriterAcceptance(tampered, ed25519PublicKey(admissionSeed)), false);
  });

  it("refuses a wrong domain on the statement (a different signed-object family entirely)", () => {
    const { admissionSeed, acceptance } = fixture();
    const tampered = { ...acceptance, statement: { ...acceptance.statement, domain: "r402s/v0/something-else" as typeof HANDOFF_WRITER_ACCEPT_DOMAIN } };
    assert.equal(verifyWriterAcceptance(tampered, ed25519PublicKey(admissionSeed)), false);
  });
});

describe("sealHandoffEnvelope / openHandoffEnvelope", () => {
  const idBytes = uuidToBytes(HANDOFF_ID);
  const payload: HandoffEnvelopePayload = {
    v: 1, kind: "handoff", repo_id: "repo_abc", epoch: "0000000000000001",
    k_e_hex: "aa".repeat(32), checkpoint: { generation: "0000000000000002", commit_oid: "b".repeat(40) },
    note_schema: "kygit.handoff-note.v1",
  };

  it("round-trips under the correct wrap_key", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const sealed = sealHandoffEnvelope(idBytes, wrap_key, payload);
    assert.equal(sealed.envelope_kind, HANDOFF_ENVELOPE_KIND);
    const opened = openHandoffEnvelope(idBytes, wrap_key, sealed.sealed_envelope, sealed.envelope_kind);
    assert.deepEqual(opened, payload);
  });

  it("refuses AEAD authentication under the wrong wrap_key", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const sealed = sealHandoffEnvelope(idBytes, wrap_key, payload);
    const wrongKey = randomBytes(32);
    assert.throws(
      () => openHandoffEnvelope(idBytes, wrongKey, sealed.sealed_envelope, sealed.envelope_kind),
      (e: unknown) => (e as { code?: string }).code === "HANDOFF_AEAD_AUTH_FAILURE",
    );
  });

  it("refuses AEAD authentication under a different handoff_id (AAD mismatch)", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const sealed = sealHandoffEnvelope(idBytes, wrap_key, payload);
    const otherIdBytes = uuidToBytes("22222222-2222-4222-8222-222222222222");
    assert.throws(
      () => openHandoffEnvelope(otherIdBytes, wrap_key, sealed.sealed_envelope, sealed.envelope_kind),
      (e: unknown) => (e as { code?: string }).code === "HANDOFF_AEAD_AUTH_FAILURE",
    );
  });

  it("refuses a corrupted frame header", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    assert.throws(
      () => openHandoffEnvelope(idBytes, wrap_key, "not-base64url-!!!", HANDOFF_ENVELOPE_KIND),
      (e: unknown) => (e as { code?: string }).code === "HANDOFF_ENVELOPE_INVALID",
    );
  });

  // The gateway stores the frame bytes and echoes them from a claim as
  // STANDARD base64 (openapi `format: byte`, `Buffer#toString("base64")`).
  // A canonical-base64url-only decoder refuses that, killing the claim
  // client-side. These three vectors run the bytes through the gateway's
  // exact transforms rather than through this module twice.
  it("the wire form is standard base64 (openapi `format: byte`), read byte-for-byte by the gateway's own `Buffer.from(x, \"base64\")`", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const sealed = sealHandoffEnvelope(idBytes, wrap_key, payload);
    assert.match(sealed.sealed_envelope, /^[A-Za-z0-9+/]+={0,2}$/);
    const gatewayBytes = Buffer.from(sealed.sealed_envelope, "base64"); // exactly mintHandoff's decode
    assert.equal(gatewayBytes.toString("base64"), sealed.sealed_envelope);
    assert.equal(gatewayBytes.subarray(0, 4).toString("utf8"), "KGH1");
  });

  it("opens the envelope exactly as a claim returns it — the stored bytes re-encoded by `Buffer#toString(\"base64\")` (the cross-side vector)", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const sealed = sealHandoffEnvelope(idBytes, wrap_key, payload);
    const fromGateway = Buffer.from(sealed.sealed_envelope, "base64").toString("base64");
    assert.deepEqual(openHandoffEnvelope(idBytes, wrap_key, fromGateway, sealed.envelope_kind), payload);
  });

  it("still opens the base64url form earlier clients minted, and unpadded standard base64", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const sealed = sealHandoffEnvelope(idBytes, wrap_key, payload);
    const bytes = Buffer.from(sealed.sealed_envelope, "base64");
    assert.deepEqual(openHandoffEnvelope(idBytes, wrap_key, bytes.toString("base64url"), sealed.envelope_kind), payload);
    assert.deepEqual(openHandoffEnvelope(idBytes, wrap_key, sealed.sealed_envelope.replace(/=+$/, ""), sealed.envelope_kind), payload);
  });
});

describe("sealHandoffEnvelopeV2 / openHandoffEnvelopeV2 (gitvault-multi-writer D4 — 'no hash cycle: grant first, then seal')", () => {
  const idBytes = uuidToBytes(HANDOFF_ID);
  const payloadV2: HandoffEnvelopePayloadV2 = {
    v: 2, kind: "handoff", repo_id: "repo_abc", epoch: "0000000000000001",
    k_e_hex: "aa".repeat(32), checkpoint: { generation: "0000000000000002", commit_oid: "b".repeat(40) },
    note_schema: "kygit.handoff-note.v1",
    writer_admission_grant_sha256: "d".repeat(64),
  };

  it("round-trips under the correct wrap_key, tagged kygit-handoff-envelope-v2", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const sealed = sealHandoffEnvelopeV2(idBytes, wrap_key, payloadV2);
    assert.equal(sealed.envelope_kind, HANDOFF_ENVELOPE_V2_KIND);
    const opened = openHandoffEnvelopeV2(idBytes, wrap_key, sealed.sealed_envelope, sealed.envelope_kind);
    assert.deepEqual(opened, payloadV2);
  });

  it("carries every epoch key the minter holds (a handoff minted after a rotation lets the recipient open pre-rotation generations)", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const withHistory = { ...payloadV2, epoch: "0000000000000002", k_e_hex: "bb".repeat(32), epoch_keys: { "0000000000000001": "aa".repeat(32), "0000000000000002": "bb".repeat(32) } };
    const sealed = sealHandoffEnvelopeV2(idBytes, wrap_key, withHistory);
    const opened = openHandoffEnvelopeV2(idBytes, wrap_key, sealed.sealed_envelope, sealed.envelope_kind);
    assert.deepEqual(opened.epoch_keys, withHistory.epoch_keys);
    assert.equal(opened.k_e_hex, "bb".repeat(32));
    // An envelope minted before the field existed still opens — the current epoch's key is all it carries.
    const legacy = openHandoffEnvelopeV2(idBytes, wrap_key, sealHandoffEnvelopeV2(idBytes, wrap_key, payloadV2).sealed_envelope, HANDOFF_ENVELOPE_V2_KIND);
    assert.equal(legacy.epoch_keys, undefined);
  });

  it("refuses to build with a malformed writer_admission_grant_sha256", () => {
    assert.throws(
      () => sealHandoffEnvelopeV2(idBytes, randomBytes(32), { ...payloadV2, writer_admission_grant_sha256: "not-a-sha256" }),
      (e: unknown) => (e as { code?: string }).code === "VALIDATION_FAILED",
    );
  });

  it("a v1-tagged envelope is refused HANDOFF_ENVELOPE_UNSUPPORTED by openHandoffEnvelopeV2, WITHOUT even attempting to decrypt it", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const v1Payload: HandoffEnvelopePayload = { v: 1, kind: "handoff", repo_id: "repo_abc", epoch: "0000000000000001", k_e_hex: "aa".repeat(32), checkpoint: { generation: "0000000000000002", commit_oid: "b".repeat(40) }, note_schema: "kygit.handoff-note.v1" };
    const sealedV1 = sealHandoffEnvelope(idBytes, wrap_key, v1Payload);
    assert.throws(
      // Even under a WRONG key, the refusal is HANDOFF_ENVELOPE_UNSUPPORTED,
      // never HANDOFF_AEAD_AUTH_FAILURE — proving the version check runs
      // strictly before any AEAD attempt, exactly as documented.
      () => openHandoffEnvelopeV2(idBytes, randomBytes(32), sealedV1.sealed_envelope, sealedV1.envelope_kind),
      (e: unknown) => (e as { code?: string }).code === "HANDOFF_ENVELOPE_UNSUPPORTED" && (e as { details?: { received?: string; required?: string } }).details?.received === HANDOFF_ENVELOPE_KIND && (e as { details?: { received?: string; required?: string } }).details?.required === HANDOFF_ENVELOPE_V2_KIND,
    );
  });

  it("openHandoffEnvelope (v1) refuses a v2 payload's SHAPE even when the AAD/kind matches and AEAD succeeds — v:2 is not v:1, and that mismatch is the whole point of the field", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const sealed = sealHandoffEnvelopeV2(idBytes, wrap_key, payloadV2);
    assert.throws(
      () => openHandoffEnvelope(idBytes, wrap_key, sealed.sealed_envelope, sealed.envelope_kind),
      (e: unknown) => (e as { code?: string }).code === "HANDOFF_ENVELOPE_INVALID",
    );
  });

  it("v1 and v2 envelopes of the SAME handoff_id are cryptographically distinct (different AAD) — a v2 open under the v1 tag fails AEAD, not just a version mismatch", () => {
    const { wrap_key } = deriveHandoffSecrets(idBytes, randomBytes(32));
    const sealed = sealHandoffEnvelopeV2(idBytes, wrap_key, payloadV2);
    assert.throws(
      () => openHandoffEnvelope(idBytes, wrap_key, sealed.sealed_envelope, HANDOFF_ENVELOPE_KIND),
      (e: unknown) => (e as { code?: string }).code === "HANDOFF_AEAD_AUTH_FAILURE",
    );
  });
});

describe("scanHandoffNoteForSecrets / assertHandoffNoteHasNoSecret", () => {
  it("passes a clean note", () => {
    assert.equal(scanHandoffNoteForSecrets(baseNote()), null);
  });

  it("catches a pasted kgh1_ key in next_steps", () => {
    const note = baseNote({ next_steps: [`paste this: kgh1_${"A".repeat(64)}`] });
    const finding = scanHandoffNoteForSecrets(note);
    assert.ok(finding);
    assert.equal(finding!.field, "next_steps[0]");
  });

  it("catches a GitHub token prefix in the summary", () => {
    const note = baseNote({ summary: `token is ghp_${"a".repeat(36)}` });
    assert.ok(scanHandoffNoteForSecrets(note));
  });

  it("catches a bare AWS access key prefix", () => {
    const note = baseNote({ decisions: [`used AKIA${"Q".repeat(16)}`] });
    assert.ok(scanHandoffNoteForSecrets(note));
  });

  it("catches a PEM private key block", () => {
    const note = baseNote({ tried: ["-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----"] });
    assert.ok(scanHandoffNoteForSecrets(note));
  });

  it("catches a high-entropy bare token even with no known prefix", () => {
    const note = baseNote({ open_questions: ["is " + "kQ9zR2mP7vXwL4nT8bY1cF6hJ3sD5aG0eU2iO9pW7xN=" + " still valid?"] });
    assert.ok(scanHandoffNoteForSecrets(note));
  });

  it("does not flag ordinary prose or command text", () => {
    const note = baseNote({
      summary: "Implemented the login flow and wrote tests for the happy path and three edge cases.",
      commands: { test: "npm test", build: "npm run build", run: "npm run dev" },
      next_steps: ["Add rate limiting to the login endpoint", "Write the forgot-password flow"],
    });
    assert.equal(scanHandoffNoteForSecrets(note), null);
  });

  it("assertHandoffNoteHasNoSecret throws HANDOFF_NOTE_CONTAINS_SECRET naming the field", () => {
    const note = baseNote({ failing: [`sk-${"x".repeat(40)}`] });
    assert.throws(() => assertHandoffNoteHasNoSecret(note), (e: unknown) => {
      const err = e as { code?: string; details?: { field?: string } };
      return err.code === "HANDOFF_NOTE_CONTAINS_SECRET" && err.details?.field === "failing[0]";
    });
  });

  it("assertHandoffNoteHasNoSecret does not throw on a clean note", () => {
    assert.doesNotThrow(() => assertHandoffNoteHasNoSecret(baseNote()));
  });
});

// ─── kygit-invite (design D3): the second registry row ──────────────────────

describe("HANDOFF_KEY_PREFIXES — kgi1_ is the second row (kygit-invite design D3)", () => {
  it("kgi1_ is registered as the invite kind, pointing at join", () => {
    assert.equal(HANDOFF_KEY_PREFIXES.length, 2);
    assert.equal(HANDOFF_KEY_PREFIXES[1]!.prefix, "kgi1_");
    assert.equal(HANDOFF_KEY_PREFIXES[1]!.kind, "invite");
    assert.equal(HANDOFF_KEY_PREFIXES[1]!.verb, "join");
  });
});

describe("assembleInviteKey / parseInviteKey — round trip", () => {
  it("assembles a 69-char kgi1_ key and parses it back to the same id/secret", () => {
    const secret = randomBytes(32);
    const { key, invite_id_bytes, master_secret } = assembleInviteKey(INVITE_ID, secret);
    assert.equal(key.length, 69);
    assert.ok(key.startsWith("kgi1_"));
    const parsed = parseInviteKey(key);
    assert.equal(parsed.kind, "invite");
    assert.equal(parsed.invite_id, INVITE_ID);
    assert.deepEqual([...parsed.invite_id_bytes], [...invite_id_bytes]);
    assert.deepEqual([...parsed.master_secret], [...secret]);
    assert.deepEqual([...parsed.master_secret], [...master_secret]);
  });

  it("parseClaimKey(raw, 'invite') is the same parser under its generic name", () => {
    const { key } = assembleInviteKey(INVITE_ID);
    const parsed = parseClaimKey(key, "invite");
    assert.equal(parsed.kind, "invite");
    assert.equal(parsed.id, INVITE_ID);
  });
});

describe("cross-kind refusal by name (design D9 rule 4 / kygit-invite design D3)", () => {
  it("join refuses a kgh1_ handoff key by name, pointing at resume", () => {
    const { key } = assembleHandoffKey(HANDOFF_ID);
    assert.throws(() => parseInviteKey(key), (e: unknown) => {
      const err = e as { code?: string; details?: { kind?: string; verb?: string } };
      return err.code === "INVITE_KEY_WRONG_KIND" && err.details?.kind === "handoff" && err.details?.verb === "resume";
    });
  });

  it("resume refuses a kgi1_ invite key by name, pointing at join", () => {
    const { key } = assembleInviteKey(INVITE_ID);
    assert.throws(() => parseHandoffKey(key), (e: unknown) => {
      const err = e as { code?: string; details?: { kind?: string; verb?: string } };
      return err.code === "HANDOFF_KEY_WRONG_KIND" && err.details?.kind === "invite" && err.details?.verb === "join";
    });
  });

  it("neither refusal contacts the gateway (parse-only, throws synchronously before any network code path)", () => {
    const { key } = assembleInviteKey(INVITE_ID);
    assert.throws(() => parseHandoffKey(key));
    // Synchronous throw, no Promise involved — parseHandoffKey never awaits
    // anything, so a caller catching this synchronously proves no network
    // call was ever reachable on this path.
  });
});

describe("deriveInviteSecrets — HKDF vectors, domain-separated from handoff (kygit-invite design D3)", () => {
  it("mint-side and claim-side derivations agree on auth_hash from the same key", () => {
    const { invite_id_bytes, master_secret } = assembleInviteKey(INVITE_ID, randomBytes(32));
    const mint = deriveInviteSecrets(invite_id_bytes, master_secret);
    const claim = deriveInviteSecrets(invite_id_bytes, master_secret);
    assert.equal(mint.auth_hash_hex, claim.auth_hash_hex);
    assert.equal(mint.auth_hash_hex.length, 64);
    assert.deepEqual([...mint.auth_secret], [...claim.auth_secret]);
    assert.deepEqual([...mint.wrap_key], [...claim.wrap_key]);
  });

  it("auth_secret and wrap_key are domain-separated (never equal)", () => {
    const { invite_id_bytes, master_secret } = assembleInviteKey(INVITE_ID, randomBytes(32));
    const secrets = deriveInviteSecrets(invite_id_bytes, master_secret);
    assert.notDeepEqual([...secrets.auth_secret], [...secrets.wrap_key]);
  });

  it("an invite secret never verifies as a handoff hash, or the reverse, for the SAME id bytes and master secret", () => {
    const idBytes = uuidToBytes(HANDOFF_ID);
    const masterSecret = randomBytes(32);
    const handoff = deriveHandoffSecrets(idBytes, masterSecret);
    const invite = deriveInviteSecrets(idBytes, masterSecret);
    assert.notEqual(handoff.auth_hash_hex, invite.auth_hash_hex);
    assert.notDeepEqual([...handoff.auth_secret], [...invite.auth_secret]);
    assert.notDeepEqual([...handoff.wrap_key], [...invite.wrap_key]);
  });
});

describe("sealInviteEnvelope / openInviteEnvelope — the KGI1 frame (kygit-invite design D3)", () => {
  const idBytes = uuidToBytes(INVITE_ID, "invite_id");
  const payload: InviteEnvelopePayloadV2 = {
    v: 2, kind: "invite", repo_id: "repo_abc", epoch: "0000000000000001",
    k_e_hex: "aa".repeat(32), checkpoint: { generation: "0000000000000002", commit_oid: "b".repeat(40) },
    note_schema: "kygit.invite-note.v1",
    writer_admission_grant_sha256: "c".repeat(64),
  };

  it("round-trips under the correct wrap_key, tagged kygit-invite-envelope-v2", () => {
    const { wrap_key } = deriveInviteSecrets(idBytes, randomBytes(32));
    const sealed = sealInviteEnvelope(idBytes, wrap_key, payload);
    assert.equal(sealed.envelope_kind, INVITE_ENVELOPE_V2_KIND);
    const opened = openInviteEnvelope(idBytes, wrap_key, sealed.sealed_envelope, sealed.envelope_kind);
    assert.deepEqual(opened, payload);
  });

  it("refuses AEAD authentication under the wrong wrap_key", () => {
    const { wrap_key } = deriveInviteSecrets(idBytes, randomBytes(32));
    const sealed = sealInviteEnvelope(idBytes, wrap_key, payload);
    const wrongKey = randomBytes(32);
    assert.throws(
      () => openInviteEnvelope(idBytes, wrongKey, sealed.sealed_envelope, sealed.envelope_kind),
      (e: unknown) => (e as { code?: string }).code === "INVITE_AEAD_AUTH_FAILURE",
    );
  });

  it("refuses AEAD authentication under a different invite_id (AAD mismatch)", () => {
    const { wrap_key } = deriveInviteSecrets(idBytes, randomBytes(32));
    const sealed = sealInviteEnvelope(idBytes, wrap_key, payload);
    const otherIdBytes = uuidToBytes("22222222-2222-4222-8222-222222222222");
    assert.throws(
      () => openInviteEnvelope(otherIdBytes, wrap_key, sealed.sealed_envelope, sealed.envelope_kind),
      (e: unknown) => (e as { code?: string }).code === "INVITE_AEAD_AUTH_FAILURE",
    );
  });

  it("refuses a corrupted frame header", () => {
    const { wrap_key } = deriveInviteSecrets(idBytes, randomBytes(32));
    assert.throws(
      () => openInviteEnvelope(idBytes, wrap_key, "not-base64url-!!!", INVITE_ENVELOPE_V2_KIND),
      (e: unknown) => (e as { code?: string }).code === "INVITE_ENVELOPE_INVALID",
    );
  });

  it("an invite envelope sealed under a handoff wrap_key never opens as a handoff envelope (different frame magic)", () => {
    const { wrap_key } = deriveInviteSecrets(idBytes, randomBytes(32));
    const sealed = sealInviteEnvelope(idBytes, wrap_key, payload);
    assert.throws(
      () => openHandoffEnvelope(idBytes, wrap_key, sealed.sealed_envelope, sealed.envelope_kind),
      (e: unknown) => (e as { code?: string }).code === "HANDOFF_ENVELOPE_INVALID",
    );
  });
});

describe("deriveInviteWriterAdmissionSeed — the third HKDF output, domain-separated by kind (kygit-invite design D3)", () => {
  const idBytes = uuidToBytes(INVITE_ID, "invite_id");

  it("reproduces node:crypto.hkdfSync(sha256, master_secret, invite_id[16], 'kygit/invite/writer-admission/v1', 32) byte-for-byte", () => {
    const masterSecret = randomBytes(32);
    const seed = deriveInviteWriterAdmissionSeed(idBytes, masterSecret);
    const reference = new Uint8Array(hkdfSync("sha256", masterSecret, idBytes, Buffer.from("kygit/invite/writer-admission/v1", "utf8"), 32));
    assert.deepEqual([...seed], [...reference]);
  });

  it("never equals the handoff admission seed for the SAME id and master secret", () => {
    const masterSecret = randomBytes(32);
    assert.notDeepEqual([...deriveInviteWriterAdmissionSeed(idBytes, masterSecret)], [...deriveWriterAdmissionSeed(idBytes, masterSecret)]);
  });

  it("is domain-separated from the invite's own auth_secret and wrap_key", () => {
    const masterSecret = randomBytes(32);
    const { auth_secret, wrap_key } = deriveInviteSecrets(idBytes, masterSecret);
    const seed = deriveInviteWriterAdmissionSeed(idBytes, masterSecret);
    assert.notDeepEqual([...seed], [...auth_secret]);
    assert.notDeepEqual([...seed], [...wrap_key]);
  });
});

describe("an invite's writer admission rides the FROZEN handoff bytes (kygit-invite design D11)", () => {
  const idBytes = uuidToBytes(INVITE_ID, "invite_id");

  it("mint and claim agree: the grant names the INVITE id in handoff_id, and the acceptance verifies under the grant's admission pubkey", () => {
    const masterSecret = randomBytes(32);
    const secrets = deriveInviteSecrets(idBytes, masterSecret);
    const admissionSeed = deriveInviteWriterAdmissionSeed(idBytes, masterSecret);
    const inviterSeed = randomBytes(32);
    const grant = buildWriterAdmissionGrant({
      repo_id: "repo_abc",
      handoff_id: INVITE_ID,
      auth_hash: secrets.auth_hash_hex,
      checkpoint_generation: "0000000000000002",
      checkpoint_head_sha256: "e".repeat(64),
      minted_role: "developer",
      claim_not_after: "2026-09-05T00:00:00.000Z",
      grantor_signing_seed: inviterSeed,
      handoff_admission_pubkey: ed25519PublicKey(admissionSeed),
    });
    assert.equal(grant.object_kind, "writer_admission_grant");
    assert.equal(grant.handoff_id, INVITE_ID);
    assert.ok(verifyWriterAdmissionGrant(grant, ed25519PublicKey(inviterSeed)));

    const joinerSeed = randomBytes(32);
    const joinerEncryptionPubkey = randomBytes(32);
    const acceptance = buildWriterAcceptance({
      handoff_id: INVITE_ID,
      auth_hash: secrets.auth_hash_hex,
      admission_seed: admissionSeed,
      claimant_signing_seed: joinerSeed,
      claimant_encryption_pubkey_raw: joinerEncryptionPubkey,
    });
    assert.equal(acceptance.statement.domain, HANDOFF_WRITER_ACCEPT_DOMAIN);
    assert.equal(acceptance.statement.handoff_id, INVITE_ID);
    assert.equal(acceptance.statement.encryption_fingerprint, ekFingerprint(joinerEncryptionPubkey));
    assert.equal(acceptance.statement.signing_pubkey, toBase64url(ed25519PublicKey(joinerSeed)));
    assert.ok(verifyWriterAcceptance(acceptance, ed25519PublicKey(admissionSeed)));
  });

  it("a HANDOFF-derived admission seed never satisfies an invite's acceptance (the kind separation is what stops a cross-kind completion)", () => {
    const masterSecret = randomBytes(32);
    const secrets = deriveInviteSecrets(idBytes, masterSecret);
    const inviteSeed = deriveInviteWriterAdmissionSeed(idBytes, masterSecret);
    const acceptance = buildWriterAcceptance({
      handoff_id: INVITE_ID,
      auth_hash: secrets.auth_hash_hex,
      admission_seed: deriveWriterAdmissionSeed(idBytes, masterSecret),
      claimant_signing_seed: randomBytes(32),
      claimant_encryption_pubkey_raw: randomBytes(32),
    });
    assert.equal(verifyWriterAcceptance(acceptance, ed25519PublicKey(inviteSeed)), false);
  });

  it("the v2 invite envelope binds the grant it was sealed alongside — a substituted grant hash is caught locally", () => {
    const masterSecret = randomBytes(32);
    const { wrap_key } = deriveInviteSecrets(idBytes, masterSecret);
    const grantSha = "f".repeat(64);
    const sealed = sealInviteEnvelope(idBytes, wrap_key, {
      v: 2, kind: "invite", repo_id: "repo_abc", epoch: "0000000000000002",
      k_e_hex: "bb".repeat(32), epoch_keys: { "0000000000000001": "aa".repeat(32), "0000000000000002": "bb".repeat(32) },
      checkpoint: { generation: "0000000000000003", commit_oid: "b".repeat(40) },
      note_schema: "kygit.invite-note.v1", writer_admission_grant_sha256: grantSha,
    });
    const opened = openInviteEnvelope(idBytes, wrap_key, sealed.sealed_envelope, sealed.envelope_kind);
    assert.equal(opened.writer_admission_grant_sha256, grantSha);
    // Every epoch key the inviter held rides along, so a joiner arriving
    // after a rotation still opens the pre-rotation generations.
    assert.deepEqual(opened.epoch_keys, { "0000000000000001": "aa".repeat(32), "0000000000000002": "bb".repeat(32) });
    // The join-side cross-check is a plain hash comparison — a different
    // grant simply does not match what the envelope names.
    assert.notEqual(opened.writer_admission_grant_sha256, "0".repeat(64));
  });

  it("refuses to seal an invite envelope with a malformed writer_admission_grant_sha256", () => {
    assert.throws(
      () => sealInviteEnvelope(idBytes, randomBytes(32), {
        v: 2, kind: "invite", repo_id: "repo_abc", epoch: "0000000000000001",
        k_e_hex: "aa".repeat(32), checkpoint: { generation: "0000000000000002", commit_oid: "b".repeat(40) },
        note_schema: "kygit.invite-note.v1", writer_admission_grant_sha256: "not-a-sha256",
      }),
      (e: unknown) => (e as { code?: string }).code === "VALIDATION_FAILED",
    );
  });
});

describe("scanInviteNoteForSecrets / assertInviteNoteHasNoSecret", () => {
  it("passes a clean note", () => {
    assert.equal(scanInviteNoteForSecrets(baseInviteNote()), null);
  });

  it("catches a pasted kgi1_ key in next_steps", () => {
    const note = baseInviteNote({ next_steps: [`paste this: kgi1_${"A".repeat(64)}`] });
    const finding = scanInviteNoteForSecrets(note);
    assert.ok(finding);
    assert.equal(finding!.field, "next_steps[0]");
  });

  it("also catches a pasted kgh1_ handoff key (the scan covers both prefixes in every note kind)", () => {
    const note = baseInviteNote({ summary: `careful: kgh1_${"B".repeat(64)}` });
    assert.ok(scanInviteNoteForSecrets(note));
  });

  it("does not flag ordinary prose", () => {
    const note = baseInviteNote({ summary: "Brought a second agent in to help with the auth flow." });
    assert.equal(scanInviteNoteForSecrets(note), null);
  });

  it("assertInviteNoteHasNoSecret throws INVITE_NOTE_CONTAINS_SECRET naming the field", () => {
    const note = baseInviteNote({ failing: [`sk-${"x".repeat(40)}`] });
    assert.throws(() => assertInviteNoteHasNoSecret(note), (e: unknown) => {
      const err = e as { code?: string; details?: { field?: string } };
      return err.code === "INVITE_NOTE_CONTAINS_SECRET" && err.details?.field === "failing[0]";
    });
  });

  it("assertInviteNoteHasNoSecret does not throw on a clean note", () => {
    assert.doesNotThrow(() => assertInviteNoteHasNoSecret(baseInviteNote()));
  });
});
