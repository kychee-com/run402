import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

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
  try {
    await getSdk().auth.requestMagicLink(args.project_id, {
      email: args.email,
      redirectUrl: args.redirect_url,
    });
    return {
      content: [
        {
          type: "text",
          text: `## Magic Link Sent\n\n- **Email:** ${args.email}\n- **Redirect:** ${args.redirect_url}\n\nThe user will receive an email with a login link. The link expires in 15 minutes. If they don't have an account, one will be created automatically when they verify the link.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "requesting magic link");
  }
}
