import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const listSubdomainsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListSubdomains(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest("/subdomains/v1", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "listing subdomains");

  const subdomains = res.body as Array<{
    name: string;
    url: string;
    deployment_id: string;
    deployment_url: string;
  }>;

  if (subdomains.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `## Subdomains\n\n_No subdomains claimed. Use \`claim_subdomain\` to claim one._`,
        },
      ],
    };
  }

  const lines = [
    `## Subdomains (${subdomains.length})`,
    ``,
    `| Subdomain | URL | Deployment |`,
    `|-----------|-----|------------|`,
  ];

  for (const s of subdomains) {
    lines.push(`| ${s.name} | ${s.url} | \`${s.deployment_id}\` |`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
