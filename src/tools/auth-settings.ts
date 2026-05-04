import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const authSettingsSchema = {
  project_id: z.string().describe("The project ID"),
  allow_password_set: z.boolean().optional().describe("Allow passwordless users (magic link / OAuth) to set a password. Default: false."),
  preferred_sign_in_method: z.enum(["password", "magic_link", "oauth_google", "passkey"]).nullable().optional().describe("Project UI hint for the preferred sign-in method."),
  public_signup: z.enum(["open", "known_email", "invite_only"]).optional().describe("Public signup policy."),
  require_passkey_for_project_admin: z.boolean().optional().describe("Require eligible passkey login for project_admin sessions."),
};

export async function handleAuthSettings(args: {
  project_id: string;
  allow_password_set?: boolean;
  preferred_sign_in_method?: "password" | "magic_link" | "oauth_google" | "passkey" | null;
  public_signup?: "open" | "known_email" | "invite_only";
  require_passkey_for_project_admin?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const updated = await getSdk().auth.settings(args.project_id, {
      allow_password_set: args.allow_password_set,
      preferred_sign_in_method: args.preferred_sign_in_method,
      public_signup: args.public_signup,
      require_passkey_for_project_admin: args.require_passkey_for_project_admin,
    });
    return {
      content: [
        {
          type: "text",
          text: [
            "## Auth Settings Updated",
            "",
            `- **allow_password_set:** ${updated.allow_password_set}`,
            `- **preferred_sign_in_method:** ${updated.preferred_sign_in_method || ""}`,
            `- **public_signup:** ${updated.public_signup}`,
            `- **require_passkey_for_project_admin:** ${updated.require_passkey_for_project_admin}`,
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "updating auth settings");
  }
}
