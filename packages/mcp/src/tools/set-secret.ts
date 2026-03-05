import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";

export const setSecretSchema = {
  project_id: z.string().describe("The project ID"),
  key: z
    .string()
    .describe("Secret key (uppercase alphanumeric + underscores, e.g. 'STRIPE_SECRET_KEY')"),
  value: z
    .string()
    .describe("Secret value (will be injected as process.env in functions)"),
};

export async function handleSetSecret(args: {
  project_id: string;
  key: string;
  value: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Project \`${args.project_id}\` not found in key store. Provision a project first with \`provision_postgres_project\`.`,
        },
      ],
      isError: true,
    };
  }

  const res = await apiRequest(`/admin/v1/projects/${args.project_id}/secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
    body: {
      key: args.key,
      value: args.value,
    },
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
    content: [
      {
        type: "text",
        text: `## Secret Set\n\nSecret \`${args.key}\` has been set for project \`${args.project_id}\`.\n\nAccess it in your functions via \`process.env.${args.key}\`.`,
      },
    ],
  };
}
