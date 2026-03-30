import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const updateFunctionSchema = {
  project_id: z.string().describe("The project ID"),
  name: z.string().describe("Function name to update"),
  schedule: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Cron expression (5-field, e.g. '*/15 * * * *') to set or update the schedule. Pass null to remove an existing schedule.",
    ),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in seconds (tier limits apply)"),
  memory: z
    .number()
    .optional()
    .describe("Memory in MB (tier limits apply)"),
};

export async function handleUpdateFunction(args: {
  project_id: string;
  name: string;
  schedule?: string | null;
  timeout?: number;
  memory?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const body: Record<string, unknown> = {};
  if (args.schedule !== undefined) body.schedule = args.schedule;
  if (args.timeout !== undefined || args.memory !== undefined) {
    const config: Record<string, number> = {};
    if (args.timeout !== undefined) config.timeout = args.timeout;
    if (args.memory !== undefined) config.memory = args.memory;
    body.config = config;
  }

  const res = await apiRequest(
    `/projects/v1/admin/${args.project_id}/functions/${encodeURIComponent(args.name)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${project.service_key}`,
      },
      body,
    },
  );

  if (!res.ok) return formatApiError(res, "updating function");

  const result = res.body as {
    name: string;
    runtime: string;
    timeout: number;
    memory: number;
    schedule: string | null;
    schedule_meta: Record<string, unknown> | null;
    updated_at: string;
  };

  const lines = [
    `## Function Updated`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| name | \`${result.name}\` |`,
    `| runtime | ${result.runtime} |`,
    `| timeout | ${result.timeout}s |`,
    `| memory | ${result.memory}MB |`,
    `| schedule | ${result.schedule ? `\`${result.schedule}\`` : "—"} |`,
    `| updated_at | ${result.updated_at} |`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
