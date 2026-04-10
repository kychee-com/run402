import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const enableInboundSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The custom sender domain to enable inbound on (must be DKIM-verified)"),
};

export async function handleEnableInbound(args: {
  project_id: string;
  domain: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(
    `/email/v1/domains/inbound`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: { domain: args.domain },
    },
  );

  if (!res.ok) return formatApiError(res, "enabling inbound email");

  const body = res.body as { status: string; mx_record?: string };

  const lines = [
    `## Inbound email enabled on \`${args.domain}\``,
    ``,
    `- **Status:** ${body.status}`,
    body.mx_record ? `- **MX record to add:** \`${body.mx_record}\`` : "",
    ``,
    `Add the MX record to your DNS provider. Replies to \`<slug>@${args.domain}\` will route through run402's inbound pipeline.`,
  ].filter(Boolean);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
