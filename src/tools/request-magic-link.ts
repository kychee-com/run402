import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const requestMagicLinkSchema = {
  project_id: z.string().describe("The project ID"),
  email: z.string().describe("Email address to send the magic link to"),
  redirect_url: z.string().describe("URL to redirect to after clicking the magic link. Must be an allowed origin for this project (localhost, claimed subdomain, or custom domain)."),
};

export async function handleRequestMagicLink(args: {
  project_id: string;
  email: string;
  redirect_url: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/auth/v1/magic-link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${project.anon_key}` },
    body: {
      email: args.email,
      redirect_url: args.redirect_url,
    },
  });

  if (!res.ok) return formatApiError(res, "requesting magic link");

  return {
    content: [
      {
        type: "text",
        text: `## Magic Link Sent\n\n- **Email:** ${args.email}\n- **Redirect:** ${args.redirect_url}\n\nThe user will receive an email with a login link. The link expires in 15 minutes. If they don't have an account, one will be created automatically when they verify the link.`,
      },
    ],
  };
}
