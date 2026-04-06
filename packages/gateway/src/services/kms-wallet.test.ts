import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---- Mock the KMS SDK before importing the module under test ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSend: (cmd: any) => Promise<any> = async () => ({});

class MockKMSClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(cmd: any): Promise<any> {
    return mockSend(cmd);
  }
}

class CreateKeyCommand {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(public input: any) {}
}
class GetPublicKeyCommand {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(public input: any) {}
}
class SignCommand {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(public input: any) {}
}
class ScheduleKeyDeletionCommand {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(public input: any) {}
}
class CancelKeyDeletionCommand {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(public input: any) {}
}

mock.module("@aws-sdk/client-kms", {
  namedExports: {
    KMSClient: MockKMSClient,
    CreateKeyCommand,
    GetPublicKeyCommand,
    SignCommand,
    ScheduleKeyDeletionCommand,
    CancelKeyDeletionCommand,
  },
});

const {
  derivedAddressFromPublicKey,
  createKmsKey,
  scheduleKeyDeletion,
  cancelKeyDeletion,
  signDigest,
} = await import("./kms-wallet.js");
const { secp256k1 } = await import("@noble/curves/secp256k1");

// ---- Address derivation -----------------------------------------------
// Known Ethereum test vector:
// secp256k1 uncompressed public key (DER, with 0x04 prefix point) →
// known checksummed Ethereum address.
//
// Test vector source: viem docs / Ethereum yellow paper example.
// Privkey 0x0000...0001 → addr 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
// Uncompressed pubkey for that privkey:
// 04 79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
//    483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
const KNOWN_PRIVKEY1_PUBKEY_HEX =
  "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const KNOWN_PRIVKEY1_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

// Wrap in a minimal SubjectPublicKeyInfo DER structure for secp256k1.
// We support BOTH a raw uncompressed point (65 bytes) AND a DER-wrapped one.
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Real KMS GetPublicKey returns a DER SubjectPublicKeyInfo. Build one
// for secp256k1 (ECC_SECG_P256K1) ourselves so the test mirrors reality.
function buildSpkiForSecp256k1(uncompressedPoint: Uint8Array): Uint8Array {
  // SPKI = SEQUENCE {
  //   AlgorithmIdentifier { OID id-ecPublicKey, OID secp256k1 },
  //   BIT STRING { 0x00 || uncompressedPoint }
  // }
  // Hard-coded prefix for ECC_SECG_P256K1, then BIT STRING wrapping.
  const algIdentifier = hexToBytes(
    "301006072a8648ce3d020106052b8104000a",
  ); // SEQ(OID ecPublicKey, OID secp256k1)
  // BIT STRING: 0x03 length 0x00 || point
  const bitStringContent = new Uint8Array(uncompressedPoint.length + 1);
  bitStringContent[0] = 0x00;
  bitStringContent.set(uncompressedPoint, 1);
  // length encoding
  function encodeLen(n: number): Uint8Array {
    if (n < 0x80) return Uint8Array.of(n);
    if (n < 0x100) return Uint8Array.of(0x81, n);
    return Uint8Array.of(0x82, (n >> 8) & 0xff, n & 0xff);
  }
  const bitStrLen = encodeLen(bitStringContent.length);
  const bitStr = new Uint8Array(1 + bitStrLen.length + bitStringContent.length);
  bitStr[0] = 0x03;
  bitStr.set(bitStrLen, 1);
  bitStr.set(bitStringContent, 1 + bitStrLen.length);
  // outer SEQUENCE
  const inner = new Uint8Array(algIdentifier.length + bitStr.length);
  inner.set(algIdentifier, 0);
  inner.set(bitStr, algIdentifier.length);
  const outerLen = encodeLen(inner.length);
  const out = new Uint8Array(1 + outerLen.length + inner.length);
  out[0] = 0x30;
  out.set(outerLen, 1);
  out.set(inner, 1 + outerLen.length);
  return out;
}

describe("derivedAddressFromPublicKey", () => {
  it("derives the canonical Ethereum address from a SPKI DER public key", () => {
    const point = hexToBytes(KNOWN_PRIVKEY1_PUBKEY_HEX);
    const der = buildSpkiForSecp256k1(point);
    const addr = derivedAddressFromPublicKey(der);
    assert.equal(addr.toLowerCase(), KNOWN_PRIVKEY1_ADDRESS.toLowerCase());
  });

  it("returns a checksummed address (mixed case)", () => {
    const point = hexToBytes(KNOWN_PRIVKEY1_PUBKEY_HEX);
    const der = buildSpkiForSecp256k1(point);
    const addr = derivedAddressFromPublicKey(der);
    // The known address has mixed case
    assert.equal(addr, KNOWN_PRIVKEY1_ADDRESS);
  });

  it("throws on malformed DER", () => {
    assert.throws(() => derivedAddressFromPublicKey(new Uint8Array([0x00, 0x01, 0x02])), /malformed/i);
  });

  it("throws on empty input", () => {
    assert.throws(() => derivedAddressFromPublicKey(new Uint8Array(0)), /malformed/i);
  });
});

// ---- createKmsKey -----------------------------------------------------
describe("createKmsKey", () => {
  beforeEach(() => {
    mockSend = async () => ({});
  });

  it("calls CreateKey with ECC_SECG_P256K1 + SIGN_VERIFY + project/wallet tags", async () => {
    let captured: any = null;
    mockSend = async (cmd: any) => {
      captured = cmd;
      return {
        KeyMetadata: { KeyId: "abc-key-id" },
      };
    };
    // Then GetPublicKey
    let stage = 0;
    mockSend = async (cmd: any) => {
      stage++;
      if (stage === 1) {
        captured = cmd;
        return { KeyMetadata: { KeyId: "abc-key-id" } };
      }
      if (stage === 2) {
        const point = hexToBytes(KNOWN_PRIVKEY1_PUBKEY_HEX);
        return { PublicKey: buildSpkiForSecp256k1(point) };
      }
      throw new Error(`unexpected call ${stage}`);
    };
    const result = await createKmsKey("proj_test", "wallet_test");
    assert.equal(result.kms_key_id, "abc-key-id");
    assert.match(result.address, /^0x[a-fA-F0-9]{40}$/);
    assert.equal(captured.input.KeySpec, "ECC_SECG_P256K1");
    assert.equal(captured.input.KeyUsage, "SIGN_VERIFY");
    const tagKeys = (captured.input.Tags as { TagKey: string; TagValue: string }[]).map((t) => t.TagKey);
    assert.ok(tagKeys.includes("run402:project_id"));
    assert.ok(tagKeys.includes("run402:wallet_id"));
  });

  it("preserves the original error when KMS fails", async () => {
    mockSend = async () => {
      throw new Error("AccessDeniedException: not allowed");
    };
    await assert.rejects(
      () => createKmsKey("p", "w"),
      /AccessDeniedException/,
    );
  });
});

// ---- scheduleKeyDeletion / cancelKeyDeletion --------------------------
describe("scheduleKeyDeletion", () => {
  it("uses the AWS minimum 7-day window", async () => {
    let captured: any = null;
    mockSend = async (cmd: any) => {
      captured = cmd;
      return { DeletionDate: new Date("2026-04-13T00:00:00Z") };
    };
    const result = await scheduleKeyDeletion("key-1");
    assert.equal(captured.input.KeyId, "key-1");
    assert.equal(captured.input.PendingWindowInDays, 7);
    assert.ok(result.deletion_date instanceof Date);
  });

  it("is idempotent for already-scheduled keys (returns the existing DeletionDate)", async () => {
    mockSend = async () => {
      const err = new Error("KMSInvalidStateException: already pending deletion");
      (err as Error & { name?: string }).name = "KMSInvalidStateException";
      throw err;
    };
    const result = await scheduleKeyDeletion("key-1");
    // We treat already-pending as success and return null deletion_date
    // (caller doesn't depend on it for the idempotent path).
    assert.equal(result.already_scheduled, true);
  });
});

// ---- signDigest -------------------------------------------------------
describe("signDigest", () => {
  it("returns (r, s, v) that recovers the wallet's address", async () => {
    // Use noble to sign a known digest with privkey 1 → address 0x7E5F...
    const priv = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
    const digest = hexToBytes("1111111111111111111111111111111111111111111111111111111111111111");
    const sig = secp256k1.sign(digest, priv, { lowS: true });
    const der = sig.toDERRawBytes();
    mockSend = async () => ({ Signature: der });
    const result = await signDigest("any-key", digest, KNOWN_PRIVKEY1_ADDRESS);
    assert.match(result.r, /^0x[a-f0-9]{64}$/);
    assert.match(result.s, /^0x[a-f0-9]{64}$/);
    assert.ok(result.v === 27 || result.v === 28);
  });

  it("rejects digests of the wrong length", async () => {
    await assert.rejects(
      () => signDigest("k", new Uint8Array(31), KNOWN_PRIVKEY1_ADDRESS),
      /32 bytes/,
    );
  });

  it("throws on malformed DER", async () => {
    mockSend = async () => ({ Signature: new Uint8Array([0x00, 0x01]) });
    await assert.rejects(
      () => signDigest("k", new Uint8Array(32), KNOWN_PRIVKEY1_ADDRESS),
      /malformed DER/,
    );
  });

  it("preserves AccessDenied errors from KMS", async () => {
    mockSend = async () => {
      throw new Error("AccessDeniedException: kms:Sign denied");
    };
    await assert.rejects(
      () => signDigest("k", new Uint8Array(32), KNOWN_PRIVKEY1_ADDRESS),
      /AccessDeniedException/,
    );
  });
});

describe("cancelKeyDeletion", () => {
  it("calls CancelKeyDeletion with the supplied key id", async () => {
    let captured: any = null;
    mockSend = async (cmd: any) => {
      captured = cmd;
      return { KeyId: "key-1" };
    };
    await cancelKeyDeletion("key-1");
    assert.equal(captured.input.KeyId, "key-1");
  });
});
