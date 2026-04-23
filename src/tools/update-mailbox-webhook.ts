import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

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
  try {
    const w = await getSdk().email.webhooks.update(args.project_id, args.webhook_id, {
      url: args.url,
      events: args.events,
    });
    return {
      content: [{
        type: "text",
        text: `## Webhook Updated: ${w.webhook_id}\n\n- **URL:** ${w.url}\n- **Events:** ${w.events.join(", ")}`,
      }],
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/Provide at least/.test(msg)) {
      return { content: [{ type: "text", text: "Error: Provide at least `url` or `events` to update." }], isError: true };
    }
    if (/No mailbox found/.test(msg)) {
      return { content: [{ type: "text", text: "Error: No mailbox found. Use `create_mailbox` first." }], isError: true };
    }
    return mapSdkError(err, "updating webhook");
  }
}
