/**
 * Thin RPC wrapper for contract-call status reconciliation. Pulled out so
 * the reconciler can be unit-tested without viem/RPC.
 */

import { createPublicClient, http } from "viem";
import { getChain } from "./chain-config.js";

function rpcUrl(chainName: string): string {
  if (chainName === "base-mainnet" && process.env.BASE_MAINNET_RPC_URL) return process.env.BASE_MAINNET_RPC_URL;
  if (chainName === "base-sepolia" && process.env.BASE_SEPOLIA_RPC_URL) return process.env.BASE_SEPOLIA_RPC_URL;
  if (chainName === "base-mainnet") return "https://mainnet.base.org";
  if (chainName === "base-sepolia") return "https://sepolia.base.org";
  throw new Error(`no RPC URL configured for chain ${chainName}`);
}

function client(chainName: string) {
  const cfg = getChain(chainName);
  return createPublicClient({
    chain: { id: cfg.chain_id, name: cfg.name, nativeCurrency: { decimals: 18, name: cfg.native_token, symbol: cfg.native_token }, rpcUrls: { default: { http: [rpcUrl(chainName)] } } } as never,
    transport: http(rpcUrl(chainName)),
  });
}

export interface MinimalReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export async function getTransactionReceipt(txHash: string, chainName: string): Promise<MinimalReceipt | null> {
  try {
    const r = await client(chainName).getTransactionReceipt({ hash: txHash as `0x${string}` });
    return {
      status: r.status,
      blockNumber: r.blockNumber,
      gasUsed: r.gasUsed,
      effectiveGasPrice: r.effectiveGasPrice ?? BigInt(0),
    };
  } catch (err: unknown) {
    const msg = (err as Error)?.message ?? "";
    // viem throws TransactionReceiptNotFoundError for pending — treat as null.
    if (/not found|Could not find/i.test(msg)) return null;
    throw err;
  }
}
