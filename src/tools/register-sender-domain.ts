import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const registerSenderDomainSchema = {
  project_id: z.string().describe("The project ID"),
  domain: z.string().describe("The domain to register for email sending (e.g., 'kysigned.com')"),
};

export async function handleRegisterSenderDomain(args: {
  project_id: string;
  domain: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/email/v1/domains`, {
    method: "POST",
    headers: { apikey: project.service_key },
    body: { domain: args.domain },
  });

  if (!res.ok) return formatApiError(res, "registering sender domain");

  const body = res.body as { domain: string; status: string; dns_records: Array<{ type: string; name: string; value: string }>; instructions: string };
  const dnsTable = body.dns_records.map(r => `| ${r.type} | \`${r.name}\` | \`${r.value}\` |`).join("\n");

  return {
    content: [{
      type: "text",
      text: `## Sender Domain Registered\n\n- **Domain:** ${body.domain}\n- **Status:** ${body.status}\n\n### DNS Records to Add\n\n| Type | Name | Value |\n|------|------|-------|\n${dnsTable}\n\n${body.instructions}`,
    }],
  };
}
