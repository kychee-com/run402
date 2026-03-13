import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const deleteFunctionSchema = {
  project_id: z.string().describe("The project ID"),
  name: z.string().describe("Function name to delete"),
};

export async function handleDeleteFunction(args: {
  project_id: string;
  name: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(
    `/projects/v1/admin/${args.project_id}/functions/${encodeURIComponent(args.name)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${project.service_key}`,
      },
    },
  );

  if (!res.ok) return formatApiError(res, "deleting function");

  return {
    content: [
      {
        type: "text",
        text: `Function \`${args.name}\` deleted from project \`${args.project_id}\`.`,
      },
    ],
  };
}
