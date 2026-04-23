import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const billingHistorySchema = {
  wallet: z.string().describe("Wallet address (0x...) to get billing history for"),
  limit: z.number().optional().describe("Max entries to return (default: 20)"),
};

export async function handleBillingHistory(args: {
  wallet: string;
  limit?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const wallet = args.wallet.toLowerCase();

  try {
    const body = await getSdk().billing.history(wallet, args.limit);

    if (body.entries.length === 0) {
      return {
        content: [{ type: "text", text: `## Billing History: ${wallet}\n\n_No transactions found._` }],
      };
    }

    const lines = [
      `## Billing History: ${wallet} (${body.entries.length} entries)`,
      ``,
      `| Date | Direction | Kind | Amount | Balance After |`,
      `|------|-----------|------|--------|---------------|`,
    ];

    for (const e of body.entries) {
      const amount = (e.amount_usd_micros / 1_000_000).toFixed(2);
      const balance = (e.balance_after_available / 1_000_000).toFixed(2);
      lines.push(`| ${e.created_at} | ${e.direction} | ${e.kind} | $${amount} | $${balance} |`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching billing history");
  }
}
