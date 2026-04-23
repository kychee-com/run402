import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listEmailsSchema = {
  project_id: z.string().describe("The project ID"),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max messages to return (server caps at 200)"),
  after: z
    .string()
    .optional()
    .describe("Pagination cursor (message id from prior page)"),
};

export async function handleListEmails(args: {
  project_id: string;
  limit?: number;
  after?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().email.list(args.project_id, { limit: args.limit, after: args.after });

    if (!Array.isArray(body) || body.length === 0) {
      return { content: [{ type: "text", text: `## Sent Emails\n\n_No emails sent yet._` }] };
    }

    const lines = [
      `## Sent Emails (${body.length})`,
      ``,
      `| ID | Template | To | Status | Sent |`,
      `|----|----------|----|--------|------|`,
    ];

    for (const msg of body) {
      lines.push(
        `| \`${msg.id}\` | ${msg.template} | ${msg.to} | ${msg.status} | ${msg.created_at} |`,
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/No mailbox found/.test(msg)) {
      return {
        content: [{ type: "text", text: "Error: No mailbox found for this project. Use `create_mailbox` to create one first." }],
        isError: true,
      };
    }
    return mapSdkError(err, "listing emails");
  }
}
