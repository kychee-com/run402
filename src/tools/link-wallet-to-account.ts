import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const linkWalletToAccountSchema = {
  billing_account_id: z.string().describe("The billing account ID (from create_email_billing_account)"),
  wallet: z.string().describe("The wallet address to link (0x...)"),
};

export async function handleLinkWalletToAccount(args: {
  billing_account_id: string;
  wallet: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().billing.linkWallet(args.billing_account_id, args.wallet);
    return {
      content: [{
        type: "text",
        text: `## Wallet Linked\n\n- **Billing account:** \`${args.billing_account_id}\`\n- **Wallet:** \`${args.wallet.toLowerCase()}\`\n\nThe account now supports both Stripe checkout and x402 on-chain payments.`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "linking wallet");
  }
}
