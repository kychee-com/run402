import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const redeemVoucherSchema = {
  code: z
    .string()
    .describe(
      "The promo code, e.g. R402-K8F3-Q2W9. Case-insensitive and hyphens are optional — pass it exactly as you were given it; the server normalizes.",
    ),
};

export async function handleRedeemVoucher(args: {
  code: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().vouchers.redeem(args.code);
    const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

    const lines = [
      body.already_redeemed ? `## Promo Code Already Redeemed` : `## Promo Code Redeemed`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| credited | ${usd(body.amount_usd_micros)} |`,
      `| balance | ${usd(body.balance_usd_micros)} available |`,
      `| organization | \`${body.organization_id}\` |`,
      `| redeemed_at | ${body.redeemed_at} |`,
      ``,
      // Faithful: a replay is reported as a replay. Rendering it as a fresh
      // credit would tell the agent its balance just grew when it did not.
      body.already_redeemed
        ? `This organization had already redeemed this code — the original credit stands and no second credit was made.`
        : `Credit is on the organization's prepaid balance and spends like any other prepaid credit.`,
    ];

    // Anticipatory: the single highest-probability next call after money
    // arrives is spending it, and the gateway already named the exact command.
    const next = body.next_actions?.find((a) => typeof a?.cli === "string");
    if (next) {
      lines.push(``, `**Next:** \`${next.cli}\`${next.why ? ` — ${next.why}` : ""}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "redeeming a promo code");
  }
}
