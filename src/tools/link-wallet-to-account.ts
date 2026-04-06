import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

export const linkWalletToAccountSchema = {
  billing_account_id: z.string().describe("The billing account ID (from create_email_billing_account)"),
  wallet: z.string().describe("The wallet address to link (0x...)"),
};

export async function handleLinkWalletToAccount(args: {
  billing_account_id: string;
  wallet: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await apiRequest(`/billing/v1/accounts/${args.billing_account_id}/link-wallet`, {
    method: "POST",
    body: { wallet: args.wallet },
  });

  if (!res.ok) return formatApiError(res, "linking wallet");

  return {
    content: [{
      type: "text",
      text: `## Wallet Linked\n\n- **Billing account:** \`${args.billing_account_id}\`\n- **Wallet:** \`${args.wallet.toLowerCase()}\`\n\nThe account now supports both Stripe checkout and x402 on-chain payments.`,
    }],
  };
}
