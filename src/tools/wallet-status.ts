import { z } from "zod";
import { getWalletPath } from "../config.js";
import { readWallet } from "../wallet.js";

export const walletStatusSchema = {};

export async function handleWalletStatus(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const walletPath = getWalletPath();
  const wallet = readWallet();

  if (!wallet) {
    return {
      content: [
        {
          type: "text",
          text: "No wallet found. Use `wallet_create` to create one.",
        },
      ],
    };
  }

  const lines = [
    `## Wallet Status`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| address | \`${wallet.address}\` |`,
    `| created | ${wallet.created || "unknown"} |`,
    `| funded | ${wallet.funded ? "yes" : "no"} |`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
