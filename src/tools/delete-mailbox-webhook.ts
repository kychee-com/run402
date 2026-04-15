import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const deleteMailboxWebhookSchema = {
  project_id: z.string().describe("The project ID"),
  webhook_id: z.string().describe("The webhook ID (whk_...)"),
};

export async function handleDeleteMailboxWebhook(args: {
  project_id: string;
  webhook_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  // Resolve mailbox ID
  const mbRes = await apiRequest(`/mailboxes/v1`, {
    method: "GET",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });
  if (!mbRes.ok) return formatApiError(mbRes, "getting mailbox");

  const raw = mbRes.body as { mailboxes?: Array<{ mailbox_id: string }> } | Array<{ mailbox_id: string }>;
  const list = Array.isArray(raw) ? raw : (raw.mailboxes || []);
  if (list.length === 0) {
    return {
      content: [{ type: "text", text: "Error: No mailbox found. Use `create_mailbox` first." }],
      isError: true,
    };
  }

  const mailboxId = list[0]!.mailbox_id;
  const res = await apiRequest(`/mailboxes/v1/${mailboxId}/webhooks/${args.webhook_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });
  // 204 = success (idempotent), anything else is an error
  if (!res.ok && res.status !== 204) return formatApiError(res, "deleting webhook");

  return {
    content: [{ type: "text", text: `Webhook \`${args.webhook_id}\` deleted.` }],
  };
}
