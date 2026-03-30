import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const promoteUserSchema = {
  project_id: z.string().describe("The project ID"),
  email: z.string().describe("Email address of the user to promote to project_admin"),
};

export async function handlePromoteUser(args: {
  project_id: string;
  email: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/promote-user`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
    body: {
      email: args.email,
    },
  });

  if (!res.ok) return formatApiError(res, "promoting user");

  return {
    content: [
      {
        type: "text",
        text: `## User Promoted\n\n\`${args.email}\` is now a project admin for project \`${args.project_id}\`.\n\nThey can manage secrets from the browser using the \`project_admin\` role.`,
      },
    ],
  };
}
