import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

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
    `| Name | URL | Runtime | Timeout | Memory |`,
    `|------|-----|---------|---------|--------|`,
  ];

  for (const fn of body.functions) {
    lines.push(
      `| ${fn.name} | ${fn.url} | ${fn.runtime} | ${fn.timeout}s | ${fn.memory}MB |`,
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
