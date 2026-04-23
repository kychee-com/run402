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

    // When the SDK returned the existing mailbox on 409, `status`/`slug` are absent.
    const bodyWithStatus = body as { mailbox_id: string; address: string; slug?: string; status?: string };
    if (bodyWithStatus.status) {
      return {
        content: [{
          type: "text",
          text: `## Mailbox Created\n\n- **Address:** ${bodyWithStatus.address}\n- **Mailbox ID:** \`${bodyWithStatus.mailbox_id}\`\n- **Status:** ${bodyWithStatus.status}\n\nUse \`send_email\` to send template-based emails from this mailbox.`,
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: `## Mailbox Already Exists\n\n- **Address:** ${bodyWithStatus.address}\n- **Mailbox ID:** \`${bodyWithStatus.mailbox_id}\`\n\nThe project already has a mailbox. Use \`send_email\` to send template-based emails from this mailbox.`,
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
