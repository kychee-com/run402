import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";

export const getDeploymentSchema = {
  deployment_id: z.string().describe("Deployment ID (e.g. dpl_1709337600000_a1b2c3)"),
};

export async function handleGetDeployment(args: {
  deployment_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const res = await apiRequest(`/deployments/v1/${args.deployment_id}`, {
    method: "GET",
  });

  if (!res.ok) return formatApiError(res, "fetching deployment");

  const body = res.body as {
    id: string;
    name: string;
    url: string;
    project_id?: string;
    status: string;
    files_count: number;
    total_size: number;
  };

  const lines = [
    `## Deployment: ${body.id}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| name | ${body.name} |`,
    `| url | ${body.url} |`,
    `| status | ${body.status} |`,
    `| files | ${body.files_count} |`,
    `| size | ${body.total_size} bytes |`,
  ];

  if (body.project_id) {
    lines.push(`| project | \`${body.project_id}\` |`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
