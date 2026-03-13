import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const listVersionsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListVersions(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/versions`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "listing versions");

  const body = res.body as {
    versions: Array<{
      id: string;
      description: string | null;
      tags: string[];
      visibility: string;
      fork_allowed: boolean;
      created_at: string;
    }>;
  };

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
}
