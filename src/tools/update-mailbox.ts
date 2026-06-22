import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

const footerPolicySchema = z.enum(["run402_transparency", "none"]);

export const updateMailboxSchema = {
  project_id: z.string().describe("The project ID"),
  mailbox: z
    .string()
    .optional()
    .describe("Target mailbox by slug or id; omit only when the project has exactly one mailbox."),
  footer_policy: footerPolicySchema.describe(
    "Outbound footer policy. `none` is allowed for hobby/team projects; prototype projects are locked to `run402_transparency`.",
  ),
};

export async function handleUpdateMailbox(args: {
  project_id: string;
  mailbox?: string;
  footer_policy: "run402_transparency" | "none";
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const mb = await getSdk().email.updateMailbox(args.project_id, {
      mailbox: args.mailbox,
      footer_policy: args.footer_policy,
    });
    const lines = [
      "## Mailbox Updated",
      "",
      `- **Address:** ${mb.address}`,
      `- **Mailbox ID:** \`${mb.mailbox_id}\`${mb.slug ? `\n- **Slug:** ${mb.slug}` : ""}`,
      `- **Footer policy:** ${mb.footer_policy ?? "(unknown)"}`,
      `- **Effective footer policy:** ${mb.effective_footer_policy ?? "(unknown)"}`,
    ];
    if (mb.footer_policy_locked_reason) {
      lines.push(`- **Footer policy locked reason:** ${mb.footer_policy_locked_reason}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "updating mailbox");
  }
}
