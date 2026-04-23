import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const browseAppsSchema = {
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional tags to filter by (e.g. ['auth', 'rls'])"),
};

export async function handleBrowseApps(args: {
  tags?: string[];
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().apps.browse(args.tags);

    if (body.apps.length === 0) {
      return {
        content: [{ type: "text", text: `## Public Apps\n\n_No public apps found._` }],
      };
    }

    const lines = [
      `## Public Apps (${body.total})`,
      ``,
      `| Name | Description | Tags | Forkable |`,
      `|------|-------------|------|----------|`,
    ];

    for (const app of body.apps) {
      const tags = app.tags.length > 0 ? app.tags.join(", ") : "-";
      const desc = app.description || "-";
      lines.push(`| ${app.project_name} | ${desc} | ${tags} | ${app.fork_allowed ? "Yes" : "No"} |`);
    }

    lines.push(``);
    lines.push(`Use \`fork_app\` to fork any forkable app into your own project.`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "browsing apps");
  }
}
