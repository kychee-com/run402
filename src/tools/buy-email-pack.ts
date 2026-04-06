import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

export const buyEmailPackSchema = {
  email: z.string().optional().describe("Email address (for email-based accounts)"),
  wallet: z.string().optional().describe("Wallet address (for wallet-based accounts)"),
};

export async function handleBuyEmailPack(args: {
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

  const res = await apiRequest(`/billing/v1/email-packs/checkout`, {
    method: "POST",
    body,
  });

  if (!res.ok) return formatApiError(res, "creating email pack checkout");

  const result = res.body as { checkout_url: string; topup_id: string };
  return {
    content: [{
      type: "text",
      text: `## Email Pack Checkout Created\n\n**\$5 = 10,000 emails** (never expire)\n\n- **Topup ID:** \`${result.topup_id}\`\n\n**Send your human to complete payment:**\n${result.checkout_url}\n\nOnce paid, credits will be added to the account. Note: pack credits can only be consumed when the project has a verified custom sender domain (see \`register_sender_domain\`).`,
    }],
  };
}
