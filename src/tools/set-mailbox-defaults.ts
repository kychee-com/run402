import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const setMailboxDefaultsSchema = {
  project_id: z.string().describe("The project ID"),
  default_outbound_mailbox_id: z
    .string()
    .nullable()
    .optional()
    .describe("Mailbox id (`mbx_...`) to use for outbound email sends, or null to clear."),
  auth_sender_mailbox_id: z
    .string()
    .nullable()
    .optional()
    .describe("Mailbox id (`mbx_...`) to use for auth/session emails, or null to clear."),
};

export async function handleSetMailboxDefaults(args: {
  project_id: string;
  default_outbound_mailbox_id?: string | null;
  auth_sender_mailbox_id?: string | null;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const patch: {
      default_outbound_mailbox_id?: string | null;
      auth_sender_mailbox_id?: string | null;
    } = {};
    if (Object.prototype.hasOwnProperty.call(args, "default_outbound_mailbox_id")) {
      patch.default_outbound_mailbox_id = args.default_outbound_mailbox_id ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(args, "auth_sender_mailbox_id")) {
      patch.auth_sender_mailbox_id = args.auth_sender_mailbox_id ?? null;
    }
    const result = await getSdk().email.setMailboxDefaults(args.project_id, patch);
    const settings = result.mailbox_settings;
    const lines = [
      "## Mailbox Defaults Updated",
      "",
      `- **Default outbound:** ${settings?.default_outbound_mailbox_id ?? "(unset)"}`,
      `- **Auth sender:** ${settings?.auth_sender_mailbox_id ?? "(unset)"}`,
    ];
    if (Array.isArray(result.next_actions) && result.next_actions.length > 0) {
      lines.push("", "Next actions:", "```json", JSON.stringify(result.next_actions, null, 2), "```");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "setting mailbox defaults");
  }
}
