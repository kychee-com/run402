import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getAppSchema = {
  version_id: z.string().describe("The version ID of the app to inspect"),
};

export async function handleGetApp(args: {
  version_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().apps.getApp(args.version_id);

    const lines = [
      `## App: ${body.project_name}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| version_id | \`${body.id}\` |`,
      `| description | ${body.description || "-"} |`,
      `| tags | ${body.tags.length > 0 ? body.tags.join(", ") : "-"} |`,
      `| forkable | ${body.fork_allowed ? "Yes" : "No"} |`,
      `| min_tier | ${body.min_tier} |`,
      `| tables | ${body.table_count} |`,
      `| functions | ${body.function_count} |`,
      `| site files | ${body.site_file_count} |`,
    ];

    if (body.required_secrets.length > 0) {
      lines.push(``);
      lines.push(`### Required Secrets`);
      lines.push(``);
      for (const s of body.required_secrets) {
        lines.push(`- **${s.key}**: ${s.description}`);
      }
    }

    if (body.fork_allowed) {
      lines.push(``);
      lines.push(`Use \`fork_app\` to fork this app into your own project.`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching app details");
  }
}
