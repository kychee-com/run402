import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getMailboxSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleGetMailbox(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const mb = await getSdk().email.getMailbox(args.project_id);
    return {
      content: [{
        type: "text",
        text: `## Mailbox Info\n\n- **Address:** ${mb.address}\n- **Mailbox ID:** \`${mb.mailbox_id}\`${mb.slug ? `\n- **Slug:** ${mb.slug}` : ""}`,
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
