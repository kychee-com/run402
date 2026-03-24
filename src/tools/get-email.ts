import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";
import { resolveMailboxId } from "./send-email.js";

export const getEmailSchema = {
  project_id: z.string().describe("The project ID"),
  message_id: z.string().describe("The message ID to retrieve"),
};

export async function handleGetEmail(args: {
  project_id: string;
  message_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const mailbox = await resolveMailboxId(args.project_id, project.service_key);
  if ("error" in mailbox) return mailbox.error;

  const res = await apiRequest(
    `/mailboxes/v1/${mailbox.id}/messages/${args.message_id}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${project.service_key}`,
      },
    },
  );

  if (!res.ok) return formatApiError(res, "getting email");

  const body = res.body as {
    id: string;
    template: string;
    to: string;
    status: string;
    variables: Record<string, string>;
    created_at: string;
    replies?: Array<{
      id: string;
      from: string;
      body: string;
      received_at: string;
    }>;
  };

  const lines = [
    `## Email: \`${body.id}\``,
    ``,
    `- **To:** ${body.to}`,
    `- **Template:** ${body.template}`,
    `- **Status:** ${body.status}`,
    `- **Sent:** ${body.created_at}`,
    `- **Variables:** ${JSON.stringify(body.variables)}`,
  ];

  if (body.replies && body.replies.length > 0) {
    lines.push(``, `### Replies (${body.replies.length})`);
    for (const reply of body.replies) {
      lines.push(
        ``,
        `**From:** ${reply.from} — ${reply.received_at}`,
        `> ${reply.body}`,
      );
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
