import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

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
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const body: Record<string, string> = { new_password: args.new_password };
  if (args.current_password) body.current_password = args.current_password;

  const res = await apiRequest(`/auth/v1/user/password`, {
    method: "PUT",
    headers: {
      apikey: project.anon_key,
      Authorization: `Bearer ${args.access_token}`,
    },
    body,
  });

  if (!res.ok) return formatApiError(res, "setting user password");

  const mode = args.current_password ? "changed" : "set";
  return {
    content: [
      {
        type: "text",
        text: `## Password ${mode.charAt(0).toUpperCase() + mode.slice(1)}\n\nPassword successfully ${mode} for the authenticated user. They can now log in with email + password.`,
      },
    ],
  };
}
