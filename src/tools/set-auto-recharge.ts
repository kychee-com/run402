import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

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
  const body: Record<string, unknown> = {
    billing_account_id: args.billing_account_id,
    enabled: args.enabled,
  };
  if (args.threshold !== undefined) body.threshold = args.threshold;

  const res = await apiRequest(`/billing/v1/email-packs/auto-recharge`, {
    method: "POST",
    body,
  });

  if (!res.ok) return formatApiError(res, "setting auto-recharge");

  return {
    content: [{
      type: "text",
      text: `## Auto-Recharge ${args.enabled ? "Enabled" : "Disabled"}\n\n- **Account:** \`${args.billing_account_id}\`\n${args.threshold ? `- **Threshold:** ${args.threshold} credits\n` : ""}${args.enabled ? "\nA new \$5 email pack will be charged automatically when credits drop below the threshold. Requires a saved Stripe payment method. 3 consecutive failures will auto-disable.\n" : ""}`,
    }],
  };
}
