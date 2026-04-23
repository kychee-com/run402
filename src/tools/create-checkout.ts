import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const createCheckoutSchema = {
  wallet: z.string().describe("Wallet address (0x...) to fund"),
  amount_usd_micros: z.number().describe("Amount in micro-USD (e.g. 5000000 = $5.00)"),
};

export async function handleCreateCheckout(args: {
  wallet: string;
  amount_usd_micros: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().billing.createCheckout(args.wallet, args.amount_usd_micros);

    const amountUsd = (args.amount_usd_micros / 1_000_000).toFixed(2);

    const lines = [
      `## Checkout Created`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| amount | $${amountUsd} |`,
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
