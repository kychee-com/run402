import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject, updateProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const sendEmailSchema = {
  project_id: z.string().describe("The project ID"),
  template: z
    .enum(["project_invite", "magic_link", "notification"])
    .describe("Email template to use"),
  to: z.string().describe("Recipient email address (single recipient only)"),
  variables: z
    .record(z.string())
    .describe(
      "Template variables. project_invite: project_name, invite_url. magic_link: project_name, link_url, expires_in. notification: project_name, message (max 500 chars).",
    ),
};

async function resolveMailboxId(
  projectId: string,
  serviceKey: string,
): Promise<{ id: string } | { error: { content: Array<{ type: "text"; text: string }>; isError: true } }> {
  const project = getProject(projectId) as Record<string, unknown> | undefined;
  if (project && project.mailbox_id) {
    return { id: project.mailbox_id as string };
  }

  // Fallback: discover via API
  const res = await apiRequest(`/mailboxes/v1`, {
    method: "GET",
    headers: { Authorization: `Bearer ${serviceKey}` },
  });

  if (!res.ok) return { error: formatApiError(res, "looking up mailbox") as any };

  const raw = res.body as { mailboxes?: Array<{ mailbox_id: string; address: string }> } | Array<{ mailbox_id: string; address: string }>;
  const list = Array.isArray(raw) ? raw : (raw.mailboxes || []);
  if (list.length === 0) {
    return {
      error: {
        content: [
          {
            type: "text",
            text: "Error: No mailbox found for this project. Use `create_mailbox` to create one first.",
          },
        ],
        isError: true,
      },
    };
  }

  // Cache for future calls
  const mailbox = list[0]!;
  updateProject(projectId, {
    mailbox_id: mailbox.mailbox_id,
    mailbox_address: mailbox.address,
  } as any);

  return { id: mailbox.mailbox_id };
}

export async function handleSendEmail(args: {
  project_id: string;
  template: string;
  to: string;
  variables: Record<string, string>;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const mailbox = await resolveMailboxId(args.project_id, project.service_key);
  if ("error" in mailbox) return mailbox.error;

  const res = await apiRequest(`/mailboxes/v1/${mailbox.id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
    body: {
      template: args.template,
      to: args.to,
      variables: args.variables,
    },
  });

  if (!res.ok) return formatApiError(res, "sending email");

  const body = res.body as {
    id: string;
    status: string;
    to: string;
    template: string;
  };

  return {
    content: [
      {
        type: "text",
        text: `## Email Sent\n\n- **Message ID:** \`${body.id}\`\n- **To:** ${body.to}\n- **Template:** ${body.template}\n- **Status:** ${body.status}`,
      },
    ],
  };
}

export { resolveMailboxId };
