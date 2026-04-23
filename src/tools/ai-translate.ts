import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { PaymentRequired } from "../../sdk/dist/index.js";

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
  try {
    const body = await getSdk().ai.translate(args.project_id, {
      text: args.text,
      to: args.to,
      from: args.from,
      context: args.context,
    });

    const lines = [
      `## Translation`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| from | ${body.from} |`,
      `| to | ${body.to} |`,
      ``,
      body.text,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    if (err instanceof PaymentRequired) {
      const resBody = (err.body ?? {}) as Record<string, unknown>;
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
    return mapSdkError(err, "translating text");
  }
}
