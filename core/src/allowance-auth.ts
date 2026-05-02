/**
 * Allowance auth helper — generates SIWX (Sign-In With X / EIP-4361) headers for Run402 API.
 * Uses @noble/curves (lighter than viem) for signing.
 */

import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readAllowance } from "./allowance.js";
import { getApiBase } from "./config.js";

export interface SIWxAuthHeaders {
  "SIGN-IN-WITH-X": string;
}

/**
 * EIP-55 mixed-case checksum encoding.
 */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace("0x", "");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let checksummed = "0x";
  for (let i = 0; i < lower.length; i++) {
    checksummed += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i];
  }
  return checksummed;
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
  const rawSig = secp256k1.sign(hash, pkBytes, { prehash: false });
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

interface SIWEMessageOpts {
  domain: string;
  uri: string;
  statement: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}

/**
 * Format an EIP-4361 (SIWE) message. Must be byte-for-byte compatible
 * with the `siwe` library's message format used server-side for verification.
 */
export function formatSIWEMessage(opts: SIWEMessageOpts, address: string): string {
  const checksummed = toChecksumAddress(address);
  const lines = [
    `${opts.domain} wants you to sign in with your Ethereum account:`,
    checksummed,
    "",
    opts.statement,
    "",
    `URI: ${opts.uri}`,
    `Version: ${opts.version}`,
    `Chain ID: ${opts.chainId}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt}`,
  ];
  if (opts.expirationTime) {
    lines.push(`Expiration Time: ${opts.expirationTime}`);
  }
  return lines.join("\n");
}

/**
 * Get SIWX auth headers for the Run402 API.
 * Returns null if no allowance is configured.
 *
 * @param path - API path (e.g. "/projects/v1") used to build the SIWE uri field.
 */
export function getAllowanceAuthHeaders(path: string, allowancePath?: string): SIWxAuthHeaders | null {
  // GH-194: readAllowance throws on a malformed-shape allowance file. The
  // CLI's higher-level readAllowance wrapper surfaces this as a structured
  // BAD_ALLOWANCE_FILE envelope; here we preserve the public contract that
  // this helper returns SIWxAuthHeaders | null. Re-throw so callers above
  // the CLI's wrapper (e.g. SDK paid-fetch) can decide whether to swallow it.
  const allowance = readAllowance(allowancePath);
  if (!allowance || !allowance.address || !allowance.privateKey) return null;

  const apiBase = getApiBase();
  const url = new URL(apiBase);
  const domain = url.hostname;
  const uri = `${apiBase}${path}`;
  const nonce = randomBytes(16).toString("hex");
  const now = new Date();
  const issuedAt = now.toISOString();
  const expirationTime = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

  const message = formatSIWEMessage(
    {
      domain,
      uri,
      statement: "Sign in to Run402",
      version: "1",
      chainId: 84532, // Base Sepolia
      nonce,
      issuedAt,
      expirationTime,
    },
    allowance.address,
  );

  const signature = personalSign(allowance.privateKey, allowance.address, message);

  const payload = {
    domain,
    address: toChecksumAddress(allowance.address),
    statement: "Sign in to Run402",
    uri,
    version: "1",
    chainId: "eip155:84532",
    type: "eip191",
    nonce,
    issuedAt,
    expirationTime,
    signature,
  };

  return {
    "SIGN-IN-WITH-X": Buffer.from(JSON.stringify(payload)).toString("base64"),
  };
}
