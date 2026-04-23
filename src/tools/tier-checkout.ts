import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const tierCheckoutSchema = {
  tier: z.enum(["prototype", "hobby", "team"]).describe("Tier name: prototype ($0.10/7d), hobby ($5/30d), team ($20/30d)"),
  email: z.string().optional().describe("Email address (for email-based accounts)"),
  wallet: z.string().optional().describe("Wallet address (for wallet-based accounts)"),
};

export async function handleTierCheckout(args: {
  tier: string;
  email?: string;
  wallet?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!args.email && !args.wallet) {
    return {
      content: [{ type: "text", text: "Error: Provide either `email` or `wallet`." }],
      isError: true,
    };
  }

  try {
    const result = await getSdk().billing.tierCheckout(args.tier, {
      email: args.email,
      wallet: args.wallet,
    });
    return {
      content: [{
        type: "text",
        text: `## Tier Checkout Created\n\n- **Tier:** ${args.tier}\n- **Topup ID:** \`${result.topup_id}\`\n\n**Send your human to complete payment:**\n${result.checkout_url}\n\nOn successful payment, the ${args.tier} tier will be applied automatically (subscribe, renew, or upgrade with prorated refund).`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "creating tier checkout");
  }
}
