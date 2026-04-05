import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const authSettingsSchema = {
  project_id: z.string().describe("The project ID"),
  allow_password_set: z.boolean().describe("Allow passwordless users (magic link / OAuth) to set a password. Default: false."),
};

export async function handleAuthSettings(args: {
  project_id: string;
  allow_password_set: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/auth/v1/settings`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${project.service_key}` },
    body: {
      allow_password_set: args.allow_password_set,
    },
  });

  if (!res.ok) return formatApiError(res, "updating auth settings");

  return {
    content: [
      {
        type: "text",
        text: `## Auth Settings Updated\n\n- **allow_password_set:** ${args.allow_password_set}\n\n${args.allow_password_set ? "Passwordless users can now set a password via PUT /auth/v1/user/password." : "Passwordless users cannot set a password. They must use magic link or OAuth to sign in."}`,
      },
    ],
  };
}
