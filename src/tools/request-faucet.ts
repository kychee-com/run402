import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

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
  try {
    const body = await getSdk().allowance.faucet(args.address);

    const addressLine = args.address
      ? args.address
      : (await getSdk().allowance.status()).address;

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
      `Agent allowance funded with testnet USDC. You can now provision databases and deploy sites.`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/no address provided/i.test(msg) || /no agent allowance is configured/i.test(msg)) {
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
    return mapSdkError(err, "requesting faucet funds");
  }
}
