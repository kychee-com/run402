import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const updateMailboxWebhookSchema = {
  project_id: z.string().describe("The project ID"),
  webhook_id: z.string().describe("The webhook ID (whk_...)"),
  url: z.string().optional().describe("New webhook URL"),
  events: z.array(z.string()).optional().describe("New events array (full replacement). Valid: delivery, bounced, complained, reply_received"),
};

export async function handleUpdateMailboxWebhook(args: {
  project_id: string;
  webhook_id: string;
  url?: string;
  events?: string[];
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  if (!args.url && !args.events) {
    return {
      content: [{ type: "text", text: "Error: Provide at least `url` or `events` to update." }],
      isError: true,
    };
  }

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
  const body: Record<string, unknown> = {};
  if (args.url) body.url = args.url;
  if (args.events) body.events = args.events;

  const res = await apiRequest(`/mailboxes/v1/${mailboxId}/webhooks/${args.webhook_id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return formatApiError(res, "updating webhook");

  const w = res.body as { webhook_id: string; url: string; events: string[]; created_at: string };
  return {
    content: [{
      type: "text",
      text: `## Webhook Updated: ${w.webhook_id}\n\n- **URL:** ${w.url}\n- **Events:** ${w.events.join(", ")}`,
    }],
  };
}
