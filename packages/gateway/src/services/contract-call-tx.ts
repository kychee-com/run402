/**
 * viem-backed transaction building / broadcasting helpers.
 *
 * Pulled out of `contract-call.ts` so the orchestrator can be unit-tested
 * with mocks (these functions are the only ones that touch RPC + viem
 * directly).
 */

import {
  createPublicClient,
  http,
  encodeFunctionData,
  serializeTransaction,
  keccak256,
  type Abi,
  type Hex,
} from "viem";
import { getChain } from "./chain-config.js";

const _rpcUrls: Record<string, string> = {};

export function setChainRpcUrl(chainName: string, url: string): void {
  _rpcUrls[chainName] = url;
}

function rpcUrl(chainName: string): string {
  // Prefer the boot-loaded map; fall back to env var; final fallback to public RPC.
  const fromMap = _rpcUrls[chainName];
  if (fromMap) return fromMap;
  if (chainName === "base-mainnet" && process.env.BASE_MAINNET_RPC_URL) return process.env.BASE_MAINNET_RPC_URL;
  if (chainName === "base-sepolia" && process.env.BASE_SEPOLIA_RPC_URL) return process.env.BASE_SEPOLIA_RPC_URL;
  // Last-resort public RPCs (these are the secret defaults too).
  if (chainName === "base-mainnet") return "https://mainnet.base.org";
  if (chainName === "base-sepolia") return "https://sepolia.base.org";
  throw new Error(`no RPC URL configured for chain ${chainName}`);
}

function publicClient(chainName: string) {
  const cfg = getChain(chainName);
  return createPublicClient({
    chain: { id: cfg.chain_id, name: cfg.name, nativeCurrency: { decimals: 18, name: cfg.native_token, symbol: cfg.native_token }, rpcUrls: { default: { http: [rpcUrl(chainName)] } } } as never,
    transport: http(rpcUrl(chainName)),
  });
}

export async function getNativeBalanceWei(address: string, chainName: string): Promise<bigint> {
  const client = publicClient(chainName);
  return await client.getBalance({ address: address as `0x${string}` });
}

export async function getNonce(address: string, chainName: string): Promise<number> {
  const client = publicClient(chainName);
  return await client.getTransactionCount({ address: address as `0x${string}` });
}

export interface BuildTxInput {
  chainName: string;
  fromAddress: string;
  toAddress: string;
  data: Hex;
  valueWei: bigint;
}

export interface BuiltTx {
  digest32: Uint8Array;
  serializedSigned: Hex;
  estimatedGasCostWei: bigint;
  nonce: number;
}

/**
 * Build, hash, sign-via-callback, and serialize a transaction. Returns
 * the digest that was signed (so the caller can verify), the signed
 * serialized tx ready to broadcast, and the gas-cost estimate.
 */
export async function buildSignedTransaction(
  input: BuildTxInput,
  signDigest: (digest32: Uint8Array, walletAddress: string) => Promise<{ r: Hex; s: Hex; v: 27 | 28 }>,
): Promise<BuiltTx> {
  const cfg = getChain(input.chainName);
  const client = publicClient(input.chainName);

  // Estimate gas
  const gas = await (client as unknown as { estimateGas: (args: unknown) => Promise<bigint> }).estimateGas({
    account: input.fromAddress as `0x${string}`,
    to: input.toAddress as `0x${string}`,
    data: input.data,
    value: input.valueWei,
  });

  // EIP-1559 fee data
  const feeData = await client.estimateFeesPerGas();

  const nonce = await client.getTransactionCount({ address: input.fromAddress as `0x${string}` });

  const txRequest = {
    chainId: cfg.chain_id,
    type: "eip1559" as const,
    nonce,
    maxFeePerGas: feeData.maxFeePerGas!,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
    gas,
    to: input.toAddress as `0x${string}`,
    value: input.valueWei,
    data: input.data,
  };

  // Hash for signing
  const unsignedSerialized = serializeTransaction(txRequest);
  const digestHex = keccak256(unsignedSerialized);
  const digest32 = hexToBytes(digestHex);

  const sig = await signDigest(digest32, input.fromAddress);

  const signedSerialized = serializeTransaction(txRequest, {
    r: sig.r,
    s: sig.s,
    v: BigInt(sig.v),
  });

  const estimatedGasCostWei = gas * feeData.maxFeePerGas!;

  return {
    digest32,
    serializedSigned: signedSerialized,
    estimatedGasCostWei,
    nonce,
  };
}

export async function broadcastSignedTransaction(
  serialized: Hex,
  chainName: string,
): Promise<{ tx_hash: Hex }> {
  const client = publicClient(chainName);
  const hash = await client.sendRawTransaction({ serializedTransaction: serialized });
  return { tx_hash: hash };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Re-export for testing convenience
export { encodeFunctionData };
export type { Abi };
