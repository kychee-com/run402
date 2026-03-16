/**
 * Shared x402 payment wrapper for CLI commands that need paid fetch.
 * Uses viem for allowance signing + @x402/fetch for payment wrapping.
 */

import { readAllowance, ALLOWANCE_FILE } from "./config.mjs";
import { existsSync } from "fs";

export async function setupPaidFetch() {
  if (!existsSync(ALLOWANCE_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No agent allowance found. Run: run402 allowance create && run402 allowance fund" }));
    process.exit(1);
  }
  const allowance = readAllowance();
  const { privateKeyToAccount } = await import("viem/accounts");
  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { toClientEvmSigner } = await import("@x402/evm");
  const account = privateKeyToAccount(allowance.privateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register("eip155:84532", new ExactEvmScheme(signer));
  return wrapFetchWithPayment(fetch, client);
}
