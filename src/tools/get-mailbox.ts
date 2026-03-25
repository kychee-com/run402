import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject, updateProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const getMailboxSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleGetMailbox(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/mailboxes/v1`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "getting mailbox");

  const raw = res.body as
    | { mailboxes?: Array<{ mailbox_id: string; address: string; slug?: string }> }
    | Array<{ mailbox_id: string; address: string; slug?: string }>;
  const list = Array.isArray(raw) ? raw : (raw.mailboxes || []);

  if (list.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "Error: No mailbox found for this project. Use `create_mailbox` to create one first.",
        },
      ],
      isError: true,
    };
  }

  const mb = list[0]!;

  // Cache for future commands
  updateProject(args.project_id, {
    mailbox_id: mb.mailbox_id,
    mailbox_address: mb.address,
  } as any);

  return {
    content: [
      {
        type: "text",
        text: `## Mailbox Info\n\n- **Address:** ${mb.address}\n- **Mailbox ID:** \`${mb.mailbox_id}\`${mb.slug ? `\n- **Slug:** ${mb.slug}` : ""}`,
      },
    ],
  };
}
