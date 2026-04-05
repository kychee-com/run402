import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const verifyMagicLinkSchema = {
  project_id: z.string().describe("The project ID"),
  token: z.string().describe("The magic link token from the email link URL (?token=...)"),
};

export async function handleVerifyMagicLink(args: {
  project_id: string;
  token: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/auth/v1/token?grant_type=magic_link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${project.anon_key}` },
    body: {
      token: args.token,
    },
  });

  if (!res.ok) return formatApiError(res, "verifying magic link");

  const body = res.body as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    user: { id: string; email: string };
  };

  return {
    content: [
      {
        type: "text",
        text: `## Magic Link Verified\n\n- **User ID:** \`${body.user.id}\`\n- **Email:** ${body.user.email}\n- **Access Token:** \`${body.access_token.slice(0, 20)}...\`\n- **Refresh Token:** \`${body.refresh_token.slice(0, 8)}...\`\n- **Expires In:** ${body.expires_in}s\n\nThe user is now authenticated. Use the access_token as a Bearer token for authenticated API calls.`,
      },
    ],
  };
}
