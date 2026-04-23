import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const aiUsageSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleAiUsage(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().ai.usage(args.project_id);

    const t = body.translation;
    const usedPct = t.included_words > 0
      ? ((t.used_words / t.included_words) * 100).toFixed(1)
      : "0.0";

    const lines = [
      `## AI Translation Usage`,
      ``,
      `**Status:** ${t.active ? "Active" : "Inactive"}`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Used words | ${t.used_words.toLocaleString()} |`,
      `| Included words | ${t.included_words.toLocaleString()} |`,
      `| Remaining words | ${t.remaining_words.toLocaleString()} |`,
      `| Usage | ${usedPct}% |`,
      `| Billing cycle start | ${t.billing_cycle_start} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching AI usage");
  }
}
