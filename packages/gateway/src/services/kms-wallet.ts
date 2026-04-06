/**
 * KMS-backed Ethereum wallet primitives.
 *
 * Responsibilities:
 *   - createKmsKey: provision an AWS KMS key (ECC_SECG_P256K1 / SIGN_VERIFY)
 *     tagged with project + wallet ids, fetch its public key, and derive the
 *     Ethereum address.
 *   - derivedAddressFromPublicKey: pure helper that parses a SPKI DER public
 *     key into the canonical Ethereum address (checksummed).
 *   - signDigest: ask KMS to sign a 32-byte digest, parse the DER signature,
 *     and compute the Ethereum recovery id `v` by trying both candidates.
 *   - scheduleKeyDeletion / cancelKeyDeletion: lifecycle helpers used by the
 *     90-day deletion job and admin recovery.
 *
 * Private key material NEVER leaves KMS — there is intentionally no helper
 * for `kms:Decrypt` or `kms:GetParametersForImport`.
 */

import {
  KMSClient,
  CreateKeyCommand,
  GetPublicKeyCommand,
  SignCommand,
  ScheduleKeyDeletionCommand,
  CancelKeyDeletionCommand,
} from "@aws-sdk/client-kms";
import { keccak256, getAddress, recoverAddress, type Hex } from "viem";

const REGION = process.env.AWS_REGION || "us-east-1";

let _client: KMSClient | null = null;
function getClient(): KMSClient {
  if (!_client) _client = new KMSClient({ region: REGION });
  return _client;
}

// Allow tests to swap the client (the `mock.module` in tests already
// replaces the imported names, so this is mainly for runtime use).
export function _setKmsClientForTests(c: KMSClient): void {
  _client = c;
}

// ---------------------------------------------------------------------------
// derivedAddressFromPublicKey
// ---------------------------------------------------------------------------

/**
 * Parse an AWS KMS GetPublicKey DER blob (SubjectPublicKeyInfo) and return
 * the Ethereum checksummed address.
 *
 * Accepts:
 *   - A full SPKI DER (what KMS actually returns)
 *   - A raw 65-byte uncompressed point starting with 0x04 (convenience for
 *     callers that already extracted the point)
 */
export function derivedAddressFromPublicKey(der: Uint8Array): string {
  if (!der || der.length === 0) {
    throw new Error("malformed public key: empty input");
  }

  let point: Uint8Array;

  if (der.length === 65 && der[0] === 0x04) {
    // Already a raw uncompressed point
    point = der;
  } else {
    point = extractUncompressedPointFromSpki(der);
  }

  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("malformed public key: not an uncompressed secp256k1 point");
  }

  // Keccak256 of the 64-byte public key (drop the 0x04 prefix), take last 20 bytes
  const xy = point.slice(1);
  const hash = keccak256(`0x${bytesToHex(xy)}`);
  const addrHex = "0x" + hash.slice(-40);
  return getAddress(addrHex);
}

function extractUncompressedPointFromSpki(der: Uint8Array): Uint8Array {
  // SPKI = SEQUENCE {
  //   AlgorithmIdentifier ...,
  //   BIT STRING { 0x00 || uncompressedPoint }
  // }
  // We just walk the DER until we find a BIT STRING (tag 0x03) whose
  // contents start with 0x00 0x04 and are 66 bytes (1 padding + 65 point).
  let i = 0;
  while (i < der.length) {
    const tag = der[i];
    i += 1;
    if (i >= der.length) break;
    let len = der[i];
    i += 1;
    if (len & 0x80) {
      const numLenBytes = len & 0x7f;
      if (numLenBytes === 0 || i + numLenBytes > der.length) {
        throw new Error("malformed public key: bad length encoding");
      }
      len = 0;
      for (let j = 0; j < numLenBytes; j++) {
        len = (len << 8) | der[i + j];
      }
      i += numLenBytes;
    }
    if (tag === 0x30) {
      // SEQUENCE — descend
      continue;
    }
    if (tag === 0x03) {
      // BIT STRING
      if (len < 2) throw new Error("malformed public key: bit string too short");
      const padBits = der[i];
      const content = der.slice(i + 1, i + len);
      if (padBits !== 0x00) throw new Error("malformed public key: unexpected bit string padding");
      if (content.length !== 65 || content[0] !== 0x04) {
        throw new Error("malformed public key: not an uncompressed secp256k1 point");
      }
      return content;
    }
    // skip other tags
    i += len;
  }
  throw new Error("malformed public key: no BIT STRING found");
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += b[i].toString(16).padStart(2, "0");
  }
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// createKmsKey
// ---------------------------------------------------------------------------

export interface CreatedKmsKey {
  kms_key_id: string;
  address: string;
  public_key_der: Uint8Array;
}

export async function createKmsKey(projectId: string, walletId: string): Promise<CreatedKmsKey> {
  const client = getClient();
  const created = await client.send(
    new CreateKeyCommand({
      KeySpec: "ECC_SECG_P256K1",
      KeyUsage: "SIGN_VERIFY",
      Description: `run402 KMS contract wallet (project=${projectId} wallet=${walletId})`,
      Tags: [
        { TagKey: "run402:project_id", TagValue: projectId },
        { TagKey: "run402:wallet_id", TagValue: walletId },
      ],
    }),
  );
  const keyId = created.KeyMetadata?.KeyId;
  if (!keyId) {
    throw new Error("KMS CreateKey returned no KeyId");
  }

  const pub = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!pub.PublicKey) {
    throw new Error(`KMS GetPublicKey returned no PublicKey for ${keyId}`);
  }
  const der = pub.PublicKey instanceof Uint8Array ? pub.PublicKey : new Uint8Array(pub.PublicKey as ArrayBufferLike);
  const address = derivedAddressFromPublicKey(der);
  return { kms_key_id: keyId, address, public_key_der: der };
}

// ---------------------------------------------------------------------------
// signDigest — DER signature → (r, s, v) for Ethereum
// ---------------------------------------------------------------------------

const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
const SECP256K1_HALF_N = SECP256K1_N >> BigInt(1);

export interface RecoverableSignature {
  r: Hex;
  s: Hex;
  v: 27 | 28;
}

/**
 * Sign a 32-byte digest with the given KMS key and return an
 * Ethereum-style (r, s, v) tuple. The recovery id is computed by trying
 * both candidates (27 and 28) and picking the one whose recovered address
 * matches `walletAddress`.
 */
export async function signDigest(
  kmsKeyId: string,
  digest32: Uint8Array,
  walletAddress: string,
): Promise<RecoverableSignature> {
  if (digest32.length !== 32) {
    throw new Error("signDigest: digest must be exactly 32 bytes");
  }
  const client = getClient();
  const result = await client.send(
    new SignCommand({
      KeyId: kmsKeyId,
      Message: digest32,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    }),
  );
  if (!result.Signature) {
    throw new Error("KMS Sign returned no Signature");
  }
  const sig = result.Signature instanceof Uint8Array ? result.Signature : new Uint8Array(result.Signature as ArrayBufferLike);
  const { r, s } = parseDerSignature(sig);

  // Apply the low-s rule (EIP-2): if s > n/2 then s = n - s
  let canonicalS = s;
  if (canonicalS > SECP256K1_HALF_N) {
    canonicalS = SECP256K1_N - canonicalS;
  }

  const rHex = ("0x" + r.toString(16).padStart(64, "0")) as Hex;
  const sHex = ("0x" + canonicalS.toString(16).padStart(64, "0")) as Hex;
  const digestHex = ("0x" + bytesToHex(digest32)) as Hex;

  for (const v of [27, 28] as const) {
    try {
      const recovered = await recoverAddress({
        hash: digestHex,
        signature: { r: rHex, s: sHex, v: BigInt(v) },
      });
      if (recovered.toLowerCase() === walletAddress.toLowerCase()) {
        return { r: rHex, s: sHex, v };
      }
    } catch {
      // try next v
    }
  }
  throw new Error("signDigest: could not recover wallet address from signature (key/address mismatch?)");
}

function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  // SEQUENCE (0x30) length INTEGER (0x02) length R INTEGER (0x02) length S
  if (der[0] !== 0x30) throw new Error("signDigest: malformed DER signature");
  let i = 2;
  if ((der[1] & 0x80) !== 0) {
    // long-form length: 0x81 then 1 byte
    i = 3;
  }
  if (der[i] !== 0x02) throw new Error("signDigest: malformed DER signature (no R)");
  const rLen = der[i + 1];
  const rBytes = der.slice(i + 2, i + 2 + rLen);
  i = i + 2 + rLen;
  if (der[i] !== 0x02) throw new Error("signDigest: malformed DER signature (no S)");
  const sLen = der[i + 1];
  const sBytes = der.slice(i + 2, i + 2 + sLen);
  return { r: BigInt("0x" + bytesToHex(stripLeadingZero(rBytes))), s: BigInt("0x" + bytesToHex(stripLeadingZero(sBytes))) };
}

function stripLeadingZero(b: Uint8Array): Uint8Array {
  // DER allows a leading 0x00 byte to indicate non-negative numbers; strip it.
  if (b.length > 1 && b[0] === 0x00) return b.slice(1);
  return b;
}

// ---------------------------------------------------------------------------
// scheduleKeyDeletion / cancelKeyDeletion
// ---------------------------------------------------------------------------

export interface ScheduledDeletion {
  deletion_date: Date | null;
  already_scheduled: boolean;
}

export async function scheduleKeyDeletion(kmsKeyId: string): Promise<ScheduledDeletion> {
  const client = getClient();
  try {
    const result = await client.send(
      new ScheduleKeyDeletionCommand({
        KeyId: kmsKeyId,
        PendingWindowInDays: 7,
      }),
    );
    return { deletion_date: result.DeletionDate ?? null, already_scheduled: false };
  } catch (err: unknown) {
    const errName = (err as Error & { name?: string })?.name || "";
    const msg = (err as Error)?.message || "";
    if (errName === "KMSInvalidStateException" || /pending deletion/i.test(msg)) {
      return { deletion_date: null, already_scheduled: true };
    }
    throw err;
  }
}

export async function cancelKeyDeletion(kmsKeyId: string): Promise<void> {
  const client = getClient();
  await client.send(new CancelKeyDeletionCommand({ KeyId: kmsKeyId }));
}

// Re-export the hex helper (used by tests)
export { hexToBytes as _hexToBytes };
