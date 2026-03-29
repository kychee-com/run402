/**
 * Pre-flight: ensure the test wallet has enough USDC on Base Sepolia.
 * If balance is below the threshold, auto-drip from the Run402 faucet.
 *
 * Usage:
 *   import { ensureTestBalance } from "./ensure-balance.js";
 *   await ensureTestBalance(walletAddress, baseUrl);
 */

import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MIN_BALANCE_USDC = 0.15; // drip if below this (one tier sub = $0.10)

const client = createPublicClient({ chain: baseSepolia, transport: http() });

async function getUsdcBalance(wallet: string): Promise<number> {
  const raw = await client.readContract({
    address: USDC_ADDRESS,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [wallet as `0x${string}`],
  });
  return Number(raw) / 1e6;
}

export async function ensureTestBalance(
  walletAddress: string,
  baseUrl: string,
): Promise<void> {
  const balance = await getUsdcBalance(walletAddress);

  if (balance >= MIN_BALANCE_USDC) {
    console.log(`  Wallet balance: ${balance.toFixed(2)} USDC (ok)`);
    return;
  }

  console.log(`  Wallet balance: ${balance.toFixed(2)} USDC (below ${MIN_BALANCE_USDC} — dripping...)`);

  const resp = await fetch(`${baseUrl}/faucet/v1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: walletAddress }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`  Faucet drip failed (${resp.status}): ${body}`);
    console.error("  Tests will likely fail due to insufficient funds.");
    return;
  }

  const drip = await resp.json() as { amount_usd_micros: number; transaction_hash: string };
  console.log(`  Faucet drip: +${(drip.amount_usd_micros / 1e6).toFixed(2)} USDC (tx: ${drip.transaction_hash.slice(0, 10)}...)`);

  // Wait for the drip to confirm
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const newBalance = await getUsdcBalance(walletAddress);
    if (newBalance >= MIN_BALANCE_USDC) {
      console.log(`  Wallet balance: ${newBalance.toFixed(2)} USDC (ready)`);
      return;
    }
  }

  console.warn("  Drip sent but balance still low — proceeding anyway.");
}
