import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getMailboxSchema = {
  project_id: z.string().describe("The project ID"),
  mailbox: z
    .string()
    .optional()
    .describe("Target mailbox by slug or id; omit only when the project has exactly one mailbox (otherwise returns an ambiguity error naming the slugs)."),
};

export async function handleGetMailbox(args: {
  project_id: string;
  mailbox?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const mb = await getSdk().email.getMailbox(args.project_id, args.mailbox);
    const roles = [
      mb.is_default_outbound ? "default_outbound" : null,
      mb.is_auth_sender ? "auth_sender" : null,
    ].filter(Boolean);
    const lines = [
      "## Mailbox Info",
      "",
      `- **Address:** ${mb.address}`,
      ...(mb.managed_address && mb.managed_address !== mb.address
        ? [`- **Managed address:** ${mb.managed_address}`]
        : []),
      `- **Mailbox ID:** \`${mb.mailbox_id}\`${mb.slug ? `\n- **Slug:** ${mb.slug}` : ""}`,
      `- **Status:** ${mb.status}`,
    ];
    if (roles.length > 0) lines.push(`- **Roles:** ${roles.join(", ")}`);
    if (mb.can_send !== undefined) {
      lines.push(`- **Can send:** ${mb.can_send}${mb.send_blocked_reason ? ` (${mb.send_blocked_reason})` : ""}`);
    }
    if (mb.domain_kind) lines.push(`- **Domain kind:** ${mb.domain_kind}`);
    if (mb.can_receive !== undefined) lines.push(`- **Can receive:** ${mb.can_receive}`);
    if (mb.custom_domain_ready !== undefined) lines.push(`- **Custom domain ready:** ${mb.custom_domain_ready}`);
    if (mb.footer_policy !== undefined) lines.push(`- **Footer policy:** ${mb.footer_policy}`);
    if (mb.effective_footer_policy !== undefined) {
      lines.push(`- **Effective footer policy:** ${mb.effective_footer_policy}`);
    }
    if (mb.footer_policy_locked_reason) {
      lines.push(`- **Footer policy locked reason:** ${mb.footer_policy_locked_reason}`);
    }
    return {
      content: [{
        type: "text",
        text: lines.join("\n"),
      }],
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/No mailbox found/.test(msg)) {
      return {
        content: [{ type: "text", text: "Error: No mailbox found for this project. Use `create_mailbox` to create one first." }],
        isError: true,
      };
    }
    return mapSdkError(err, "getting mailbox");
  }
}
