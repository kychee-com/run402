import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const aiModerateSchema = {
  project_id: z.string().describe("The project ID"),
  text: z.string().describe("Text content to check for moderation"),
};

export async function handleAiModerate(args: {
  project_id: string;
  text: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/ai/v1/moderate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${project.service_key}` },
    body: { text: args.text },
  });

  if (!res.ok) return formatApiError(res, "moderating content");

  const body = res.body as {
    flagged: boolean;
    categories: Record<string, boolean>;
    category_scores: Record<string, number>;
  };

  const status = body.flagged ? "FLAGGED" : "OK";
  const lines = [
    `## Moderation Result: ${status}`,
    ``,
    `| Category | Flagged | Score |`,
    `|----------|---------|-------|`,
  ];

  for (const [category, flagged] of Object.entries(body.categories)) {
    const score = body.category_scores[category] ?? 0;
    const flag = flagged ? "YES" : "no";
    lines.push(`| ${category} | ${flag} | ${score.toFixed(4)} |`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
