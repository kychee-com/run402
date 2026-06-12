import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const createCheckoutSchema = {
  org_id: z.string().describe("Organization ID to bill"),
  product: z.enum(["balance_topup", "tier", "email_pack"]).describe("Checkout product"),
  amount_usd_micros: z.number().optional().describe("Required for product=balance_topup; amount in micro-USD (e.g. 5000000 = $5.00)"),
  tier: z.enum(["prototype", "hobby", "team"]).optional().describe("Required for product=tier"),
  success_url: z.string().optional().describe("Optional checkout success redirect URL"),
  cancel_url: z.string().optional().describe("Optional checkout cancel redirect URL"),
};

export async function handleCreateCheckout(args: {
  org_id: string;
  product: "balance_topup" | "tier" | "email_pack";
  amount_usd_micros?: number;
  tier?: "prototype" | "hobby" | "team";
  success_url?: string;
  cancel_url?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const common = {
    successUrl: args.success_url,
    cancelUrl: args.cancel_url,
  };
  const checkout =
    args.product === "balance_topup"
      ? args.amount_usd_micros === undefined
        ? null
        : { product: "balance_topup" as const, amountUsdMicros: args.amount_usd_micros, ...common }
      : args.product === "tier"
        ? args.tier === undefined
          ? null
          : { product: "tier" as const, tier: args.tier, ...common }
        : { product: "email_pack" as const, ...common };

  if (!checkout) {
    const required = args.product === "balance_topup" ? "amount_usd_micros" : "tier";
    return {
      content: [{ type: "text", text: `Error: product=${args.product} requires \`${required}\`.` }],
      isError: true,
    };
  }

  try {
    const body = await getSdk().billing.createCheckout(args.org_id, checkout);
    const amountUsd = args.amount_usd_micros === undefined
      ? null
      : (args.amount_usd_micros / 1_000_000).toFixed(2);

    const lines = [
      `## Checkout Created`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| organization | \`${body.organization_id}\` |`,
      `| product | ${body.product} |`,
      ...(amountUsd ? [`| amount | $${amountUsd} |`] : []),
      ...(args.tier ? [`| tier | ${args.tier} |`] : []),
      `| checkout_url | ${body.checkout_url} |`,
      `| topup_id | ${body.topup_id} |`,
      ``,
      `Share the checkout URL with your human to complete payment via Stripe.`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "creating checkout");
  }
}
