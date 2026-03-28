import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject, updateProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

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
};

async function resolveMailboxId(
  projectId: string,
  serviceKey: string,
): Promise<{ id: string } | { error: { content: Array<{ type: "text"; text: string }>; isError: true } }> {
  const project = getProject(projectId) as Record<string, unknown> | undefined;
  if (project && project.mailbox_id) {
    return { id: project.mailbox_id as string };
  }

  // Fallback: discover via API
  const res = await apiRequest(`/mailboxes/v1`, {
    method: "GET",
    headers: { Authorization: `Bearer ${serviceKey}` },
  });

  if (!res.ok) return { error: formatApiError(res, "looking up mailbox") as any };

  const raw = res.body as { mailboxes?: Array<{ mailbox_id: string; address: string }> } | Array<{ mailbox_id: string; address: string }>;
  const list = Array.isArray(raw) ? raw : (raw.mailboxes || []);
  if (list.length === 0) {
    return {
      error: {
        content: [
          {
            type: "text",
            text: "Error: No mailbox found for this project. Use `create_mailbox` to create one first.",
          },
        ],
        isError: true,
      },
    };
  }

  // Cache for future calls
  const mailbox = list[0]!;
  updateProject(projectId, {
    mailbox_id: mailbox.mailbox_id,
    mailbox_address: mailbox.address,
  } as any);

  return { id: mailbox.mailbox_id };
}

export async function handleSendEmail(args: {
  project_id: string;
  to: string;
  template?: string;
  variables?: Record<string, string>;
  subject?: string;
  html?: string;
  text?: string;
  from_name?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const isRaw = !!(args.subject || args.html);
  const isTemplate = !!(args.template);
  if (!isRaw && !isTemplate) {
    return {
      content: [{ type: "text", text: "Error: Provide either `template` + `variables` (template mode) or `subject` + `html` (raw HTML mode)." }],
      isError: true,
    };
  }

  const mailbox = await resolveMailboxId(args.project_id, project.service_key);
  if ("error" in mailbox) return mailbox.error;

  const body: Record<string, unknown> = { to: args.to };
  if (isTemplate) {
    body.template = args.template;
    body.variables = args.variables;
  } else {
    body.subject = args.subject;
    body.html = args.html;
    if (args.text) body.text = args.text;
  }
  if (args.from_name) body.from_name = args.from_name;

  const res = await apiRequest(`/mailboxes/v1/${mailbox.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${project.service_key}` },
    body,
  });

  if (!res.ok) return formatApiError(res, "sending email");

  const resBody = res.body as {
    id: string;
    status: string;
    to: string;
    template?: string;
    subject?: string;
  };

  const mode = resBody.template ? `**Template:** ${resBody.template}` : `**Subject:** ${resBody.subject}`;
  return {
    content: [
      {
        type: "text",
        text: `## Email Sent\n\n- **Message ID:** \`${resBody.id}\`\n- **To:** ${resBody.to}\n- ${mode}\n- **Status:** ${resBody.status}`,
      },
    ],
  };
}

export { resolveMailboxId };
