import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const senderDomainStatusSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleSenderDomainStatus(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/email/v1/domains`, {
    method: "GET",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });

  if (!res.ok) return formatApiError(res, "checking sender domain status");

  const body = res.body as { domain: string | null; status?: string; verified_at?: string };

  if (!body.domain) {
    return { content: [{ type: "text", text: "## No Sender Domain\n\nNo custom sender domain registered. Email sends from `@mail.run402.com`. Use `register_sender_domain` to set up a custom domain." }] };
  }

  return {
    content: [{
      type: "text",
      text: `## Sender Domain Status\n\n- **Domain:** ${body.domain}\n- **Status:** ${body.status}\n${body.verified_at ? `- **Verified:** ${body.verified_at}\n` : ""}\n${body.status === "pending" ? "Add the DKIM CNAME records to your DNS and check again. Verification usually takes a few minutes." : "Domain is verified. All outbound email sends from this domain."}`,
    }],
  };
}
