/**
 * Allowance auth helper — generates EIP-191 signature headers for Run402 API.
 * Uses @noble/curves (lighter than viem) for signing.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readAllowance } from "./allowance.js";

export interface AllowanceAuthHeaders {
  "X-Run402-Wallet": string;
  "X-Run402-Signature": string;
  "X-Run402-Timestamp": string;
}

/**
 * EIP-191 personal_sign: sign a message with the allowance's private key.
 */
function personalSign(privateKeyHex: string, address: string, message: string): string {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${msgBytes.length}`,
  );
  const prefixed = new Uint8Array(prefix.length + msgBytes.length);
  prefixed.set(prefix);
  prefixed.set(msgBytes, prefix.length);

  const hash = keccak_256(prefixed);
  const pkHex = privateKeyHex.startsWith("0x")
    ? privateKeyHex.slice(2)
    : privateKeyHex;
  const pkBytes = Uint8Array.from(Buffer.from(pkHex, "hex"));
  const rawSig = secp256k1.sign(hash, pkBytes);
  const sig = secp256k1.Signature.fromBytes(rawSig);

  // Determine recovery bit by trying both and matching the address
  let recovery = 0;
  for (const v of [0, 1]) {
    try {
      const recovered = sig.addRecoveryBit(v).recoverPublicKey(hash);
      const pubBytes = recovered.toBytes(false).slice(1); // uncompressed, drop 04 prefix
      const addrBytes = keccak_256(pubBytes).slice(-20);
      if ("0x" + bytesToHex(addrBytes) === address.toLowerCase()) {
        recovery = v;
        break;
      }
    } catch {
      continue;
    }
  }

  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const vHex = (recovery + 27).toString(16).padStart(2, "0");
  return "0x" + r + s + vHex;
}

/**
 * Get allowance auth headers for the Run402 API.
 * Returns null if no allowance is configured.
 */
export function getAllowanceAuthHeaders(allowancePath?: string): AllowanceAuthHeaders | null {
  const allowance = readAllowance(allowancePath);
  if (!allowance || !allowance.address || !allowance.privateKey) return null;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = personalSign(allowance.privateKey, allowance.address, `run402:${timestamp}`);

  return {
    "X-Run402-Wallet": allowance.address,
    "X-Run402-Signature": signature,
    "X-Run402-Timestamp": timestamp,
  };
}
