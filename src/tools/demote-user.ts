import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const demoteUserSchema = {
  project_id: z.string().describe("The project ID"),
  email: z.string().describe("Email address of the user to demote from project_admin"),
};

export async function handleDemoteUser(args: {
  project_id: string;
  email: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/demote-user`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
    body: {
      email: args.email,
    },
  });

  if (!res.ok) return formatApiError(res, "demoting user");

  return {
    content: [
      {
        type: "text",
        text: `## User Demoted\n\n\`${args.email}\` is no longer a project admin for project \`${args.project_id}\`.\n\nTheir role has been reverted to the default authenticated role.`,
      },
    ],
  };
}
