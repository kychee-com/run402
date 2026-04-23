import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const deleteMailboxSchema = {
  project_id: z.string().describe("The project ID"),
  mailbox_id: z
    .string()
    .optional()
    .describe(
      "Mailbox ID to delete (mbx_...). If omitted, resolves the project's mailbox from the keystore or via GET /mailboxes/v1.",
    ),
  confirm: z
    .boolean()
    .describe(
      "Must be true. Destructive: deleting a mailbox drops all messages and webhook subscriptions and is irreversible.",
    ),
};

export async function handleDeleteMailbox(args: {
  project_id: string;
  mailbox_id?: string;
  confirm: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (args.confirm !== true) {
    return {
      content: [{
        type: "text",
        text: "Error: `confirm` must be `true` to delete a mailbox. Deletion is irreversible (drops all messages and webhook subscriptions).",
      }],
      isError: true,
    };
  }

  try {
    await getSdk().email.deleteMailbox(args.project_id, args.mailbox_id);
    // SDK clears its cache; the response doesn't carry the id back, so echo the input (or "(resolved)" when unspecified).
    const id = args.mailbox_id ?? "(resolved)";
    return { content: [{ type: "text", text: `Mailbox \`${id}\` deleted.` }] };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/No mailbox found for this project — nothing to delete/.test(msg)) {
      return {
        content: [{ type: "text", text: "Error: No mailbox found for this project — nothing to delete." }],
        isError: true,
      };
    }
    return mapSdkError(err, "deleting mailbox");
  }
}
