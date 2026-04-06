/**
 * Thin viem readContract wrapper. Pulled out so the contract-read service
 * can be unit-tested without RPC.
 */

import { createPublicClient, http, type Abi } from "viem";
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

export interface RpcReadInput {
  chain: string;
  contractAddress: string;
  abiFragment: Abi;
  functionName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
}

export async function rpcReadContract(input: RpcReadInput): Promise<unknown> {
  return await client(input.chain).readContract({
    address: input.contractAddress as `0x${string}`,
    abi: input.abiFragment,
    functionName: input.functionName,
    args: input.args,
  });
}
