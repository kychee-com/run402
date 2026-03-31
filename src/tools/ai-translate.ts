import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const aiTranslateSchema = {
  project_id: z.string().describe("The project ID"),
  text: z.string().max(10000).describe("Text to translate (max 10,000 characters)"),
  to: z.string().describe("Target language (ISO 639-1 code, e.g. 'es', 'ja', 'fr')"),
  from: z.string().optional().describe("Source language (ISO 639-1 code). Auto-detected if omitted"),
  context: z.string().max(200).optional().describe("Context hint for tone/register (max 200 chars, e.g. 'formal business email')"),
};

export async function handleAiTranslate(args: {
  project_id: string;
  text: string;
  to: string;
  from?: string;
  context?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const body: Record<string, string> = { text: args.text, to: args.to };
  if (args.from) body.from = args.from;
  if (args.context) body.context = args.context;

  const res = await apiRequest(`/ai/v1/translate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${project.service_key}` },
    body,
  });

  if (res.status === 402) {
    const resBody = res.body as Record<string, unknown>;
    const message = (resBody.message as string) || "AI Translation add-on required or quota exceeded";
    const lines = [
      `## Translation Unavailable`,
      ``,
      `${message}`,
      ``,
      `This is not a payment — the AI Translation add-on must be enabled on the project, or the word quota for the current billing cycle has been exceeded.`,
      ``,
      `Use \`ai_usage\` to check current quota, or enable the add-on from the project dashboard.`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (!res.ok) return formatApiError(res, "translating text");

  const resBody = res.body as { text: string; from: string; to: string };

  const lines = [
    `## Translation`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| from | ${resBody.from} |`,
    `| to | ${resBody.to} |`,
    ``,
    resBody.text,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
