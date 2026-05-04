import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const createAuthUserSchema = {
  project_id: z.string().describe("The project ID"),
  email: z.string().describe("Email address of the auth user to create or update"),
  is_admin: z.boolean().optional().describe("Set project_admin status for this user"),
  send_invite: z.boolean().optional().describe("Send a trusted invite magic link after creating/updating the user"),
  redirect_url: z.string().optional().describe("Required when send_invite=true. Must be an allowed project auth redirect origin."),
  client_state: z.any().optional().describe("Optional opaque state preserved through trusted invite verification"),
};

export const inviteAuthUserSchema = {
  project_id: z.string().describe("The project ID"),
  email: z.string().describe("Email address of the auth user to invite"),
  redirect_url: z.string().describe("Allowed auth redirect URL for the invite link"),
  is_admin: z.boolean().optional().describe("Set project_admin status before sending the invite"),
  client_state: z.any().optional().describe("Optional opaque state preserved through invite verification"),
};

export async function handleCreateAuthUser(args: {
  project_id: string;
  email: string;
  is_admin?: boolean;
  send_invite?: boolean;
  redirect_url?: string;
  client_state?: unknown;
}): Promise<McpResult> {
  try {
    const result = await getSdk().auth.createUser(args.project_id, {
      email: args.email,
      isAdmin: args.is_admin,
      sendInvite: args.send_invite,
      redirectUrl: args.redirect_url,
      clientState: args.client_state,
    });
    return {
      content: [{
        type: "text",
        text: [
          "## Auth User Saved",
          "",
          `- **User ID:** \`${result.id}\``,
          `- **Email:** ${result.email}`,
          `- **Admin:** ${result.is_admin}`,
          `- **Created:** ${result.created}`,
          `- **Invite Sent:** ${result.invite_sent}`,
        ].join("\n"),
      }],
    };
  } catch (err) {
    return mapSdkError(err, "creating auth user");
  }
}

export async function handleInviteAuthUser(args: {
  project_id: string;
  email: string;
  redirect_url: string;
  is_admin?: boolean;
  client_state?: unknown;
}): Promise<McpResult> {
  try {
    const result = await getSdk().auth.inviteUser(args.project_id, {
      email: args.email,
      isAdmin: args.is_admin,
      redirectUrl: args.redirect_url,
      clientState: args.client_state,
    });
    return {
      content: [{
        type: "text",
        text: [
          "## Auth Invite Created",
          "",
          `- **User ID:** \`${result.id}\``,
          `- **Email:** ${result.email}`,
          `- **Admin:** ${result.is_admin}`,
          `- **Invite Sent:** ${result.invite_sent}`,
          "",
          result.invite_sent
            ? "The invite link was sent from the project's mailbox."
            : "No project mailbox was available, so the user was created but no email was sent.",
        ].join("\n"),
      }],
    };
  } catch (err) {
    return mapSdkError(err, "inviting auth user");
  }
}
