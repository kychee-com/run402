import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";

export const claimSubdomainSchema = {
  name: z
    .string()
    .describe("Custom subdomain name (e.g. 'myapp' → myapp.run402.com). 3-63 chars, lowercase alphanumeric + hyphens."),
  deployment_id: z
    .string()
    .describe("Deployment ID to point this subdomain at (e.g. 'dpl_1709337600000_a1b2c3')"),
  project_id: z
    .string()
    .optional()
    .describe("Optional project ID for ownership tracking. Uses stored service_key for auth."),
};

export async function handleClaimSubdomain(args: {
  name: string;
  deployment_id: string;
  project_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let authHeader: Record<string, string> = {};

  if (args.project_id) {
    const project = getProject(args.project_id);
    if (!project) {
      return {
        content: [{ type: "text", text: `Error: Project "${args.project_id}" not found in key store. Provision a project first.` }],
        isError: true,
      };
    }
    authHeader = { Authorization: `Bearer ${project.service_key}` };
  }

  const res = await apiRequest("/v1/subdomains", {
    method: "POST",
    headers: authHeader,
    body: { name: args.name, deployment_id: args.deployment_id },
  });

  if (!res.ok) {
    const body = res.body as Record<string, unknown>;
    const msg = (body.error as string) || `HTTP ${res.status}`;
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }

  const body = res.body as {
    name: string;
    deployment_id: string;
    url: string;
    deployment_url: string;
    project_id: string | null;
    created_at: string;
    updated_at: string;
  };

  const lines = [
    `## Subdomain Claimed`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| subdomain | \`${body.name}\` |`,
    `| url | ${body.url} |`,
    `| deployment | \`${body.deployment_id}\` |`,
    `| deployment_url | ${body.deployment_url} |`,
    ``,
    `The site is now live at **${body.url}**`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export const deleteSubdomainSchema = {
  name: z
    .string()
    .describe("Subdomain name to release (e.g. 'myapp')"),
  project_id: z
    .string()
    .optional()
    .describe("Optional project ID for ownership verification. Uses stored service_key for auth."),
};

export async function handleDeleteSubdomain(args: {
  name: string;
  project_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let authHeader: Record<string, string> = {};

  if (args.project_id) {
    const project = getProject(args.project_id);
    if (!project) {
      return {
        content: [{ type: "text", text: `Error: Project "${args.project_id}" not found in key store. Provision a project first.` }],
        isError: true,
      };
    }
    authHeader = { Authorization: `Bearer ${project.service_key}` };
  }

  const res = await apiRequest(`/v1/subdomains/${encodeURIComponent(args.name)}`, {
    method: "DELETE",
    headers: authHeader,
  });

  if (!res.ok) {
    const body = res.body as Record<string, unknown>;
    const msg = (body.error as string) || `HTTP ${res.status}`;
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `## Subdomain Released\n\nSubdomain \`${args.name}\` has been deleted. The URL \`https://${args.name}.run402.com\` is no longer active.` }],
  };
}
