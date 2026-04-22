import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";
import { resolveMailboxId } from "./send-email.js";

export const listEmailsSchema = {
  project_id: z.string().describe("The project ID"),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max messages to return (server caps at 200)"),
  after: z
    .string()
    .optional()
    .describe("Pagination cursor (message id from prior page)"),
};

export async function handleListEmails(args: {
  project_id: string;
  limit?: number;
  after?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const mailbox = await resolveMailboxId(args.project_id, project.service_key);
  if ("error" in mailbox) return mailbox.error;

  const qs = new URLSearchParams();
  if (args.limit !== undefined) qs.set("limit", String(args.limit));
  if (args.after) qs.set("after", args.after);
  const path = `/mailboxes/v1/${mailbox.id}/messages${qs.toString() ? "?" + qs.toString() : ""}`;

  const res = await apiRequest(path, {
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
