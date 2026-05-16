import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getUsageSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleGetUsage(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().projects.getUsage(args.project_id);

    const storageMB = (body.storage_bytes / (1024 * 1024)).toFixed(1);
    const storageLimitMB = (body.storage_limit_bytes / (1024 * 1024)).toFixed(0);
    const apiPct = ((body.api_calls / body.api_calls_limit) * 100).toFixed(1);
    const storagePct = ((body.storage_bytes / body.storage_limit_bytes) * 100).toFixed(1);

    const lines = [
      `## Usage: \`${body.project_id}\``,
      ``,
      `Per-project usage. The tier and capacity limits below are account-level:`,
      `they are shared across every project on the same billing account. For the`,
      `pooled total across all projects on the account, call \`tier_status\` —`,
      `its \`pool_usage\` block is the authoritative quota-enforcement view.`,
      ``,
      `| Metric | Used (this project) | Account limit | % of account |`,
      `|--------|---------------------|---------------|--------------|`,
      `| API calls | ${body.api_calls.toLocaleString()} | ${body.api_calls_limit.toLocaleString()} | ${apiPct}% |`,
      `| Storage | ${storageMB}MB | ${storageLimitMB}MB | ${storagePct}% |`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| account tier | ${body.tier} |`,
      `| status | ${body.status} |`,
      `| expires | ${body.lease_expires_at} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching usage");
  }
}
