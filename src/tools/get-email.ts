import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const getEmailSchema = {
  project_id: z.string().describe("The project ID"),
  message_id: z.string().describe("The message ID to retrieve"),
};

export async function handleGetEmail(args: {
  project_id: string;
  message_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().email.get(args.project_id, args.message_id);

    const lines = [
      `## Email: \`${body.id}\``,
      ``,
      `- **To:** ${body.to}`,
      `- **Template:** ${body.template}`,
      `- **Status:** ${body.status}`,
      `- **Sent:** ${body.created_at}`,
      `- **Variables:** ${JSON.stringify(body.variables)}`,
    ];

    if (body.replies && body.replies.length > 0) {
      lines.push(``, `### Replies (${body.replies.length})`);
      for (const reply of body.replies) {
        lines.push(
          ``,
          `**From:** ${reply.from} — ${reply.received_at}`,
          `> ${reply.body}`,
        );
      }
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
    return mapSdkError(err, "getting email");
  }
}
