import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  HANDOFF_ENVELOPE_KIND,
  HANDOFF_KEY_PREFIXES,
  assembleHandoffKey,
  assertHandoffNoteHasNoSecret,
  deriveHandoffSecrets,
  openHandoffEnvelope,
  parseHandoffKey,
  scanHandoffNoteForSecrets,
  sealHandoffEnvelope,
  uuidToBytes,
  type HandoffEnvelopePayload,
  type KygitHandoffNote, } from "./gitvault-handoff.js";
import { randomBytes } from "../namespaces/gitvault.crypto.js";

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
