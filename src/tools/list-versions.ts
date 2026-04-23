import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listVersionsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListVersions(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().apps.listVersions(args.project_id);

    if (body.versions.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Versions\n\n_No published versions. Use \`publish_app\` to publish one._`,
          },
        ],
      };
    }

    const lines = [
      `## Versions (${body.versions.length})`,
      ``,
      `| ID | Visibility | Forkable | Tags | Created |`,
      `|----|------------|----------|------|---------|`,
    ];

    for (const v of body.versions) {
      const tags = v.tags.length > 0 ? v.tags.join(", ") : "-";
      lines.push(
        `| \`${v.id}\` | ${v.visibility} | ${v.fork_allowed ? "Yes" : "No"} | ${tags} | ${v.created_at} |`,
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing versions");
  }
}
