import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const redriveMailboxWebhookDeliverySchema = {
  project_id: z.string().describe("The project ID"),
  delivery_id: z.string().describe("The delivery id to re-queue (from list_mailbox_webhook_deliveries)"),
  mailbox: z
    .string()
    .optional()
    .describe("Target mailbox by slug or id; omit only when the project has exactly one mailbox."),
};

export async function handleRedriveMailboxWebhookDelivery(args: {
  project_id: string;
  delivery_id: string;
  mailbox?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().email.webhooks.redriveDelivery(args.project_id, args.delivery_id, {
      mailbox: args.mailbox,
    });
    return {
      content: [
        {
          type: "text",
          text: `Re-queued delivery \`${body.delivery.delivery_id}\` (event ${body.delivery.event_type}) — the worker will attempt delivery again.`,
        },
      ],
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/No mailbox found/.test(msg)) {
      return { content: [{ type: "text", text: "Error: No mailbox found. Use `create_mailbox` first." }], isError: true };
    }
    return mapSdkError(err, "redriving webhook delivery");
  }
}
