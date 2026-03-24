import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject, updateProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

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
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  // Client-side slug validation
  const slug = args.slug;
  if (slug.length < 3 || slug.length > 63) {
    return {
      content: [{ type: "text", text: "Error: Slug must be 3-63 characters." }],
      isError: true,
    };
  }
  if (!SLUG_RE.test(slug)) {
    return {
      content: [
        {
          type: "text",
          text: "Error: Slug must be lowercase alphanumeric + hyphens, start/end with alphanumeric.",
        },
      ],
      isError: true,
    };
  }
  if (slug.includes("--")) {
    return {
      content: [{ type: "text", text: "Error: Slug must not contain consecutive hyphens." }],
      isError: true,
    };
  }

  const res = await apiRequest(`/mailboxes/v1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
    body: { slug, project_id: args.project_id },
  });

  if (!res.ok) return formatApiError(res, "creating mailbox");

  const body = res.body as {
    mailbox_id: string;
    address: string;
    slug: string;
    status: string;
  };

  // Store mailbox ID in keystore for future email commands
  updateProject(args.project_id, {
    mailbox_id: body.mailbox_id,
    mailbox_address: body.address,
  } as any);

  return {
    content: [
      {
        type: "text",
        text: `## Mailbox Created\n\n- **Address:** ${body.address}\n- **Mailbox ID:** \`${body.mailbox_id}\`\n- **Status:** ${body.status}\n\nUse \`send_email\` to send template-based emails from this mailbox.`,
      },
    ],
  };
}
