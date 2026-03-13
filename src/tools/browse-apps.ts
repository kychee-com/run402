import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

export const browseAppsSchema = {
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional tags to filter by (e.g. ['auth', 'rls'])"),
};

export async function handleBrowseApps(args: {
  tags?: string[];
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let path = "/apps/v1";
  if (args.tags && args.tags.length > 0) {
    const params = args.tags.map((t) => `tag=${encodeURIComponent(t)}`).join("&");
    path = `/apps/v1?${params}`;
  }

  const res = await apiRequest(path, { method: "GET" });

  if (!res.ok) return formatApiError(res, "browsing apps");

  const body = res.body as {
    apps: Array<{
      id: string;
      project_name: string;
      description: string | null;
      tags: string[];
      fork_allowed: boolean;
      fork_pricing?: Record<string, string>;
      created_at: string;
    }>;
    total: number;
  };

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
}
