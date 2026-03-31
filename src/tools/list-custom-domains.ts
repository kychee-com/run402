import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const listCustomDomainsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListCustomDomains(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest("/domains/v1", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "listing custom domains");

  const body = res.body as {
    domains: Array<{
      domain: string;
      subdomain_name: string;
      url: string;
      subdomain_url: string;
      status: string;
      created_at: string;
    }>;
  };

  const domains = body.domains;

  if (domains.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `## Custom Domains\n\n_No custom domains registered. Use \`add_custom_domain\` to register one._`,
        },
      ],
    };
  }

  const lines = [
    `## Custom Domains (${domains.length})`,
    ``,
    `| Domain | Subdomain | Status | Created |`,
    `|--------|-----------|--------|---------|`,
  ];

  for (const d of domains) {
    lines.push(`| ${d.domain} | ${d.subdomain_url} | ${d.status} | ${d.created_at} |`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
