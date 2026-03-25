import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const listSecretsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListSecrets(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/secrets`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "listing secrets");

  const body = res.body as { secrets: Array<{ key: string; value_hash?: string }> };

  if (body.secrets.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `## Secrets\n\n_No secrets set. Use \`set_secret\` to add one._`,
        },
      ],
    };
  }

  const lines = [
    `## Secrets (${body.secrets.length})`,
    ``,
    `| Key | Hash |`,
    `|-----|------|`,
    ...body.secrets.map((s) => `| \`${s.key}\` | ${s.value_hash ? `\`${s.value_hash}\`` : "—"} |`),
    ``,
    `_Hash is the first 8 hex chars of SHA-256 — use it to verify the correct value was set._`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
