import { loadX402Stack } from "./_paid-stack.js";
import { checkBalanceAcrossProviders } from "./paid-fetch.js";

/** Balance, never the historical faucet marker, decides whether bootstrap needs funding. */
export async function prototypeBalance(address: string): Promise<bigint> {
  const { createPublicClient, http, baseSepolia } = await loadX402Stack();
  const clients = ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]
    .map(url => createPublicClient({ chain: baseSepolia, transport: http(url) }));
  return checkBalanceAcrossProviders(clients, "0x036CbD53842c5426634e7929541eC2318f3dCF7e", address, "eip155:84532");
}
