import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const sendEmailSchema = {
  project_id: z.string().describe("The project ID"),
  to: z.string().describe("Recipient email address (single recipient only)"),
  template: z
    .enum(["project_invite", "magic_link", "notification"])
    .optional()
    .describe("Email template (template mode). project_invite, magic_link, or notification"),
  variables: z
    .record(z.string())
    .optional()
    .describe(
      "Template variables (template mode). project_invite: project_name, invite_url. magic_link: project_name, link_url, expires_in. notification: project_name, message (max 500 chars).",
    ),
  subject: z.string().optional().describe("Email subject line (raw HTML mode, max 998 chars)"),
  html: z.string().optional().describe("HTML email body (raw HTML mode, max 1MB)"),
  text: z.string().optional().describe("Plain text fallback (raw HTML mode, auto-generated from HTML if omitted)"),
  from_name: z.string().optional().describe("Display name for From header, e.g. \"My App\" (max 78 chars)"),
  in_reply_to: z
    .string()
    .optional()
    .describe(
      "ID of a prior message (typically inbound) to thread this one under. The server uses it to set RFC-822 In-Reply-To and References headers. Usually set via reply flows; leave empty for new threads.",
    ),
};

export async function handleSendEmail(args: {
  project_id: string;
  to: string;
  template?: string;
  variables?: Record<string, string>;
  subject?: string;
  html?: string;
  text?: string;
  from_name?: string;
  in_reply_to?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().email.send(args.project_id, {
      to: args.to,
      template: args.template as "project_invite" | "magic_link" | "notification" | undefined,
      variables: args.variables,
      subject: args.subject,
      html: args.html,
      text: args.text,
      from_name: args.from_name,
      in_reply_to: args.in_reply_to,
    });

    const mode = body.template ? `**Template:** ${body.template}` : `**Subject:** ${body.subject}`;
    return {
      content: [{
        type: "text",
        text: `## Email Sent\n\n- **Message ID:** \`${body.message_id}\`\n- **To:** ${body.to}\n- ${mode}\n- **Status:** ${body.status}`,
      }],
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    if (/Provide either/.test(msg) || /Provide `template` OR raw/.test(msg) || /Raw mode requires/.test(msg)) {
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
    if (/No mailbox found/.test(msg)) {
      return {
        content: [{ type: "text", text: "Error: No mailbox found for this project. Use `create_mailbox` to create one first." }],
        isError: true,
      };
    }
    return mapSdkError(err, "sending email");
  }
}
