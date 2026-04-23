import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const aiModerateSchema = {
  project_id: z.string().describe("The project ID"),
  text: z.string().describe("Text content to check for moderation"),
};

export async function handleAiModerate(args: {
  project_id: string;
  text: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().ai.moderate(args.project_id, args.text);

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
  } catch (err) {
    return mapSdkError(err, "moderating content");
  }
}
