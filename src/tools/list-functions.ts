import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) {
    const abs = -diff;
    if (abs < 60_000) return "in <1m";
    if (abs < 3_600_000) return `in ${Math.round(abs / 60_000)}m`;
    if (abs < 86_400_000) return `in ${Math.round(abs / 3_600_000)}h`;
    return `in ${Math.round(abs / 86_400_000)}d`;
  }
  if (diff < 60_000) return "<1m ago";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export const listFunctionsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListFunctions(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/functions`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "listing functions");

  const body = res.body as {
    functions: Array<{
      name: string;
      url: string;
      runtime: string;
      timeout: number;
      memory: number;
      schedule?: string | null;
      schedule_meta?: {
        last_run_at?: string;
        last_status?: number;
        next_run_at?: string;
        run_count?: number;
        last_error?: string | null;
      } | null;
      created_at: string;
      updated_at: string;
    }>;
  };

  if (body.functions.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `## Functions\n\n_No functions deployed. Use \`deploy_function\` to deploy one._`,
        },
      ],
    };
  }

  const lines = [
    `## Functions (${body.functions.length})`,
    ``,
    `| Name | URL | Runtime | Schedule | Next Run | Last Run | Runs | Status |`,
    `|------|-----|---------|----------|----------|----------|------|--------|`,
  ];

  const errors: string[] = [];

  for (const fn of body.functions) {
    const meta = fn.schedule_meta;
    const schedule = fn.schedule ? `\`${fn.schedule}\`` : "—";
    const nextRun = meta?.next_run_at ? formatRelative(meta.next_run_at) : "—";
    const lastRun = meta?.last_run_at ? formatRelative(meta.last_run_at) : "—";
    const runs = meta?.run_count != null ? String(meta.run_count) : "—";
    const status = meta?.last_status != null ? String(meta.last_status) : "—";
    lines.push(
      `| ${fn.name} | ${fn.url} | ${fn.runtime} | ${schedule} | ${nextRun} | ${lastRun} | ${runs} | ${status} |`,
    );
    if (meta?.last_error) {
      errors.push(`**${fn.name}**: ${meta.last_error}`);
    }
  }

  if (errors.length > 0) {
    lines.push(``);
    lines.push(`### Schedule Errors`);
    for (const err of errors) {
      lines.push(`- ${err}`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
