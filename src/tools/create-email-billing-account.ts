import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

export const createEmailBillingAccountSchema = {
  email: z.string().describe("Email address to create a billing account for (Stripe-only, no wallet)"),
};

export async function handleCreateEmailBillingAccount(args: {
  email: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await apiRequest(`/billing/v1/accounts`, {
    method: "POST",
    body: { email: args.email },
  });

  if (!res.ok) return formatApiError(res, "creating email billing account");

  const body = res.body as {
    id: string;
    email: string;
    email_credits_remaining: number;
    verification_sent: boolean;
  };

  return {
    content: [{
      type: "text",
      text: `## Email Billing Account Created\n\n- **Account ID:** \`${body.id}\`\n- **Email:** ${body.email}\n- **Email credits:** ${body.email_credits_remaining}\n${body.verification_sent ? "\nA verification email has been sent. Check your inbox." : ""}\n\nThis account can pay via Stripe for tier subscriptions and email packs. To add on-chain x402 access later, link a wallet with \`link_wallet_to_account\`.`,
    }],
  };
}
