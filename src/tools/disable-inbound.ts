import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const disableInboundSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The custom sender domain to disable inbound on"),
};

export async function handleDisableInbound(args: {
  project_id: string;
  domain: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(
    `/email/v1/domains/inbound`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: { domain: args.domain },
    },
  );

  if (!res.ok) return formatApiError(res, "disabling inbound email");

  return {
    content: [{
      type: "text",
      text: `Inbound email disabled on \`${args.domain}\`. Replies to this domain will no longer be delivered through run402.`,
    }],
  };
}
