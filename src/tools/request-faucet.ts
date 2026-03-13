import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";
import { getWalletPath } from "../config.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const requestFaucetSchema = {
  address: z
    .string()
    .optional()
    .describe(
      "Wallet address (0x...) to fund. If omitted, reads from local wallet file.",
    ),
};

export async function handleRequestFaucet(args: {
  address?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let address = args.address;
  const walletPath = getWalletPath();

  if (!address) {
    try {
      const wallet = JSON.parse(readFileSync(walletPath, "utf-8"));
      address = wallet.address;
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "Error: No wallet address provided and no local wallet found. " +
              "Use `wallet_create` to create a wallet first, or pass an `address` parameter.",
          },
        ],
        isError: true,
      };
    }
  }

  const res = await apiRequest("/faucet/v1", {
    method: "POST",
    body: { address },
  });

  if (!res.ok) return formatApiError(res, "requesting faucet funds");

  const body = res.body as {
    transactionHash: string;
    amount: string;
    token: string;
    network: string;
  };

  // Update wallet file with funded status
  if (existsSync(walletPath)) {
    try {
      const wallet = JSON.parse(readFileSync(walletPath, "utf-8"));
      wallet.funded = true;
      wallet.lastFaucet = new Date().toISOString();
      writeFileSync(walletPath, JSON.stringify(wallet, null, 2), {
        mode: 0o600,
      });
    } catch {
      // non-fatal — wallet update is best-effort
    }
  }

  const lines = [
    `## Faucet Funded`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| address | \`${address}\` |`,
    `| amount | ${body.amount} ${body.token} |`,
    `| network | ${body.network} |`,
    `| tx | \`${body.transactionHash}\` |`,
    ``,
    `Wallet funded with testnet USDC. You can now provision databases and deploy sites.`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
