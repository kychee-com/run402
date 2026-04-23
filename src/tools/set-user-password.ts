import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const setUserPasswordSchema = {
  project_id: z.string().describe("The project ID"),
  access_token: z.string().describe("The user's access_token (Bearer token from login)"),
  new_password: z.string().describe("The new password to set"),
  current_password: z.string().optional().describe("Current password (required for password change, omit for reset via magic link or initial set)"),
};

export async function handleSetUserPassword(args: {
  project_id: string;
  access_token: string;
  new_password: string;
  current_password?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().auth.setUserPassword(args.project_id, {
      accessToken: args.access_token,
      newPassword: args.new_password,
      currentPassword: args.current_password,
    });
    const mode = args.current_password ? "changed" : "set";
    return {
      content: [
        {
          type: "text",
          text: `## Password ${mode.charAt(0).toUpperCase() + mode.slice(1)}\n\nPassword successfully ${mode} for the authenticated user. They can now log in with email + password.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "setting user password");
  }
}
