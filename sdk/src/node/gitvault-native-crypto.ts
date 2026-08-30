/**
 * The Node-native bulk-AEAD backend (gitvault-native-bulk-crypto, design
 * D1/D2/D4).
 *
 * Every WAL pack, checkpoint pack, `ref_state` and `retention_roots` frame
 * passes through `sealFrame`/`openFrame`, and on the benchmark vault the 67 MB
 * checkpoint pack's decrypt is a measured share of a cold clone's local
 * segment. `@noble/ciphers` is correct everywhere and stays the default; Node
 * simply has a faster implementation of the SAME construction sitting in
 * OpenSSL, so this module installs it through the core's backend seam.
 *
 * `node:crypto` has no XChaCha20-Poly1305, but the construction is defined in
 * terms of primitives it does have (D2):
 *
 *     subkey = HChaCha20(key, nonce[0..16])
 *     out    = ChaCha20-Poly1305-IETF(subkey, iv = 0x00000000 ‖ nonce[16..24])
 *
 * The subkey step is the ONLY missing piece, and `@noble/ciphers` exports
 * `hchacha` for exactly it — so the key-derivation half stays on the audited
 * implementation and only the bulk stream+tag work moves to OpenSSL. Output
 * layout is `ct‖tag`, byte-identical to `@noble`'s
 * `xchacha20poly1305(...).encrypt` (verified across sizes spanning 0 bytes to
 * multiple megabytes, and every AAD length, by the byte-equality suite).
 *
 * Failure posture (D4): registration is guarded by cipher availability and
 * try/caught, so an OpenSSL build without `chacha20-poly1305` — or any
 * construction error — silently leaves the `@noble` path in place. Correct,
 * just slower. `open` returns `null` on tag failure; the core renders the
 * SAME `GITVAULT_AEAD_AUTH_FAILURE` it always did.
 */
import { createCipheriv, createDecipheriv, getCiphers } from "node:crypto";
import { hchacha } from "@noble/ciphers/chacha.js";
import { _setGitvaultAeadBackend, type GitvaultAeadBackend } from "../namespaces/gitvault.crypto.js";

const NODE_CIPHER = "chacha20-poly1305";
const TAG_BYTES = 16;
/** ChaCha's `"expand 32-byte k"` constant as little-endian u32 words. */
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

/**
 * Little-endian byte↔word conversion done EXPLICITLY rather than through a
 * `Uint32Array` view of the same buffer: a view is platform-endian, so it
 * would silently produce a different subkey on a big-endian host — a
 * wire-format fork by architecture, the one unacceptable outcome (D5).
 */
function leWords(bytes: Uint8Array): Uint32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = new Uint32Array(bytes.byteLength / 4);
  for (let i = 0; i < words.length; i += 1) words[i] = view.getUint32(i * 4, true);
  return words;
}

function leBytes(words: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < words.length; i += 1) view.setUint32(i * 4, words[i]!, true);
  return bytes;
}

/** HChaCha20(key, nonce[0..16]) → the 32-byte IETF subkey. */
function xchachaSubkey(key32: Uint8Array, nonce24: Uint8Array): Uint8Array {
  const out = new Uint32Array(8);
  hchacha(SIGMA, leWords(key32), leWords(nonce24.subarray(0, 16)), out);
  return leBytes(out);
}

/** The IETF 12-byte nonce: four zero bytes, then the extended nonce's tail. */
function ietfIv(nonce24: Uint8Array): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(nonce24.subarray(16, 24), 4);
  return iv;
}

export const nodeGitvaultAeadBackend: GitvaultAeadBackend = {
  seal(key32, nonce24, aad, plaintext) {
    const cipher = createCipheriv(NODE_CIPHER, xchachaSubkey(key32, nonce24), ietfIv(nonce24), { authTagLength: TAG_BYTES });
    // OpenSSL's ChaCha20-Poly1305 needs the plaintext length up front when an
    // AAD is set; an empty AAD must not be fed at all (it is not the same as
    // "no AAD" to every OpenSSL build).
    if (aad.length > 0) cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const head = cipher.update(plaintext);
    const tail = cipher.final();
    const tag = cipher.getAuthTag();
    const out = new Uint8Array(head.length + tail.length + tag.length);
    out.set(head, 0);
    out.set(tail, head.length);
    out.set(tag, head.length + tail.length);
    return out;
  },

  open(key32, nonce24, aad, ciphertextAndTag) {
    if (ciphertextAndTag.length < TAG_BYTES) return null;
    const split = ciphertextAndTag.length - TAG_BYTES;
    const decipher = createDecipheriv(NODE_CIPHER, xchachaSubkey(key32, nonce24), ietfIv(nonce24), { authTagLength: TAG_BYTES });
    if (aad.length > 0) decipher.setAAD(aad, { plaintextLength: split });
    decipher.setAuthTag(ciphertextAndTag.subarray(split));
    try {
      const head = decipher.update(ciphertextAndTag.subarray(0, split));
      const tail = decipher.final();
      const out = new Uint8Array(head.length + tail.length);
      out.set(head, 0);
      out.set(tail, head.length);
      return out;
    } catch {
      // Tag mismatch — indistinguishable from any other authentication
      // failure, which is exactly the contract.
      return null;
    }
  },
};

/**
 * Install the native backend when this OpenSSL has the cipher. Returns whether
 * it took, so a test can assert the guard rather than infer it. Any failure
 * leaves the `@noble` default untouched — the native path is an optimization,
 * never a correctness dependency.
 */
export function installNodeGitvaultAeadBackend(): boolean {
  try {
    if (!getCiphers().includes(NODE_CIPHER)) return false;
    // Prove the construction works on THIS build before letting the bulk path
    // depend on it: a cipher that is listed but rejects our parameters must
    // not become a runtime failure on the first real frame.
    const probe = nodeGitvaultAeadBackend.seal(new Uint8Array(32), new Uint8Array(24), new Uint8Array([1]), new Uint8Array([2, 3]));
    const opened = nodeGitvaultAeadBackend.open(new Uint8Array(32), new Uint8Array(24), new Uint8Array([1]), probe);
    if (!opened || opened.length !== 2 || opened[0] !== 2 || opened[1] !== 3) return false;
    _setGitvaultAeadBackend(nodeGitvaultAeadBackend);
    return true;
  } catch {
    return false;
  }
}
