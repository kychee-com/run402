import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

export const getAppSchema = {
  version_id: z.string().describe("The version ID of the app to inspect"),
};

export async function handleGetApp(args: {
  version_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await apiRequest(`/apps/v1/${args.version_id}`, {
    method: "GET",
  });

  if (!res.ok) return formatApiError(res, "fetching app details");

  const body = res.body as {
    id: string;
    project_name: string;
    description: string | null;
    tags: string[];
    fork_allowed: boolean;
    min_tier: string;
    table_count: number;
    function_count: number;
    site_file_count: number;
    required_secrets: Array<{ key: string; description: string }>;
    created_at: string;
  };

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
}
