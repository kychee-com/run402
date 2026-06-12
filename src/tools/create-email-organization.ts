import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const createEmailOrganizationSchema = {
  email: z.string().describe("Email address to create an organization for (Stripe-only, no wallet)"),
};

export async function handleCreateEmailOrganization(args: {
  email: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().billing.createEmailOrganization(args.email);

    return {
      content: [{
        type: "text",
        text: `## Email Organization Created\n\n- **Organization ID:** \`${body.id}\`\n- **Email:** ${body.email}\n- **Email credits:** ${body.email_credits_remaining}\n${body.verification_sent ? "\nA verification email has been sent. Check your inbox." : ""}\n\nThis organization can pay via Stripe for tier subscriptions and email packs. To add on-chain x402 access later, link a wallet with \`link_wallet_to_organization\`.`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "creating email organization");
  }
}
