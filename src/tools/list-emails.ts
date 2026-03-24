import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";
import { resolveMailboxId } from "./send-email.js";

export const listEmailsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListEmails(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const mailbox = await resolveMailboxId(args.project_id, project.service_key);
  if ("error" in mailbox) return mailbox.error;

  const res = await apiRequest(`/mailboxes/v1/${mailbox.id}/messages`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "listing emails");

  const body = res.body as Array<{
    id: string;
    template: string;
    to: string;
    status: string;
    created_at: string;
  }>;

  if (!Array.isArray(body) || body.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `## Sent Emails\n\n_No emails sent yet._`,
        },
      ],
    };
  }

  const lines = [
    `## Sent Emails (${body.length})`,
    ``,
    `| ID | Template | To | Status | Sent |`,
    `|----|----------|----|--------|------|`,
  ];

  for (const msg of body) {
    lines.push(
      `| \`${msg.id}\` | ${msg.template} | ${msg.to} | ${msg.status} | ${msg.created_at} |`,
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
