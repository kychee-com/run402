import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listMailboxesSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListMailboxes(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getSdk().email.listMailboxes(args.project_id);
    const lines = ["## Mailboxes"];
    const settings = result.mailbox_settings;
    if (settings) {
      lines.push(
        "",
        `- **Default outbound:** ${settings.default_outbound_mailbox_id ?? "(unset)"}`,
        `- **Auth sender:** ${settings.auth_sender_mailbox_id ?? "(unset)"}`,
      );
    }
    lines.push("");
    if (result.mailboxes.length === 0) {
      lines.push("No mailboxes found. Use `create_mailbox` first.");
    } else {
      for (const mb of result.mailboxes) {
        const roles = [
          mb.is_default_outbound ? "default_outbound" : null,
          mb.is_auth_sender ? "auth_sender" : null,
        ].filter(Boolean);
        lines.push(
          `- **${mb.address}** — \`${mb.mailbox_id}\`${mb.slug ? ` (${mb.slug})` : ""}`,
        );
        lines.push(`  - Status: ${mb.status}${roles.length ? `; roles: ${roles.join(", ")}` : ""}`);
        if (mb.can_send !== undefined) {
          lines.push(`  - Can send: ${mb.can_send}${mb.send_blocked_reason ? ` (${mb.send_blocked_reason})` : ""}`);
        }
        if (mb.domain_kind) lines.push(`  - Domain kind: ${mb.domain_kind}`);
        if (mb.footer_policy !== undefined) lines.push(`  - Footer policy: ${mb.footer_policy}`);
        if (mb.effective_footer_policy !== undefined) {
          lines.push(`  - Effective footer policy: ${mb.effective_footer_policy}`);
        }
        if (mb.footer_policy_locked_reason) {
          lines.push(`  - Footer policy locked reason: ${mb.footer_policy_locked_reason}`);
        }
      }
    }
    if (Array.isArray(result.next_actions) && result.next_actions.length > 0) {
      lines.push("", "Next actions:", "```json", JSON.stringify(result.next_actions, null, 2), "```");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing mailboxes");
  }
}
