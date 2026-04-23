import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

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

  try {
    const result = await getSdk().billing.buyEmailPack({ email: args.email, wallet: args.wallet });
    return {
      content: [{
        type: "text",
        text: `## Email Pack Checkout Created\n\n**\$5 = 10,000 emails** (never expire)\n\n- **Topup ID:** \`${result.topup_id}\`\n\n**Send your human to complete payment:**\n${result.checkout_url}\n\nOnce paid, credits will be added to the account. Note: pack credits can only be consumed when the project has a verified custom sender domain (see \`register_sender_domain\`).`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "creating email pack checkout");
  }
}
