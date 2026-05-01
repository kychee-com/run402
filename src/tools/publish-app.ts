import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const publishAppSchema = {
  project_id: z.string().describe("The project ID to publish"),
  description: z.string().optional().describe("App description"),
  tags: z.array(z.string()).optional().describe("Tags for discoverability (e.g. ['auth', 'rls', 'todo'])"),
  visibility: z
    .enum(["public", "unlisted", "private"])
    .optional()
    .describe("Visibility: public (listed in browse_apps), unlisted (accessible by ID), private (default)"),
  fork_allowed: z
    .boolean()
    .optional()
    .describe("Whether other users can fork this app (default: false)"),
};

export async function handlePublishApp(args: {
  project_id: string;
  description?: string;
  tags?: string[];
  visibility?: string;
  fork_allowed?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().apps.publish(args.project_id, {
      description: args.description,
      tags: args.tags,
      visibility: args.visibility as "public" | "unlisted" | "private" | undefined,
      fork_allowed: args.fork_allowed,
    });

    const lines = [
      `## App Published`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| version_id | \`${body.id}\` |`,
      `| project | \`${body.project_id}\` |`,
      `| name | ${body.name} |`,
      `| visibility | ${body.visibility} |`,
      `| forkable | ${body.fork_allowed ? "Yes" : "No"} |`,
      `| tags | ${body.tags.length > 0 ? body.tags.join(", ") : "-"} |`,
    ];

    if (body.fork_allowed && body.visibility === "public") {
      lines.push(``);
      lines.push(`This app is now listed in \`browse_apps\` and can be forked by other users.`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "publishing app");
  }
}
