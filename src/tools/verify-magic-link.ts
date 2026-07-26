import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const verifyMagicLinkSchema = {
  project_id: z.string().describe("The project ID"),
  token: z.string().optional().describe("Magic-link token. Mutually exclusive with challenge_id/code."),
  challenge_id: z.string().optional().describe("Opaque email-code challenge handle. Required with code."),
  code: z.string().optional().describe("Six-digit email code. Required with challenge_id."),
};

export async function handleVerifyMagicLink(args: {
  project_id: string;
  token?: string;
  challenge_id?: string;
  code?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const hasLink = args.token !== undefined;
    const hasCodePart = args.challenge_id !== undefined || args.code !== undefined;
    if (hasLink === hasCodePart) {
      throw new Error("Provide either token, or challenge_id with code (not both)");
    }
    if (hasCodePart && (!args.challenge_id || !args.code)) {
      throw new Error("challenge_id and code must be provided together");
    }
    const body = hasLink
      ? await getSdk().auth.verifyMagicLink(args.project_id, args.token!)
      : await getSdk().auth.verifyEmailCode(args.project_id, {
        challengeId: args.challenge_id!,
        code: args.code!,
      });
    const credential = hasLink ? "Magic Link" : "Email Code";
    return {
      content: [
        {
          type: "text",
          text: `## ${credential} Verified\n\n- **User ID:** \`${body.user.id}\`\n- **Email:** ${body.user.email}\n- **Access Token:** \`${body.access_token.slice(0, 20)}...\`\n- **Refresh Token:** \`${body.refresh_token.slice(0, 8)}...\`\n- **Expires In:** ${body.expires_in}s\n\nThe user is now authenticated. Use the access_token as a Bearer token for authenticated API calls.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "verifying magic link");
  }
}
