import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const checkBalanceSchema = {
  wallet: z
    .string()
    .describe("Wallet address (0x...) to check billing balance for"),
};

export async function handleCheckBalance(args: {
  wallet: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const wallet = args.wallet.toLowerCase();

  try {
    const body = await getSdk().billing.checkBalance(wallet);

    const availableUsd = (body.available_usd_micros / 1_000_000).toFixed(2);

    const lines = [
      `## Billing: ${wallet}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| available | $${availableUsd} |`,
      `| email credits | ${body.email_credits_remaining} |`,
      `| tier | ${body.tier ?? "(none)"} |`,
      `| lease expires | ${body.lease_expires_at ?? "(none)"} |`,
      `| auto-recharge | ${body.auto_recharge_enabled ? `at $${(body.auto_recharge_threshold / 1_000_000).toFixed(2)}` : "off"} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "checking balance");
  }
}
