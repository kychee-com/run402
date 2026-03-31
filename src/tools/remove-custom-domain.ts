import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const removeCustomDomainSchema = {
  domain: z.string().describe("The custom domain to release (e.g. 'example.com')"),
  project_id: z
    .string()
    .optional()
    .describe("Optional project ID for ownership verification"),
};

export async function handleRemoveCustomDomain(args: {
  domain: string;
  project_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let authHeader: Record<string, string> = {};

  if (args.project_id) {
    const project = getProject(args.project_id);
    if (!project) return projectNotFound(args.project_id);
    authHeader = { Authorization: `Bearer ${project.service_key}` };
  }

  const res = await apiRequest(`/domains/v1/${encodeURIComponent(args.domain)}`, {
    method: "DELETE",
    headers: authHeader,
  });

  if (!res.ok) return formatApiError(res, "removing custom domain");

  return {
    content: [
      {
        type: "text",
        text: `## Custom Domain Removed\n\nDomain \`${args.domain}\` has been released. Traffic to this domain will no longer be routed to Run402.`,
      },
    ],
  };
}
