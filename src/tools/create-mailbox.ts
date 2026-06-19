import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const createMailboxSchema = {
  project_id: z.string().describe("The project ID to create a mailbox for"),
  slug: z
    .string()
    .describe(
      "Mailbox slug (3-63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens). Creates <slug>@mail.run402.com",
    ),
};

export async function handleCreateMailbox(args: {
  project_id: string;
  slug: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().email.createMailbox(args.project_id, args.slug);
    const lines = [
      "## Mailbox Created",
      "",
      `- **Address:** ${body.address}`,
      `- **Mailbox ID:** \`${body.mailbox_id}\``,
      `- **Status:** ${body.status}`,
    ];
    if (body.mailbox_settings) {
      lines.push(
        `- **Default outbound:** ${body.mailbox_settings.default_outbound_mailbox_id ?? "(unset)"}`,
        `- **Auth sender:** ${body.mailbox_settings.auth_sender_mailbox_id ?? "(unset)"}`,
      );
    }
    if (Array.isArray(body.next_actions) && body.next_actions.length > 0) {
      lines.push("", "Next actions:", "```json", JSON.stringify(body.next_actions, null, 2), "```");
    }

    return {
      content: [{
        type: "text",
        text: lines.join("\n"),
      }],
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/3-63 characters/.test(msg)) {
      return { content: [{ type: "text", text: "Error: Slug must be 3-63 characters." }], isError: true };
    }
    if (/lowercase alphanumeric/.test(msg)) {
      return {
        content: [{ type: "text", text: "Error: Slug must be lowercase alphanumeric + hyphens, start/end with alphanumeric." }],
        isError: true,
      };
    }
    if (/consecutive hyphens/.test(msg)) {
      return { content: [{ type: "text", text: "Error: Slug must not contain consecutive hyphens." }], isError: true };
    }
    return mapSdkError(err, "creating mailbox");
  }
}
