import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const setAutoRechargeSchema = {
  billing_account_id: z.string().describe("The billing account ID"),
  enabled: z.boolean().describe("Enable (true) or disable (false) auto-recharge"),
  threshold: z.number().optional().describe("Credit threshold to trigger auto-recharge (default 2000)"),
};

export async function handleSetAutoRecharge(args: {
  billing_account_id: string;
  enabled: boolean;
  threshold?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().billing.setAutoRecharge({
      billingAccountId: args.billing_account_id,
      enabled: args.enabled,
      threshold: args.threshold,
    });
    return {
      content: [{
        type: "text",
        text: `## Auto-Recharge ${args.enabled ? "Enabled" : "Disabled"}\n\n- **Account:** \`${args.billing_account_id}\`\n${args.threshold ? `- **Threshold:** ${args.threshold} credits\n` : ""}${args.enabled ? "\nA new \$5 email pack will be charged automatically when credits drop below the threshold. Requires a saved Stripe payment method. 3 consecutive failures will auto-disable.\n" : ""}`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "setting auto-recharge");
  }
}
