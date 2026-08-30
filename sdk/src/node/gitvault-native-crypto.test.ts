/**
 * BYTE-EQUALITY between the two frame-AEAD backends
 * (gitvault-native-bulk-crypto, design D5 — the acceptance bar).
 *
 * Two implementations of one primitive in the same process is real surface,
 * and the one unacceptable outcome is a wire format that forks by runtime. So
 * this suite exists to make that impossible to ship quietly: the FROZEN frame
 * vectors must replay byte-identical under both backends, a frame sealed by
 * either must open under the other, and every tamper must fail with the SAME
 * `GITVAULT_AEAD_AUTH_FAILURE` envelope.
 *
 * The tests register and unregister explicitly rather than relying on whatever
 * the Node entry installed, so each assertion names the backend it is about.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { randomBytes } from "node:crypto";

import {
  _gitvaultAeadBackend,
  _setGitvaultAeadBackend,
  deriveObjectKey,
  frameAad,
  openFrame,
  openFrameWithAad,
  sealFrame,
} from "../namespaces/gitvault.crypto.js";
import { installNodeGitvaultAeadBackend, nodeGitvaultAeadBackend } from "./gitvault-native-crypto.js";
import { loadGitvaultVectors, OPTOUT_SKIP_MESSAGE, type GitvaultVector } from "./gitvault-vectors.test-helper.js";
import { LocalError } from "../errors.js";

const vectorSet = loadGitvaultVectors();
const aeadVectors: GitvaultVector[] = (vectorSet?.file.vectors ?? []).filter((v) => v.class === "aead-frame");

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function assertLocalCode(fn: () => unknown, code: string, what: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof LocalError, `${what}: expected LocalError, got ${String(e)}`);
    assert.equal(e.code, code, `${what}: expected ${code}, got ${e.code}`);
    return;
  }
  throw new Error(`${what}: expected ${code}, but the call returned`);
}

/** Run `fn` with the native backend installed, always restoring the default. */
function withNative(fn: () => void): void {
  _setGitvaultAeadBackend(nodeGitvaultAeadBackend);
  try {
    fn();
  } finally {
    _setGitvaultAeadBackend(null);
  }
}

describe("gitvault native bulk crypto — registration (design D4)", () => {
  after(() => _setGitvaultAeadBackend(null));

  it("installs on a build whose OpenSSL carries the cipher, and is a no-op otherwise", () => {
    _setGitvaultAeadBackend(null);
    const installed = installNodeGitvaultAeadBackend();
    // Either outcome is CORRECT — the native path is an optimization, never a
    // correctness dependency. What must hold is that the slot agrees with the
    // verdict: a `true` that left the default in place (or a `false` that
    // installed anyway) would be the dangerous shape.
    assert.equal(_gitvaultAeadBackend() !== null, installed);
    _setGitvaultAeadBackend(null);
    assert.equal(_gitvaultAeadBackend(), null, "installing null must restore the @noble default");
  });

  it("the ISOMORPHIC entry registers nothing — only sdk/src/node may install (D3/3.4)", async () => {
    _setGitvaultAeadBackend(null);
    await import("../index.js");
    assert.equal(_gitvaultAeadBackend(), null, "the isomorphic entry must never register a backend");
    // Scope note, so this test is not read as more than it is: the independent
    // verifier lineage the spec names (`r402s-verify`) is a RUST crate, so its
    // separation from this backend is structural — a different language, not
    // merely an unregistered slot, and nothing a JS test can assert. What IS
    // assertable here, and what actually matters, is that the isomorphic entry
    // stays pure `@noble`: every non-Node runtime, and any second JS consumer
    // of the core, gets the default path with no registration to opt out of.
  });
});

describe("gitvault native bulk crypto — the frozen frame vectors replay identically (3.1, D5)", { skip: vectorSet ? false : OPTOUT_SKIP_MESSAGE }, () => {
  before(() => _setGitvaultAeadBackend(null));
  after(() => _setGitvaultAeadBackend(null));

  it("seals every aead-frame vector to the SAME bytes under both backends", () => {
    const seed = aeadVectors.find((v) => v.id === "aead-001");
    assert.ok(seed, "the aead-001 seal vector must be present");
    const kRepo = hexToBytes(seed.inputs.K_repo_hex as string);
    const kObj = deriveObjectKey(kRepo, seed.inputs.repo_id, seed.inputs.epoch, seed.inputs.object_kind, seed.inputs.object_id);
    const seal = (): { frameHex: string; sha: string; plaintextHex: string } => {
      const sealed = sealFrame({
        k_obj: kObj,
        repo_id: seed.inputs.repo_id,
        object_kind: seed.inputs.object_kind,
        object_id: seed.inputs.object_id,
        epoch: seed.inputs.epoch,
        plaintext: hexToBytes(seed.inputs.plaintext_hex as string),
        nonce: hexToBytes(seed.inputs.nonce_hex as string),
      });
      const opened = openFrame({
        k_obj: kObj,
        repo_id: seed.inputs.repo_id,
        object_kind: seed.inputs.object_kind,
        object_id: seed.inputs.object_id,
        epoch: seed.inputs.epoch,
        frame: sealed.frame,
        expected_ciphertext_sha256: seed.expected.ciphertext_sha256 as string,
      });
      return { frameHex: bytesToHex(sealed.frame), sha: sealed.ciphertext_sha256, plaintextHex: bytesToHex(opened) };
    };

    const withNoble = seal();
    let native: ReturnType<typeof seal>;
    withNative(() => {
      native = seal();
    });

    // The frozen vector itself is the third party: both backends must match
    // the recorded bytes, not merely each other.
    assert.equal(withNoble.frameHex, seed.expected.frame_hex, "@noble backend vs the frozen vector");
    assert.equal(native!.frameHex, seed.expected.frame_hex, "native backend vs the frozen vector");
    assert.deepEqual(native!, withNoble, "the two backends must agree on frame, digest, and plaintext");
  });

  it("refuses every auth-failure vector identically under both backends", () => {
    const failures = aeadVectors.filter((v) => v.reject_reason === "aead-auth-failure");
    assert.ok(failures.length > 0, "the vector set must carry auth-failure cases");
    for (const v of failures) {
      const replay = (): void =>
        assertLocalCode(
          () => openFrameWithAad(hexToBytes(v.inputs.k_obj_hex as string), hexToBytes(v.inputs.frame_hex as string), utf8(v.inputs.aad_jcs as string)),
          "GITVAULT_AEAD_AUTH_FAILURE",
          v.id,
        );
      replay();
      withNative(replay);
    }
  });
});

describe("gitvault native bulk crypto — cross-backend interoperation (3.2, D5)", () => {
  after(() => _setGitvaultAeadBackend(null));

  // Sizes spanning empty, sub-block, block boundaries, and a multi-megabyte
  // frame (the shape the checkpoint pack actually takes).
  const SIZES = [0, 1, 15, 16, 17, 63, 64, 65, 1023, 65_536, 3 * 1024 * 1024];
  const base = {
    repo_id: "src_" + "a".repeat(32),
    object_kind: "wal_pack" as const,
    object_id: "obj_cross_backend",
    epoch: "0".repeat(32),
  };

  for (const size of SIZES) {
    it(`round-trips a ${size}-byte frame in both directions`, () => {
      const kObj = new Uint8Array(randomBytes(32));
      const plaintext = new Uint8Array(randomBytes(size));
      const nonce = new Uint8Array(randomBytes(24));

      _setGitvaultAeadBackend(null);
      const nobleSealed = sealFrame({ ...base, k_obj: kObj, plaintext, nonce });
      let nativeSealed!: ReturnType<typeof sealFrame>;
      withNative(() => {
        nativeSealed = sealFrame({ ...base, k_obj: kObj, plaintext, nonce });
      });

      // Same nonce, same key, same AAD ⇒ the bytes must be IDENTICAL, not
      // merely mutually openable. Anything less forks the wire format.
      assert.deepEqual(nativeSealed.frame, nobleSealed.frame, "sealed frames must be byte-identical");
      assert.equal(nativeSealed.ciphertext_sha256, nobleSealed.ciphertext_sha256);

      // seal @noble → open native
      withNative(() => {
        assert.deepEqual(openFrame({ ...base, k_obj: kObj, frame: nobleSealed.frame }), plaintext);
      });
      // seal native → open @noble
      _setGitvaultAeadBackend(null);
      assert.deepEqual(openFrame({ ...base, k_obj: kObj, frame: nativeSealed.frame }), plaintext);
    });
  }
});

describe("gitvault native bulk crypto — tampering fails identically (3.3, D4)", () => {
  after(() => _setGitvaultAeadBackend(null));

  const base = {
    repo_id: "src_" + "b".repeat(32),
    object_kind: "wal_pack" as const,
    object_id: "obj_tamper",
    epoch: "1".repeat(32),
  };

  it("a flipped ciphertext byte, tag byte, or AAD member is GITVAULT_AEAD_AUTH_FAILURE under either backend", () => {
    const kObj = new Uint8Array(randomBytes(32));
    const plaintext = new Uint8Array(randomBytes(4096));
    _setGitvaultAeadBackend(null);
    const sealed = sealFrame({ ...base, k_obj: kObj, plaintext });
    const aad = new TextEncoder().encode(JSON.stringify(frameAad(base.repo_id, base.object_kind, base.object_id, base.epoch)));

    const flipped = (index: number): Uint8Array => {
      const copy = Uint8Array.from(sealed.frame);
      copy[index] = copy[index]! ^ 0x01;
      return copy;
    };
    // 7-byte header (magic + suite) then a 24-byte nonce: the first ciphertext
    // byte is at 31, and the tag is the last 16.
    const ciphertextByte = flipped(31);
    const tagByte = flipped(sealed.frame.length - 1);
    const tamperedAad = Uint8Array.from(aad);
    tamperedAad[10] = tamperedAad[10]! ^ 0x01;

    for (const [label, run] of [
      ["ciphertext", () => openFrame({ ...base, k_obj: kObj, frame: ciphertextByte })],
      ["tag", () => openFrame({ ...base, k_obj: kObj, frame: tagByte })],
      ["aad", () => openFrameWithAad(kObj, sealed.frame, tamperedAad)],
      ["key", () => openFrame({ ...base, k_obj: new Uint8Array(randomBytes(32)), frame: sealed.frame })],
    ] as const) {
      _setGitvaultAeadBackend(null);
      assertLocalCode(run, "GITVAULT_AEAD_AUTH_FAILURE", `@noble/${label}`);
      withNative(() => assertLocalCode(run, "GITVAULT_AEAD_AUTH_FAILURE", `native/${label}`));
    }
  });

  it("a truncated frame is refused, never opened, under the native backend", () => {
    const kObj = new Uint8Array(randomBytes(32));
    _setGitvaultAeadBackend(null);
    const sealed = sealFrame({ ...base, k_obj: kObj, plaintext: new Uint8Array(randomBytes(64)) });
    // Cut into the tag: shorter than header+tag is a FRAME_INVALID header
    // refusal, so take one byte off instead — that reaches the AEAD.
    const truncated = sealed.frame.subarray(0, sealed.frame.length - 1);
    withNative(() => assertLocalCode(() => openFrame({ ...base, k_obj: kObj, frame: truncated }), "GITVAULT_AEAD_AUTH_FAILURE", "native/truncated"));
  });
});
