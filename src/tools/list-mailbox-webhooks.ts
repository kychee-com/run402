import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listMailboxWebhooksSchema = {
  project_id: z.string().describe("The project ID"),
  mailbox: z
    .string()
    .optional()
    .describe("Target mailbox by slug or id; omit only when the project has exactly one mailbox."),
};

export async function handleListMailboxWebhooks(args: {
  project_id: string;
  mailbox?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().email.webhooks.list(args.project_id, { mailbox: args.mailbox });
    if (!body.webhooks || body.webhooks.length === 0) {
      return { content: [{ type: "text", text: "No webhooks registered on this mailbox." }] };
    }

    const lines = body.webhooks.map(
      (w) => `- **${w.webhook_id}** → ${w.url}\n  Events: ${w.events.join(", ")} | Created: ${w.created_at}`,
    );
    return { content: [{ type: "text", text: `## Webhooks\n\n${lines.join("\n")}` }] };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/No mailbox found/.test(msg)) {
      return { content: [{ type: "text", text: "Error: No mailbox found. Use `create_mailbox` first." }], isError: true };
    }
    return mapSdkError(err, "listing webhooks");
  }
}
