import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const authSettingsSchema = {
  project_id: z.string().describe("The project ID"),
  allow_password_set: z.boolean().describe("Allow passwordless users (magic link / OAuth) to set a password. Default: false."),
};

export async function handleAuthSettings(args: {
  project_id: string;
  allow_password_set: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    await getSdk().auth.settings(args.project_id, {
      allow_password_set: args.allow_password_set,
    });
    return {
      content: [
        {
          type: "text",
          text: `## Auth Settings Updated\n\n- **allow_password_set:** ${args.allow_password_set}\n\n${args.allow_password_set ? "Passwordless users can now set a password via PUT /auth/v1/user/password." : "Passwordless users cannot set a password. They must use magic link or OAuth to sign in."}`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "updating auth settings");
  }
}
