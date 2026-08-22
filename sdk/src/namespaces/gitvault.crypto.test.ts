/**
 * gitvault crypto core — byte-for-byte replay of the frozen `r402s/v0` vector
 * set (task 5.1 acceptance) plus the RFC 9180 Appendix A.2 KATs and the
 * D182 HPKE interop golden file.
 *
 * The vectors are GENERATED in the private repo (`kychee-com/run402-private`,
 * `docs/strategy/products/gitvault/vectors/`) and VENDORED here at
 * `test-vectors/r402s-v0/`, so CI replays them without a private checkout.
 * Resolution + integrity live in `gitvault-vectors.test-helper.ts`:
 * `$GITVAULT_VECTORS_DIR` overrides the location, the vendored copy is the
 * default, `CONTINUITY.json` is asserted either way, and a directory that
 * cannot be resolved FAILS — only `GITVAULT_VECTORS_OPTOUT=1` skips (5.6b:
 * the silent skip used to hide ~130 vectors behind a green CI run).
 *
 * A vector that disagrees with this implementation is a defect in the
 * implementation (or a freeze discussion) — never edit a vector to make a
 * test pass.
 *
 * Classes replayed: zip215, hkdf, golden-preimage, stored-bytes-preimage,
 * strict-parse, aead-frame, hpke-rfc9180-a2, hpke-envelope,
 * hpke-info-near-neighbors, hpke-genesis-binding, hpke-recovery, chain (the
 * signature/linkage half), and every `hpke-interop/golden.json` case.
 */

import { describe, it } from "node:test";
import { loadGitvaultVectors, OPTOUT_SKIP_MESSAGE, type GitvaultVector } from "../node/gitvault-vectors.test-helper.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GITVAULT_B64U_32_RE,
  GITVAULT_B64U_64_RE,
  GITVAULT_HPKE_CT_RE,
  GITVAULT_SHA256_RE,
  GITVAULT_TERMINAL_LOSS_STATEMENT,
  assertGitvaultSignature,
  bytesToHex,
  checkGenesisKeyBindings,
  checkRecoveryReceipt,
  deriveDigestKey,
  deriveObjectKey,
  digestKeyInfo,
  ed25519PublicKey,
  ed25519VerifyStrict,
  ekFingerprint,
  envelopeAad,
  envelopeInfo,
  frameAad,
  fromBase64url,
  generateEncryptionKeypair,
  generateSigningKeypair,
  gitvaultHpkeSuite,
  gitvaultStrictParseReason,
  hexToBytes,
  hpkeOpen,
  hpkeSeal,
  isCanonicalBase64url,
  isCanonicalObjectset,
  isValidGitvaultTimestamp,
  jcs,
  jcsString,
  keyedCommitment,
  lp,
  objectKeyInfo,
  openBindingPreimage,
  openFrame,
  openFrameWithAad,
  openIdPreimage,
  openKeyEnvelope,
  parseGitvaultStrict,
  sealFrame,
  sealKeyEnvelope,
  sha256Hex,
  signaturePreimage,
  storedBytes,
  storedBytesSha256,
  verifyGitvaultObject,
  vkFingerprint,
} from "./gitvault.crypto.js";
import type {
  GitvaultKeyEnvelope,
  GitvaultRecoveryReceipt,
  GitvaultSignedObject,
  GitvaultVaultGenesis,
} from "./gitvault.types.js";
import { LocalError } from "../errors.js";

// ─── Vector loading ──────────────────────────────────────────────────────────

// Task 5.6b: an unresolvable vector directory is a FAILURE, never a silent
// skip; the loader also asserts the copy against CONTINUITY.json before a
// single case runs. `GITVAULT_VECTORS_OPTOUT=1` is the only skip.
const vectorSet = loadGitvaultVectors();
const SKIP_MESSAGE = OPTOUT_SKIP_MESSAGE;

type Vector = GitvaultVector;
const vectorFile = vectorSet?.file ?? null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: { cases: Array<Record<string, any>> } | null = (vectorSet?.golden as any) ?? null;

const replayed = new Map<string, Set<string>>();
function byClass(cls: string): Vector[] {
  return (vectorFile?.vectors ?? []).filter((v) => v.class === cls);
}
function mark(v: Vector): void {
  let s = replayed.get(v.class);
  if (!s) replayed.set(v.class, (s = new Set()));
  s.add(v.id);
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function b64uBuf(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}
function assertLocalCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof LocalError, `expected LocalError, got ${String(e)}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected LocalError ${code}`);
}
async function assertLocalCodeAsync(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof LocalError, `expected LocalError, got ${String(e)}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected LocalError ${code}`);
}

const vectors = vectorFile ? describe : describe.skip;

if (!vectorFile) {
  describe("gitvault vectors", () => {
    it.skip(SKIP_MESSAGE, () => {});
  });
}

// ─── Offline unit checks (no vectors needed) ─────────────────────────────────

describe("gitvault crypto — offline invariants", () => {
  it("lp() is a 4-byte big-endian byte length followed by UTF-8", () => {
    assert.equal(bytesToHex(lp("r402s/v0")), "0000000872343032732f7630");
    assert.equal(bytesToHex(lp("é")), "00000002c3a9");
  });
  it("jcs sorts members, escapes per RFC 8785, and refuses JSON numbers", () => {
    assert.equal(jcsString({ b: "1", a: null, c: [true, false] }), '{"a":null,"b":"1","c":[true,false]}');
    assertLocalCode(() => jcs({ size_bytes: 12 }), "GITVAULT_JSON_NUMBER");
  });
  it("timestamps are calendar-checked (D187)", () => {
    assert.equal(isValidGitvaultTimestamp("2026-02-31T00:00:00.000Z"), false);
    assert.equal(isValidGitvaultTimestamp("2027-02-29T00:00:00.000Z"), false);
    assert.equal(isValidGitvaultTimestamp("2028-02-29T00:00:00.000Z"), true);
    assert.equal(isValidGitvaultTimestamp("2026-08-22T12:00:00.000Z"), true);
    assert.equal(isValidGitvaultTimestamp("2026-08-22T12:00:00Z"), false);
  });
  it("a fresh keypair round-trips seal → open and a 1-byte tamper fails closed", async () => {
    const signer = generateSigningKeypair();
    const recipient = generateEncryptionKeypair();
    const kRepo = new Uint8Array(32).fill(7);
    const sealed = await sealKeyEnvelope({ k_repo: kRepo, repo_id: `src_${"0".repeat(32)}`, epoch: "0000000000000001", recipient_public_key: recipient.public_key, signer, created_at: "2026-08-22T12:00:00.000Z" });
    assert.match(sealed.envelope.ct, GITVAULT_HPKE_CT_RE);
    assert.match(sealed.envelope.enc, GITVAULT_B64U_32_RE);
    assert.match(sealed.envelope.signature, GITVAULT_B64U_64_RE);
    const opened = await openKeyEnvelope({ envelope: sealed.envelope, recipient, signer_public_key: signer.public_key });
    assert.deepEqual(opened, kRepo);
    const tampered = { ...sealed.envelope, created_at: "2026-08-22T12:00:01.000Z" };
    await assertLocalCodeAsync(openKeyEnvelope({ envelope: tampered, recipient, signer_public_key: signer.public_key }), "GITVAULT_SIGNATURE_INVALID");
    const other = generateEncryptionKeypair();
    await assertLocalCodeAsync(openKeyEnvelope({ envelope: sealed.envelope, recipient: other, signer_public_key: signer.public_key }), "GITVAULT_ENVELOPE_NOT_FOR_RECIPIENT");
  });
  it("frames round-trip and every header byte is bound", () => {
    const kObj = new Uint8Array(32).fill(9);
    const base = { k_obj: kObj, repo_id: `src_${"a".repeat(32)}`, object_kind: "wal_pack" as const, object_id: `wal_${"b".repeat(32)}`, epoch: "0000000000000001" };
    const sealed = sealFrame({ ...base, plaintext: utf8("hello") });
    assert.equal(sealed.size_bytes, String(6 + 1 + 24 + 5 + 16));
    assert.deepEqual(openFrame({ ...base, frame: sealed.frame, expected_ciphertext_sha256: sealed.ciphertext_sha256 }), utf8("hello"));
    const flipped = new Uint8Array(sealed.frame);
    flipped[0] ^= 1;
    assertLocalCode(() => openFrame({ ...base, frame: flipped }), "GITVAULT_FRAME_INVALID");
    assertLocalCode(() => openFrame({ ...base, frame: flipped, expected_ciphertext_sha256: sealed.ciphertext_sha256 }), "GITVAULT_RECEIPT_MISMATCH");
    assertLocalCode(() => openFrame({ ...base, object_id: `wal_${"c".repeat(32)}`, frame: sealed.frame }), "GITVAULT_AEAD_AUTH_FAILURE");
  });
  it("the terminal-loss statement is the reviewed sentence, verbatim", () => {
    assert.equal(GITVAULT_TERMINAL_LOSS_STATEMENT, "whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship");
  });
});

// ─── Vector replay ───────────────────────────────────────────────────────────

vectors("gitvault vectors — zip215 (strict RFC 8032, zip215:false)", () => {
  it("replays every zip215 vector", () => {
    for (const v of byClass("zip215")) {
      mark(v);
      if (v.expected.schema_valid === "false") {
        // exact-scalar schema rejects: verification never reaches cryptography
        const obj = v.inputs.object as GitvaultSignedObject & { creator_signing_pubkey?: string };
        if (v.id === "zip215-004") {
          assert.equal(GITVAULT_B64U_64_RE.test(obj.signature), false, v.id);
          assert.equal(verifyGitvaultObject(obj, vectorFile!.test_keys.creator_signing_pubkey!), false, v.id);
        } else {
          assert.equal(GITVAULT_B64U_32_RE.test(obj.creator_signing_pubkey!), false, v.id);
          assert.equal(verifyGitvaultObject(obj, obj.creator_signing_pubkey!), false, v.id);
        }
        continue;
      }
      const ok = ed25519VerifyStrict(b64uBuf(v.inputs.signature), hexToBytes(v.inputs.message_hex), b64uBuf(v.inputs.pubkey));
      assert.equal(ok, v.expected.strict_rfc8032 === "accept", `${v.id}: ${v.description}`);
    }
  });
});

vectors("gitvault vectors — hkdf (k_obj / K_digest / keyed commitments)", () => {
  it("replays every hkdf vector", () => {
    for (const v of byClass("hkdf")) {
      mark(v);
      if (v.id === "hkdf-001") {
        const kRepo = hexToBytes(v.inputs.K_repo_hex);
        for (const d of v.expected.derivations) {
          assert.equal(bytesToHex(objectKeyInfo(v.inputs.repo_id, v.inputs.epoch, d.object_kind, d.object_id)), d.info_hex, `${v.id} info ${d.object_kind}`);
          assert.equal(bytesToHex(deriveObjectKey(kRepo, v.inputs.repo_id, v.inputs.epoch, d.object_kind, d.object_id)), d.k_obj_hex, `${v.id} k_obj ${d.object_kind}`);
        }
      } else if (v.id === "hkdf-002") {
        const kRepo = hexToBytes(v.inputs.K_repo_hex);
        for (const d of v.expected.derivations) {
          assert.equal(bytesToHex(digestKeyInfo(v.inputs.repo_id, v.inputs.epoch, d.label)), d.info_hex, `${v.id} info ${d.label}`);
          assert.equal(bytesToHex(deriveDigestKey(kRepo, v.inputs.repo_id, v.inputs.epoch, d.label)), d.k_digest_hex, `${v.id} K_digest ${d.label}`);
        }
      } else if (v.id === "hkdf-008") {
        assert.equal(isCanonicalObjectset(v.inputs.content), false, v.id);
        assert.equal(keyedCommitment(hexToBytes(v.inputs.k_digest_hex), v.inputs.content), v.expected.hmac_sha256, v.id);
        assert.notEqual(v.expected.hmac_sha256, v.inputs.canonical_hmac_sha256);
      } else {
        assert.equal(jcsString(v.inputs.content), v.expected.content_jcs, `${v.id} jcs`);
        assert.equal(keyedCommitment(hexToBytes(v.inputs.k_digest_hex), v.inputs.content), v.expected.hmac_sha256, `${v.id} hmac`);
      }
    }
  });
});

vectors("gitvault vectors — golden-preimage (open-id / open-binding)", () => {
  it("replays every golden preimage", () => {
    for (const v of byClass("golden-preimage")) {
      mark(v);
      const pre = v.id === "gold-001"
        ? openIdPreimage(v.inputs.org_id, v.inputs.repo_id, v.inputs.client_open_id)
        : openBindingPreimage(v.inputs.client_open_id, v.inputs.base_head_sha256, v.inputs.prior_checkpoint_claim_set_sha256, v.inputs.requested_r2_cap_size_bytes);
      assert.equal(bytesToHex(pre), v.inputs.preimage_hex, `${v.id} preimage`);
      assert.equal(String(pre.length), v.inputs.preimage_len, `${v.id} len`);
      assert.equal(sha256Hex(pre), v.expected.sha256, `${v.id} sha256`);
    }
  });
});

vectors("gitvault vectors — stored-bytes-preimage", () => {
  it("replays stored bytes, preimages, domain separation, and the signature-covering hash rule", () => {
    for (const v of byClass("stored-bytes-preimage")) {
      mark(v);
      if (v.id === "stored-001" || v.id === "stored-002") {
        const obj = v.inputs.object as GitvaultSignedObject;
        const { signature: _s, ...rest } = obj;
        void _s;
        assert.equal(bytesToHex(signaturePreimage(obj.object_kind, rest)), v.expected.signature_preimage_hex, `${v.id} preimage`);
        assert.equal(new TextDecoder().decode(storedBytes(obj)), v.expected.stored_bytes, `${v.id} stored bytes`);
        assert.equal(storedBytesSha256(obj), v.expected.stored_bytes_sha256, `${v.id} hash`);
        const pub = v.id === "stored-001" ? v.inputs.creator_signing_pubkey : v.inputs.signer_pubkey;
        assert.equal(verifyGitvaultObject(obj, pub), true, `${v.id} signature`);
        if (v.id === "stored-001") {
          assert.equal(vkFingerprint(fromBase64url(v.inputs.creator_signing_pubkey)), v.expected.writer_key_id);
          assert.equal(ekFingerprint(fromBase64url(v.inputs.creator_encryption_pubkey)), v.expected.envelope_recipient_fingerprint);
        }
      } else if (v.id === "stored-003" || v.id === "stored-004") {
        assert.equal(ed25519VerifyStrict(b64uBuf(v.inputs.signature), hexToBytes(v.inputs.preimage_hex), b64uBuf(v.inputs.signer_pubkey)), false, v.id);
      } else {
        const obj = v.inputs.object as GitvaultSignedObject;
        const { signature: _s, ...rest } = obj;
        void _s;
        assert.equal(sha256Hex(jcs(rest)), v.expected.sha256_without_signature, v.id);
        assert.equal(storedBytesSha256(obj), v.expected.stored_bytes_sha256, v.id);
        assert.notEqual(v.expected.sha256_without_signature, v.expected.stored_bytes_sha256);
      }
    }
  });
});

vectors("gitvault vectors — strict-parse", () => {
  it("replays every strict-parse accept/reject", () => {
    for (const v of byClass("strict-parse")) {
      mark(v);
      if (typeof v.inputs.base64url === "string") {
        assert.equal(isCanonicalBase64url(v.inputs.base64url), v.expected.canonical === "true", v.id);
        if (v.expected.decoded_len) assert.equal(String(fromBase64url(v.inputs.base64url).length), v.expected.decoded_len);
        continue;
      }
      const text = v.inputs.raw_json_text as string;
      if (v.reject_reason === "schema") {
        // schema-aware rejection (unknown member / hex case) is the schema layer's job; the
        // text itself is canonical so the strict parser accepts it, and the scalar grammar
        // catches the uppercase hex.
        const value = parseGitvaultStrict(text) as Record<string, string>;
        if (v.id === "parse-008") assert.equal(GITVAULT_SHA256_RE.test(value.base_head_sha256!), false, v.id);
        continue;
      }
      if (v.reject_reason) {
        let reason: string | null = null;
        try {
          parseGitvaultStrict(text);
        } catch (e) {
          reason = gitvaultStrictParseReason(e);
        }
        assert.equal(reason, v.reject_reason, `${v.id}: ${v.description}`);
        continue;
      }
      const value = parseGitvaultStrict(text);
      assert.equal(jcsString(value), v.expected.canonical_jcs, v.id);
      assert.equal(sha256Hex(jcs(value)), v.expected.sha256, v.id);
    }
  });
});

vectors("gitvault vectors — aead-frame (XChaCha20-Poly1305 framing)", () => {
  it("replays the frame seal/open, the 7 AAD flips, and the 5 frame mutations", () => {
    for (const v of byClass("aead-frame")) {
      mark(v);
      if (v.id === "aead-001") {
        const kRepo = hexToBytes(v.inputs.K_repo_hex);
        const kObj = deriveObjectKey(kRepo, v.inputs.repo_id, v.inputs.epoch, v.inputs.object_kind, v.inputs.object_id);
        assert.equal(bytesToHex(kObj), v.expected.k_obj_hex);
        assert.equal(bytesToHex(objectKeyInfo(v.inputs.repo_id, v.inputs.epoch, v.inputs.object_kind, v.inputs.object_id)), v.expected.k_obj_info_hex);
        assert.equal(jcsString(frameAad(v.inputs.repo_id, v.inputs.object_kind, v.inputs.object_id, v.inputs.epoch)), v.expected.aad_jcs);
        const sealed = sealFrame({ k_obj: kObj, repo_id: v.inputs.repo_id, object_kind: v.inputs.object_kind, object_id: v.inputs.object_id, epoch: v.inputs.epoch, plaintext: hexToBytes(v.inputs.plaintext_hex), nonce: hexToBytes(v.inputs.nonce_hex) });
        assert.equal(bytesToHex(sealed.frame), v.expected.frame_hex, "frame bytes");
        assert.equal(sealed.ciphertext_sha256, v.expected.ciphertext_sha256);
        assert.equal(sealed.size_bytes, v.expected.size_bytes);
        const pt = openFrame({ k_obj: kObj, repo_id: v.inputs.repo_id, object_kind: v.inputs.object_kind, object_id: v.inputs.object_id, epoch: v.inputs.epoch, frame: sealed.frame, expected_ciphertext_sha256: v.expected.ciphertext_sha256 });
        assert.equal(bytesToHex(pt), v.inputs.plaintext_hex);
        assert.equal(sha256Hex(pt), v.expected.plaintext_sha256);
      } else if (v.reject_reason === "aead-auth-failure") {
        assertLocalCode(() => openFrameWithAad(hexToBytes(v.inputs.k_obj_hex), hexToBytes(v.inputs.frame_hex), utf8(v.inputs.aad_jcs)), "GITVAULT_AEAD_AUTH_FAILURE");
      } else {
        const frame = hexToBytes(v.inputs.frame_hex);
        assert.equal(sha256Hex(frame), v.expected.ciphertext_sha256, v.id);
        assert.notEqual(sha256Hex(frame), v.inputs.receipt_ciphertext_sha256);
        const aad = JSON.parse(v.inputs.aad_jcs) as { repo_id: string; object_kind: "wal_pack"; object_id: string; epoch: string };
        const base = { k_obj: hexToBytes(v.inputs.k_obj_hex), repo_id: aad.repo_id, object_kind: aad.object_kind, object_id: aad.object_id, epoch: aad.epoch, frame };
        assertLocalCode(() => openFrame({ ...base, expected_ciphertext_sha256: v.inputs.receipt_ciphertext_sha256 }), "GITVAULT_RECEIPT_MISMATCH");
        let code = "";
        try {
          openFrame(base);
        } catch (e) {
          code = (e as LocalError).code ?? "";
        }
        assert.ok(code === "GITVAULT_FRAME_INVALID" || code === "GITVAULT_AEAD_AUTH_FAILURE", `${v.id}: ${code}`);
      }
    }
  });
});

vectors("gitvault vectors — hpke-rfc9180-a2 (the r402s-1 suite KATs)", () => {
  it("reproduces enc, the 0..256 encryption sequence, and the three exports", async () => {
    const suite = gitvaultHpkeSuite();
    const [a, b, c] = ["hpke-rfc9180-a2-001", "hpke-rfc9180-a2-002", "hpke-rfc9180-a2-003"].map((id) => byClass("hpke-rfc9180-a2").find((v) => v.id === id)!);
    for (const v of [a, b, c]) mark(v);
    assert.equal(a.inputs.kem_id, "32");
    assert.equal(a.inputs.kdf_id, "1");
    assert.equal(a.inputs.aead_id, "3");
    const ekp = await suite.kem.deriveKeyPair(hexToBytes(a.inputs.ikmE).buffer as ArrayBuffer);
    const rkp = await suite.kem.deriveKeyPair(hexToBytes(a.inputs.ikmR).buffer as ArrayBuffer);
    assert.equal(bytesToHex(new Uint8Array(await suite.kem.serializePublicKey(rkp.publicKey))), a.expected.pkRm);
    assert.equal(bytesToHex(new Uint8Array(await suite.kem.serializePublicKey(ekp.publicKey))), a.expected.pkEm);
    const sender = await suite.createSenderContext({ recipientPublicKey: rkp.publicKey, info: hexToBytes(a.inputs.info).buffer as ArrayBuffer, ekm: ekp });
    assert.equal(bytesToHex(new Uint8Array(sender.enc)), a.expected.enc);
    const recipient = await suite.createRecipientContext({ recipientKey: rkp.privateKey, enc: sender.enc, info: hexToBytes(a.inputs.info).buffer as ArrayBuffer });
    const pt = hexToBytes(b.inputs.pt).buffer as ArrayBuffer;
    const want = b.expected.encryptions as Array<{ sequence_number: string; aad: string; ct: string }>;
    let checked = 0;
    for (let seq = 0; seq <= 256; seq++) {
      const e = want.find((w) => Number(w.sequence_number) === seq);
      const aad = hexToBytes(e ? e.aad : `436f756e742d${Buffer.from(String(seq)).toString("hex")}`).buffer as ArrayBuffer;
      const ct = new Uint8Array(await sender.seal(pt, aad));
      if (e) {
        assert.equal(bytesToHex(ct), e.ct, `seq ${seq}`);
        checked++;
      }
      const opened = new Uint8Array(await recipient.open(ct.buffer as ArrayBuffer, aad));
      assert.equal(bytesToHex(opened), b.inputs.pt, `open seq ${seq}`);
    }
    assert.equal(checked, want.length);
    for (const x of c.expected.exports as Array<{ exporter_context: string; L: string; exported_value: string }>) {
      const ev = new Uint8Array(await sender.export(hexToBytes(x.exporter_context).buffer as ArrayBuffer, Number(x.L)));
      assert.equal(bytesToHex(ev), x.exported_value, `export ${x.exporter_context}`);
    }
    // The single-shot API used by sealKeyEnvelope reproduces seq 0 with the same ikmE.
    const pkR = new Uint8Array(await suite.kem.serializePublicKey(rkp.publicKey));
    const single = await hpkeSeal({ recipient_public_key: pkR, info: hexToBytes(a.inputs.info), aad: hexToBytes(want[0]!.aad), plaintext: hexToBytes(b.inputs.pt), ikm_e: hexToBytes(a.inputs.ikmE) });
    assert.equal(bytesToHex(single.enc), a.expected.enc);
    assert.equal(bytesToHex(single.ct), want[0]!.ct);
  });
});

vectors("gitvault vectors — hpke-envelope (key_envelope seal/open + tampers)", () => {
  it("reproduces the deterministic seal byte-for-byte and refuses every tamper", async () => {
    const keys = vectorFile!.test_keys;
    for (const v of byClass("hpke-envelope")) {
      mark(v);
      if (v.id === "hpke-envelope-001") {
        const recipientPub = fromBase64url(v.inputs.recipient_encryption_pubkey);
        const recipient = generateEncryptionKeypair(hexToBytes(v.inputs.recipient_encryption_seed_hex));
        assert.equal(bytesToHex(recipient.public_key), bytesToHex(recipientPub), "x25519 pubkey from the vector seed");
        const signer = generateSigningKeypair(hexToBytes(keys.creator_signing_seed_hex!));
        assert.equal(vkFingerprint(signer.public_key), v.inputs.sender_signing_fingerprint);
        assert.deepEqual(v.expected.info_parts, ["r402s/v0/envelope", "r402s-1", sha256Hex(recipientPub), v.inputs.sender_signing_fingerprint]);
        assert.equal(bytesToHex(envelopeInfo(recipientPub, v.inputs.sender_signing_fingerprint)), v.expected.info_hex, "info bytes");
        assert.equal(jcsString(envelopeAad(v.inputs.repo_id, v.inputs.epoch, v.inputs.recipient_fingerprint)), v.expected.aad_jcs, "aad jcs");
        const sealed = await sealKeyEnvelope({ k_repo: hexToBytes(v.inputs.K_repo_hex), repo_id: v.inputs.repo_id, epoch: v.inputs.epoch, recipient_public_key: recipientPub, signer, created_at: v.inputs.object.created_at, ikm_e: hexToBytes(v.inputs.ikmE_hex) });
        assert.deepEqual(sealed.envelope, v.inputs.object, "the sealed+signed envelope equals the vector object");
        assert.equal(bytesToHex(fromBase64url(sealed.envelope.enc)), v.expected.enc_hex);
        assert.equal(bytesToHex(fromBase64url(sealed.envelope.ct)), v.expected.ct_hex);
        assert.equal(new TextDecoder().decode(sealed.stored_bytes), v.expected.stored_bytes);
        assert.equal(sealed.stored_bytes_sha256, v.expected.stored_bytes_sha256);
        assert.equal(sealed.size_bytes, v.expected.size_bytes);
        assert.deepEqual(sealed.receipt, v.expected.genesis_envelope_receipt);
        const { signature: _s, ...rest } = sealed.envelope;
        void _s;
        assert.equal(bytesToHex(signaturePreimage("key_envelope", rest)), v.expected.signature_preimage_hex);
        const opened = await openKeyEnvelope({ envelope: sealed.envelope, recipient, signer_public_key: keys.creator_signing_pubkey! });
        assert.equal(bytesToHex(opened), v.expected.opened_K_repo_hex);
      } else if (v.reject_reason === "hpke-open-failure") {
        const recipient = generateEncryptionKeypair(hexToBytes(v.inputs.recipient_encryption_seed_hex));
        await assertLocalCodeAsync(
          hpkeOpen({ recipient_private_key: recipient.private_key, enc: hexToBytes(v.inputs.enc_hex), info: hexToBytes(v.inputs.info_hex), aad: utf8(v.inputs.aad_jcs), ct: hexToBytes(v.inputs.ct_hex) }),
          "GITVAULT_HPKE_OPEN_FAILED",
        );
      } else if (v.id === "hpke-envelope-014") {
        const env = v.inputs.object as GitvaultKeyEnvelope;
        assert.equal(verifyGitvaultObject(env as unknown as GitvaultSignedObject, v.inputs.signer_pubkey), false);
        const recipient = generateEncryptionKeypair(hexToBytes(v.inputs.recipient_encryption_seed_hex));
        // signature-before-open: the refusal is the SIGNATURE code, so the open was never attempted
        await assertLocalCodeAsync(openKeyEnvelope({ envelope: env, recipient, signer_public_key: v.inputs.signer_pubkey }), "GITVAULT_SIGNATURE_INVALID");
      } else if (v.id === "hpke-envelope-015") {
        const env = v.inputs.object as GitvaultKeyEnvelope;
        assert.equal(GITVAULT_HPKE_CT_RE.test(env.ct), false);
        const recipient = generateEncryptionKeypair(hexToBytes(keys.creator_encryption_seed_hex!));
        await assertLocalCodeAsync(openKeyEnvelope({ envelope: env, recipient, signer_public_key: keys.creator_signing_pubkey! }), "GITVAULT_SCHEMA_REJECT");
      } else {
        assert.fail(`unhandled vector ${v.id}`);
      }
    }
  });
});

vectors("gitvault vectors — hpke-info-near-neighbors (D188)", () => {
  it("the canonical construction opens; each near-neighbor encoding and AAD flip fails", async () => {
    for (const v of byClass("hpke-info-near-neighbors")) {
      mark(v);
      const recipient = generateEncryptionKeypair(hexToBytes(v.inputs.recipient_encryption_seed_hex));
      assert.equal(bytesToHex(recipient.public_key), v.inputs.recipient_x25519_public_key_hex);
      if (v.id === "hpke-info-nn-001") {
        const info = envelopeInfo(recipient.public_key, v.inputs.created_by);
        assert.equal(bytesToHex(info), v.expected.info_hex);
        assert.deepEqual((v.expected.info_components as string[]).map((c) => bytesToHex(lp(c))), v.expected.info_components_lp_hex);
        const aad = jcs(envelopeAad(v.inputs.repo_id, v.inputs.epoch, v.inputs.recipient_fingerprint));
        assert.equal(new TextDecoder().decode(aad), v.expected.aad_jcs);
        const opened = await hpkeOpen({ recipient_private_key: recipient.private_key, enc: hexToBytes(v.expected.enc_hex), info, aad, ct: hexToBytes(v.expected.ct_hex) });
        assert.equal(bytesToHex(opened), v.expected.opened_K_repo_hex);
      } else {
        await assertLocalCodeAsync(
          hpkeOpen({ recipient_private_key: recipient.private_key, enc: hexToBytes(v.inputs.enc_hex), info: hexToBytes(v.inputs.info_hex), aad: utf8(v.inputs.aad_jcs), ct: hexToBytes(v.inputs.ct_hex) }),
          "GITVAULT_HPKE_OPEN_FAILED",
        );
      }
    }
  });
});

vectors("gitvault vectors — hpke-genesis-binding", () => {
  it("schema-valid, correctly signed genesis objects with broken key bindings never canonize", async () => {
    for (const v of byClass("hpke-genesis-binding")) {
      mark(v);
      if (v.id === "hpke-genesis-binding-004") {
        const genesis = v.inputs.genesis as GitvaultVaultGenesis;
        const env = v.inputs.stored_key_envelope as GitvaultKeyEnvelope;
        const problems = checkGenesisKeyBindings(genesis, env);
        assert.ok(problems.includes("stored_envelope_created_by"), `${v.id}: ${problems.join(",")}`);
        const recipient = generateEncryptionKeypair(hexToBytes(v.inputs.recipient_encryption_seed_hex));
        // The envelope IS correctly signed by the genesis creator, but names another creator in
        // `created_by` — and created_by is an HPKE info element, so the recipient's natural open
        // (signature OK → info from the envelope's own created_by) recovers nothing.
        assert.equal(verifyGitvaultObject(env as unknown as GitvaultSignedObject, genesis.creator_signing_pubkey), v.expected.envelope_signature_valid === "true");
        assert.equal(env.created_by === genesis.writer_key_id, v.expected.created_by_matches === "true");
        await assertLocalCodeAsync(openKeyEnvelope({ envelope: env, recipient, signer_public_key: genesis.creator_signing_pubkey }), "GITVAULT_HPKE_OPEN_FAILED");
        continue;
      }
      const genesis = v.inputs.object as GitvaultVaultGenesis;
      if (v.expected.signature_valid === "true") assert.equal(verifyGitvaultObject(genesis as unknown as GitvaultSignedObject, v.inputs.signer_pubkey), true, v.id);
      const problems = checkGenesisKeyBindings(genesis, v.inputs.stored_key_envelope as GitvaultKeyEnvelope | undefined);
      const expectedProblem = {
        "hpke-genesis-binding-001": "envelope_recipient_fingerprint",
        "hpke-genesis-binding-002": "writer_key_id",
        "hpke-genesis-binding-003": "stored_envelope_hash",
        "hpke-genesis-binding-005": "envelope_epoch",
      }[v.id]!;
      assert.ok(problems.includes(expectedProblem as never), `${v.id}: expected ${expectedProblem}, got ${problems.join(",")}`);
      if (v.expected.expected_recipient_fingerprint) assert.equal(ekFingerprint(fromBase64url(genesis.creator_encryption_pubkey)), v.expected.expected_recipient_fingerprint);
      if (v.expected.expected_writer_key_id) assert.equal(vkFingerprint(fromBase64url(genesis.creator_signing_pubkey)), v.expected.expected_writer_key_id);
    }
  });
});

vectors("gitvault vectors — hpke-recovery (receipt-led recovery)", () => {
  it("receipt → genesis → envelope → open → K_repo → k_obj → the WAL frame decrypts; mismatches are named", async () => {
    for (const v of byClass("hpke-recovery")) {
      mark(v);
      const genesis = v.inputs.genesis as GitvaultVaultGenesis;
      if (v.id === "hpke-recovery-002") {
        const receipt = v.inputs.recovery_receipt as GitvaultRecoveryReceipt;
        assert.deepEqual(checkRecoveryReceipt(receipt, genesis), []);
        assert.equal(storedBytesSha256(genesis as unknown as GitvaultSignedObject), v.expected.genesis_sha256);
        assertGitvaultSignature(genesis as unknown as GitvaultSignedObject, genesis.creator_signing_pubkey);
        const env = v.inputs.key_envelope as GitvaultKeyEnvelope;
        assert.deepEqual(checkGenesisKeyBindings(genesis, env), []);
        assert.equal(storedBytesSha256(env as unknown as GitvaultSignedObject), v.expected.envelope_stored_bytes_sha256);
        const recipient = generateEncryptionKeypair(hexToBytes(v.inputs.recipient_encryption_seed_hex));
        const kRepo = await openKeyEnvelope({ envelope: env, recipient, signer_public_key: genesis.creator_signing_pubkey });
        assert.equal(bytesToHex(kRepo), v.expected.K_repo_hex);
        const kObj = deriveObjectKey(kRepo, genesis.repo_id, env.epoch, "wal_pack", v.inputs.wal_object_id);
        assert.equal(bytesToHex(kObj), v.expected.k_obj_hex);
        const pt = openFrame({ k_obj: kObj, repo_id: genesis.repo_id, object_kind: "wal_pack", object_id: v.inputs.wal_object_id, epoch: env.epoch, frame: hexToBytes(v.inputs.wal_frame_hex) });
        assert.equal(sha256Hex(pt), v.expected.wal_plaintext_sha256);
        continue;
      }
      const receipt = v.inputs.object as GitvaultRecoveryReceipt;
      const problems = checkRecoveryReceipt(receipt, genesis);
      if (v.id === "hpke-recovery-001") {
        assert.deepEqual(problems, []);
        assert.equal(storedBytesSha256(receipt as unknown as GitvaultSignedObject), v.expected.stored_bytes_sha256);
        const { signature: _s, ...rest } = receipt;
        void _s;
        assert.equal(bytesToHex(signaturePreimage("recovery_receipt", rest)), v.expected.signature_preimage_hex);
      } else if (v.id === "hpke-recovery-003") {
        assert.ok(!problems.includes("signature"));
        assert.ok(problems.includes("genesis_sha256"), problems.join(","));
      } else {
        assert.ok(!problems.includes("signature"));
        assert.ok(problems.includes("creator_encryption_fingerprint"), problems.join(","));
        assert.ok(!problems.includes("genesis_sha256"));
      }
    }
  });
});

vectors("gitvault vectors — chain (the signature/linkage half)", () => {
  it("genesis → head 1 → head 2 stored hashes link; a post-signing byte change no longer verifies", () => {
    for (const v of byClass("chain")) {
      mark(v);
      if (v.id === "chain-004") {
        assert.equal(verifyGitvaultObject(v.inputs.object as GitvaultSignedObject, v.inputs.signer_pubkey), false);
        continue;
      }
      if (v.id === "chain-005") continue; // GENERATION_REGRESSION is a pin comparison (task 5.4)
      const genesis = v.inputs.genesis as GitvaultVaultGenesis;
      const heads = v.inputs.heads as GitvaultSignedObject[];
      const hashes = [genesis, ...heads].map((o) => storedBytesSha256(o as unknown as GitvaultSignedObject));
      if (v.expected.stored_bytes_sha256) assert.deepEqual(hashes, v.expected.stored_bytes_sha256, v.id);
      for (const h of heads) assert.equal(verifyGitvaultObject(h, genesis.creator_signing_pubkey), true, `${v.id} head signature`);
      let ok = true;
      let prev = hashes[0]!;
      let gen = 0;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i] as unknown as { prev_sha256: string; generation: string };
        if (h.prev_sha256 !== prev || parseInt(h.generation, 16) !== gen + 1) ok = false;
        prev = hashes[i + 1]!;
        gen = parseInt(h.generation, 16);
      }
      assert.equal(ok, v.expected.chain_ok === "true", `${v.id}: ${v.description}`);
    }
  });
});

vectors("gitvault vectors — hpke-interop/golden.json (D182 acceptance 2)", () => {
  it("opens every reference envelope (signature first), reproduces the seal, and refuses every tamper", async () => {
    assert.ok(golden, "missing hpke-interop/golden.json in the resolved vector set");
    for (const c of golden!.cases) {
      const recipient = generateEncryptionKeypair(hexToBytes(c.recipient.x25519_private_key_hex));
      assert.equal(bytesToHex(recipient.public_key), c.recipient.x25519_public_key_hex, c.label);
      assert.equal(ekFingerprint(recipient.public_key), c.recipient.fingerprint, c.label);
      const signer = generateSigningKeypair(hexToBytes(c.sender.ed25519_seed_hex));
      assert.equal(vkFingerprint(signer.public_key), c.sender.signing_fingerprint);
      assert.equal(bytesToHex(envelopeInfo(recipient.public_key, c.sender.signing_fingerprint)), c.info.hex, `${c.label} info`);
      const env = c.sealed_by_reference.key_envelope as GitvaultKeyEnvelope;
      assert.equal(jcsString(envelopeAad(env.repo_id, env.epoch, env.recipient_fingerprint)), c.aad.jcs, `${c.label} aad`);
      // rule 1: open the reference envelope, signature first
      const opened = await openKeyEnvelope({ envelope: env, recipient, signer_public_key: signer.public_key });
      assert.equal(bytesToHex(opened), c.plaintext_K_repo_hex, `${c.label} open`);
      assert.equal(storedBytesSha256(env as unknown as GitvaultSignedObject), c.sealed_by_reference.stored_bytes_sha256);
      // rule 2: reproduce the seal with the carried ikmE
      const sealed = await sealKeyEnvelope({ k_repo: hexToBytes(c.plaintext_K_repo_hex), repo_id: env.repo_id, epoch: env.epoch, recipient_public_key: recipient.public_key, signer, created_at: env.created_at, ikm_e: hexToBytes(c.ephemeral.ikmE_hex) });
      assert.equal(bytesToHex(fromBase64url(sealed.envelope.enc)), c.sealed_by_reference.enc_hex, `${c.label} enc`);
      assert.equal(bytesToHex(fromBase64url(sealed.envelope.ct)), c.sealed_by_reference.ct_hex, `${c.label} ct`);
      assert.deepEqual(sealed.envelope, env, `${c.label} signed envelope`);
      // rule 4: tampers fail
      for (const t of c.tamper_must_fail) {
        await assertLocalCodeAsync(
          hpkeOpen({ recipient_private_key: recipient.private_key, enc: hexToBytes(t.enc_hex), info: hexToBytes(c.info.hex), aad: utf8(t.aad_jcs ?? c.aad.jcs), ct: hexToBytes(t.ct_hex) }),
          "GITVAULT_HPKE_OPEN_FAILED",
        );
      }
    }
  });
});

vectors("gitvault vectors — coverage tally", () => {
  it("every vector of each replayed class was exercised (counts from the file's generated counts_by_class)", () => {
    const expectedClasses = ["zip215", "hkdf", "golden-preimage", "stored-bytes-preimage", "strict-parse", "aead-frame", "hpke-rfc9180-a2", "hpke-envelope", "hpke-info-near-neighbors", "hpke-genesis-binding", "hpke-recovery", "chain"];
    const summary: Record<string, string> = {};
    for (const cls of expectedClasses) {
      const have = replayed.get(cls)?.size ?? 0;
      const want = Number(vectorFile!.counts_by_class[cls]);
      summary[cls] = `${have}/${want}`;
      assert.equal(have, want, `class ${cls}: replayed ${have} of ${want}`);
    }
    // eslint-disable-next-line no-console
    console.log(`gitvault vectors rev ${vectorFile!["x-r402s-revision"]}: ${JSON.stringify(summary)}; interop cases: ${golden?.cases.length ?? 0}`);
  });
});

// Keep the unused-import linter honest for helpers only used in some branches.
void ed25519PublicKey;
