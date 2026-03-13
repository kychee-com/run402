import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const deleteVersionSchema = {
  project_id: z.string().describe("The project ID"),
  version_id: z.string().describe("The version ID to delete"),
};

export async function handleDeleteVersion(args: {
  project_id: string;
  version_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(
    `/projects/v1/admin/${args.project_id}/versions/${args.version_id}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.service_key}` },
    },
  );

  if (!res.ok) return formatApiError(res, "deleting version");

  return {
    content: [{ type: "text", text: `Version \`${args.version_id}\` deleted.` }],
  };
}
