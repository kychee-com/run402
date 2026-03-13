import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

export const checkBalanceSchema = {
  wallet: z
    .string()
    .describe("Wallet address (0x...) to check billing balance for"),
};

export async function handleCheckBalance(args: {
  wallet: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const wallet = args.wallet.toLowerCase();

  const res = await apiRequest(`/billing/v1/accounts/${wallet}`, {
    method: "GET",
  });

  if (!res.ok) return formatApiError(res, "checking balance");

  const body = res.body as {
    wallet: string;
    exists: boolean;
    available_usd_micros: number;
    held_usd_micros: number;
    status?: string;
  };

  if (!body.exists) {
    return {
      content: [
        {
          type: "text",
          text: `## Billing: ${wallet}\n\nNo billing account found. Top up via Stripe or on-chain USDC to create one.`,
        },
      ],
    };
  }

  const availableUsd = (body.available_usd_micros / 1_000_000).toFixed(2);
  const heldUsd = (body.held_usd_micros / 1_000_000).toFixed(2);

  const lines = [
    `## Billing: ${wallet}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| available | $${availableUsd} |`,
    `| held | $${heldUsd} |`,
    `| status | ${body.status} |`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
