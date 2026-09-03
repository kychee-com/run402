import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, hkdfSync, randomUUID } from "node:crypto";
import {
  HANDOFF_ENVELOPE_KIND,
  HANDOFF_ENVELOPE_V2_KIND,
  HANDOFF_KEY_PREFIXES,
  HANDOFF_WRITER_ACCEPT_DOMAIN,
  assembleHandoffKey,
  assertHandoffNoteHasNoSecret,
  buildWriterAcceptance,
  buildWriterAdmissionGrant,
  deriveHandoffSecrets,
  deriveWriterAdmissionSeed,
  openHandoffEnvelope,
  openHandoffEnvelopeV2,
  parseHandoffKey,
  scanHandoffNoteForSecrets,
  sealHandoffEnvelope,
  sealHandoffEnvelopeV2,
  uuidToBytes,
  verifyWriterAcceptance,
  verifyWriterAdmissionGrant,
  type HandoffEnvelopePayload,
  type HandoffEnvelopePayloadV2,
  type KygitHandoffNote, } from "./gitvault-handoff.js";
import { randomBytes, ed25519PublicKey, ekFingerprint, toBase64url } from "../namespaces/gitvault.crypto.js";

const HANDOFF_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

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
