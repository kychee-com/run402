import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { isToolAvailable } from "../tool-profiles.js";

export const requestFaucetSchema = {
  address: z
    .string()
    .optional()
    .describe(
      "Wallet address (0x...) to fund. If omitted, reads from local agent wallet file.",
    ),
};

export async function handleRequestFaucet(args: {
  address?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().wallets.faucet(args.address);

    const addressLine = args.address
      ? args.address
      : (await getSdk().wallets.status()).address;

    const lines = [
      `## Faucet Funded`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| address | \`${addressLine}\` |`,
      `| amount | ${body.amount} ${body.token} |`,
      `| network | ${body.network} |`,
      `| tx | \`${body.transactionHash}\` |`,
      ``,
      `Agent wallet funded with testnet USDC. You can now provision databases and deploy sites.`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/no address provided/i.test(msg) || /no (local|agent) wallet is configured/i.test(msg)) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No address provided and no local agent wallet found. " +
              (isToolAvailable("wallet_create")
                ? "Use `wallet_create` to create a wallet first, or pass an `address` parameter."
                : "Use `init` to create and fund a wallet, or pass an `address` parameter."),
          },
        ],
        isError: true,
      };
    }
    return mapSdkError(err, "requesting faucet funds");
  }
}
