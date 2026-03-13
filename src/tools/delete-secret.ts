import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const deleteSecretSchema = {
  project_id: z.string().describe("The project ID"),
  key: z.string().describe("Secret key to delete"),
};

export async function handleDeleteSecret(args: {
  project_id: string;
  key: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(
    `/projects/v1/admin/${args.project_id}/secrets/${encodeURIComponent(args.key)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${project.service_key}`,
      },
    },
  );

  if (!res.ok) return formatApiError(res, "deleting secret");

  return {
    content: [
      {
        type: "text",
        text: `Secret \`${args.key}\` deleted from project \`${args.project_id}\`.`,
      },
    ],
  };
}
