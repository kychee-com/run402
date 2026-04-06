import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

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

  const body: Record<string, string> = {};
  if (args.wallet) body.wallet = args.wallet;
  else if (args.email) body.email = args.email;

  const res = await apiRequest(`/billing/v1/tiers/${args.tier}/checkout`, {
    method: "POST",
    body,
  });

  if (!res.ok) return formatApiError(res, "creating tier checkout");

  const result = res.body as { checkout_url: string; topup_id: string };
  return {
    content: [{
      type: "text",
      text: `## Tier Checkout Created\n\n- **Tier:** ${args.tier}\n- **Topup ID:** \`${result.topup_id}\`\n\n**Send your human to complete payment:**\n${result.checkout_url}\n\nOn successful payment, the ${args.tier} tier will be applied automatically (subscribe, renew, or upgrade with prorated refund).`,
    }],
  };
}
