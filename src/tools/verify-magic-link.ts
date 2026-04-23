import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const verifyMagicLinkSchema = {
  project_id: z.string().describe("The project ID"),
  token: z.string().describe("The magic link token from the email link URL (?token=...)"),
};

export async function handleVerifyMagicLink(args: {
  project_id: string;
  token: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().auth.verifyMagicLink(args.project_id, args.token);
    return {
      content: [
        {
          type: "text",
          text: `## Magic Link Verified\n\n- **User ID:** \`${body.user.id}\`\n- **Email:** ${body.user.email}\n- **Access Token:** \`${body.access_token.slice(0, 20)}...\`\n- **Refresh Token:** \`${body.refresh_token.slice(0, 8)}...\`\n- **Expires In:** ${body.expires_in}s\n\nThe user is now authenticated. Use the access_token as a Bearer token for authenticated API calls.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "verifying magic link");
  }
}
