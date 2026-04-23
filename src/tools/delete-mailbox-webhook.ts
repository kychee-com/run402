import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const deleteMailboxWebhookSchema = {
  project_id: z.string().describe("The project ID"),
  webhook_id: z.string().describe("The webhook ID (whk_...)"),
};

export async function handleDeleteMailboxWebhook(args: {
  project_id: string;
  webhook_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().email.webhooks.delete(args.project_id, args.webhook_id);
    return { content: [{ type: "text", text: `Webhook \`${args.webhook_id}\` deleted.` }] };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/No mailbox found/.test(msg)) {
      return { content: [{ type: "text", text: "Error: No mailbox found. Use `create_mailbox` first." }], isError: true };
    }
    return mapSdkError(err, "deleting webhook");
  }
}
