import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const listMailboxWebhooksSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListMailboxWebhooks(args: {
  project_id: string;
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
  const res = await apiRequest(`/mailboxes/v1/${mailboxId}/webhooks`, {
    method: "GET",
    headers: { Authorization: `Bearer ${project.service_key}` },
  });
  if (!res.ok) return formatApiError(res, "listing webhooks");

  const body = res.body as { webhooks: Array<{ webhook_id: string; url: string; events: string[]; created_at: string }> };
  if (!body.webhooks || body.webhooks.length === 0) {
    return { content: [{ type: "text", text: "No webhooks registered on this mailbox." }] };
  }

  const lines = body.webhooks.map(
    (w) => `- **${w.webhook_id}** → ${w.url}\n  Events: ${w.events.join(", ")} | Created: ${w.created_at}`,
  );
  return { content: [{ type: "text", text: `## Webhooks\n\n${lines.join("\n")}` }] };
}
