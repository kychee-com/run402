/**
 * SIWX auth helper — generates SIWX (Sign-In With X / EIP-4361) headers for Run402 API.
 * Uses @noble/curves (lighter than viem) for signing.
 */

import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isSignerWallet, readWallet } from "./wallet.js";
import { getApiBase } from "./config.js";
import type { WalletData } from "./wallet.js";

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
 * EIP-191 personal_sign: sign a message with the wallet's private key.
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
  version?: string;
  chainId: number | string;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  resources?: string[];
}

export interface SIWxAuthOptions extends SIWEMessageOpts {
  wallet: Pick<WalletData, "address" | "privateKey">;
  type?: "eip191";
}

/** Signs an EIP-191 personal message for `address`; resolves to a 65-byte 0x hex signature. */
export type PersonalMessageSigner = (message: string) => Promise<string>;

/**
 * A SIWX header waiting for its signature: `message` is the exact EIP-4361
 * text to sign (EIP-191), `finish` turns the signature into the header. This
 * is how a signer-backed wallet, whose signature is asynchronous, signs in.
 */
export interface PreparedSIWx {
  message: string;
  finish(signature: string): SIWxAuthHeaders;
}

export function prepareSIWx(opts: SIWEMessageOpts & { address: string; type?: "eip191" }): PreparedSIWx {
  const message = formatSIWEMessage(opts, opts.address);
  return {
    message,
    finish(signature: string): SIWxAuthHeaders {
      const payload: Record<string, unknown> = {
        domain: opts.domain,
        address: toChecksumAddress(opts.address),
        statement: opts.statement,
        uri: opts.uri,
        version: opts.version ?? "1",
        chainId: payloadChainId(opts.chainId),
        type: opts.type ?? "eip191",
        nonce: opts.nonce,
        issuedAt: opts.issuedAt,
        expirationTime: opts.expirationTime,
        signature,
      };
      if (opts.resources !== undefined) {
        payload.resources = opts.resources;
      }
      return {
        "SIGN-IN-WITH-X": Buffer.from(JSON.stringify(payload)).toString("base64"),
      };
    },
  };
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
    `Version: ${opts.version ?? "1"}`,
    `Chain ID: ${messageChainId(opts.chainId)}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt}`,
  ];
  if (opts.expirationTime) {
    lines.push(`Expiration Time: ${opts.expirationTime}`);
  }
  if (opts.resources && opts.resources.length > 0) {
    lines.push("Resources:");
    for (const resource of opts.resources) lines.push(`- ${resource}`);
  }
  return lines.join("\n");
}

/** SIWX headers signed with a local private key (synchronous). */
export function buildSIWxAuthHeaders(opts: SIWxAuthOptions): SIWxAuthHeaders {
  if (!opts.wallet.privateKey) {
    throw new SignerWalletError();
  }
  const prepared = prepareSIWx({ ...opts, address: opts.wallet.address });
  return prepared.finish(personalSign(opts.wallet.privateKey, opts.wallet.address, prepared.message));
}

/**
 * Thrown where a synchronous signature is required but the wallet signs
 * through a signer (`wallet.json` `signer`). Callers that can wait use
 * `getWalletAuthHeadersAsync` with the SDK's signer instead.
 */
export class SignerWalletError extends Error {
  readonly code = "SIGNER_WALLET_ASYNC";
  constructor() {
    super("This wallet signs through a signer (wallet.json 'signer'), which this synchronous path cannot use.");
    this.name = "SignerWalletError";
  }
}

function walletSIWxOptions(path: string): SIWEMessageOpts {
  const apiBase = getApiBase();
  const url = new URL(apiBase);
  const now = new Date();
  return {
    domain: url.hostname,
    uri: `${apiBase}${path}`,
    statement: "Sign in to Run402",
    chainId: "eip155:84532",
    nonce: randomBytes(16).toString("hex"),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  };
}

/**
 * SIWX headers for any wallet: a key-backed wallet signs locally; a
 * signer-backed one through `signerFor(wallet)`. Null when no wallet exists.
 */
export async function getWalletAuthHeadersAsync(
  path: string,
  walletPath: string | undefined,
  signerFor: (wallet: WalletData) => Promise<PersonalMessageSigner>,
): Promise<SIWxAuthHeaders | null> {
  const localWallet = readWallet(walletPath);
  if (!localWallet || !localWallet.address) return null;
  if (!isSignerWallet(localWallet)) return getWalletAuthHeaders(path, walletPath);
  const prepared = prepareSIWx({ ...walletSIWxOptions(path), address: localWallet.address });
  const sign = await signerFor(localWallet);
  return prepared.finish(await sign(prepared.message));
}

/**
 * Get SIWX auth headers for the Run402 API.
 * Returns null if no local wallet is configured.
 *
 * @param path - API path (e.g. "/projects/v1") used to build the SIWE uri field.
 */
export function getWalletAuthHeaders(path: string, walletPath?: string): SIWxAuthHeaders | null {
  // readWallet throws on a malformed-shape wallet file. The
  // CLI's higher-level readWallet wrapper surfaces this as a structured
  // BAD_WALLET_FILE envelope; here we preserve the public contract that
  // this helper returns SIWxAuthHeaders | null. Re-throw so callers above
  // the CLI's wrapper (e.g. SDK paid-fetch) can decide whether to swallow it.
  const localWallet = readWallet(walletPath);
  if (!localWallet || !localWallet.address) return null;
  if (isSignerWallet(localWallet)) throw new SignerWalletError();
  if (!localWallet.privateKey) return null;
  return buildSIWxAuthHeaders({ wallet: localWallet, ...walletSIWxOptions(path) });
}

function messageChainId(chainId: number | string): string {
  if (typeof chainId === "number") return String(chainId);
  const match = /^eip155:(\d+)$/.exec(chainId);
  return match ? match[1]! : chainId;
}

function payloadChainId(chainId: number | string): string {
  return typeof chainId === "number" ? `eip155:${chainId}` : chainId;
}
