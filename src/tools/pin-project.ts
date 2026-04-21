import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const pinProjectSchema = {
  project_id: z.string().describe("The project ID to pin"),
};

export async function handlePinProject(
  args: { project_id: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/pin`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "pinning project");

  const body = res.body as { status: string; project_id: string; message?: string };

  return {
    content: [
      {
        type: "text",
        text: `Project \`${args.project_id}\` pinned successfully.${body.message ? ` ${body.message}` : ""}`,
      },
    ],
  };
}
