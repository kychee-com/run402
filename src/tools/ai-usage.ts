import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const aiUsageSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleAiUsage(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/ai/v1/usage`, {
    method: "GET",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });

  if (!res.ok) return formatApiError(res, "fetching AI usage");

  const body = res.body as {
    translation: {
      active: boolean;
      used_words: number;
      included_words: number;
      remaining_words: number;
      billing_cycle_start: string;
    };
  };

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
}
