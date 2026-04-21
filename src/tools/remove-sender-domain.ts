import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const removeSenderDomainSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleRemoveSenderDomain(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/email/v1/domains`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });

  if (!res.ok) return formatApiError(res, "removing sender domain");

  return {
    content: [{
      type: "text",
      text: `## Sender Domain Removed\n\nCustom sender domain has been removed. Email will now send from \`@mail.run402.com\`.`,
    }],
  };
}
