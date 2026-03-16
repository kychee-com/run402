import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";
import { getAllowancePath } from "../config.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const requestFaucetSchema = {
  address: z
    .string()
    .optional()
    .describe(
      "Wallet address (0x...) to fund. If omitted, reads from local agent allowance file.",
    ),
};

export async function handleRequestFaucet(args: {
  address?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let address = args.address;
  const allowancePath = getAllowancePath();

  if (!address) {
    try {
      const allowance = JSON.parse(readFileSync(allowancePath, "utf-8"));
      address = allowance.address;
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "Error: No address provided and no local agent allowance found. " +
              "Use `allowance_create` to create an allowance first, or pass an `address` parameter.",
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

  // Update allowance file with funded status
  if (existsSync(allowancePath)) {
    try {
      const allowance = JSON.parse(readFileSync(allowancePath, "utf-8"));
      allowance.funded = true;
      allowance.lastFaucet = new Date().toISOString();
      writeFileSync(allowancePath, JSON.stringify(allowance, null, 2), {
        mode: 0o600,
      });
    } catch {
      // non-fatal — allowance update is best-effort
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
    `Agent allowance funded with testnet USDC. You can now provision databases and deploy sites.`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
