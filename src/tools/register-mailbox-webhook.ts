import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const registerMailboxWebhookSchema = {
  project_id: z.string().describe("The project ID"),
  url: z.string().describe("Webhook callback URL"),
  events: z.array(z.string()).describe("Events to subscribe to. Valid: delivery, bounced, complained, reply_received"),
};

export async function handleRegisterMailboxWebhook(args: {
  project_id: string;
  url: string;
  events: string[];
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const w = await getSdk().email.webhooks.register(args.project_id, {
      url: args.url,
      events: args.events,
    });
    return {
      content: [{
        type: "text",
        text: `## Webhook Registered\n\n- **ID:** \`${w.webhook_id}\`\n- **URL:** ${w.url}\n- **Events:** ${w.events.join(", ")}`,
      }],
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/No mailbox found/.test(msg)) {
      return { content: [{ type: "text", text: "Error: No mailbox found. Use `create_mailbox` first." }], isError: true };
    }
    return mapSdkError(err, "registering webhook");
  }
}
