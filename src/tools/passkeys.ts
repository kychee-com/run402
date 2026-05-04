import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const passkeyRegisterOptionsSchema = {
  project_id: z.string().describe("The project ID"),
  access_token: z.string().describe("Authenticated user's access_token"),
  app_origin: z.string().describe("Exact app origin for the WebAuthn ceremony"),
};

export const passkeyRegisterVerifySchema = {
  project_id: z.string().describe("The project ID"),
  access_token: z.string().describe("Authenticated user's access_token"),
  challenge_id: z.string().describe("challenge_id returned by passkey_register_options"),
  response: z.any().describe("PublicKeyCredential registration response JSON from the browser"),
  label: z.string().optional().describe("Optional passkey label"),
};

export const passkeyLoginOptionsSchema = {
  project_id: z.string().describe("The project ID"),
  app_origin: z.string().describe("Exact app origin for the WebAuthn ceremony"),
  email: z.string().optional().describe("Optional email hint. Does not expose allowCredentials."),
};

export const passkeyLoginVerifySchema = {
  project_id: z.string().describe("The project ID"),
  challenge_id: z.string().describe("challenge_id returned by passkey_login_options"),
  response: z.any().describe("PublicKeyCredential assertion response JSON from the browser"),
};

export const listPasskeysSchema = {
  project_id: z.string().describe("The project ID"),
  access_token: z.string().describe("Authenticated user's access_token"),
};

export const deletePasskeySchema = {
  project_id: z.string().describe("The project ID"),
  access_token: z.string().describe("Authenticated user's access_token"),
  passkey_id: z.string().describe("Passkey ID to delete"),
};

export async function handlePasskeyRegisterOptions(args: {
  project_id: string;
  access_token: string;
  app_origin: string;
}): Promise<McpResult> {
  try {
    const result = await getSdk().auth.createPasskeyRegistrationOptions(args.project_id, {
      accessToken: args.access_token,
      appOrigin: args.app_origin,
    });
    return {
      content: [{
        type: "text",
        text: `## Passkey Registration Options\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "creating passkey registration options");
  }
}

export async function handlePasskeyRegisterVerify(args: {
  project_id: string;
  access_token: string;
  challenge_id: string;
  response: unknown;
  label?: string;
}): Promise<McpResult> {
  try {
    const passkey = await getSdk().auth.verifyPasskeyRegistration(args.project_id, {
      accessToken: args.access_token,
      challengeId: args.challenge_id,
      response: args.response,
      label: args.label,
    });
    return {
      content: [{
        type: "text",
        text: [
          "## Passkey Registered",
          "",
          `- **Passkey ID:** \`${passkey.id}\``,
          `- **RP ID:** ${passkey.rp_id}`,
          `- **Origin:** ${passkey.created_origin}`,
          `- **Label:** ${passkey.label || ""}`,
        ].join("\n"),
      }],
    };
  } catch (err) {
    return mapSdkError(err, "verifying passkey registration");
  }
}

export async function handlePasskeyLoginOptions(args: {
  project_id: string;
  app_origin: string;
  email?: string;
}): Promise<McpResult> {
  try {
    const result = await getSdk().auth.createPasskeyLoginOptions(args.project_id, {
      appOrigin: args.app_origin,
      email: args.email,
    });
    return {
      content: [{
        type: "text",
        text: `## Passkey Login Options\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "creating passkey login options");
  }
}

export async function handlePasskeyLoginVerify(args: {
  project_id: string;
  challenge_id: string;
  response: unknown;
}): Promise<McpResult> {
  try {
    const session = await getSdk().auth.verifyPasskeyLogin(args.project_id, {
      challengeId: args.challenge_id,
      response: args.response,
    });
    return {
      content: [{
        type: "text",
        text: [
          "## Passkey Login Verified",
          "",
          `- **User ID:** \`${session.user.id}\``,
          `- **Email:** ${session.user.email}`,
          `- **Access Token:** \`${session.access_token.slice(0, 20)}...\``,
          `- **Refresh Token:** \`${session.refresh_token.slice(0, 8)}...\``,
          `- **Expires In:** ${session.expires_in}s`,
          session.elevation_required ? "- **Elevation Required:** true" : "",
        ].filter(Boolean).join("\n"),
      }],
    };
  } catch (err) {
    return mapSdkError(err, "verifying passkey login");
  }
}

export async function handleListPasskeys(args: {
  project_id: string;
  access_token: string;
}): Promise<McpResult> {
  try {
    const result = await getSdk().auth.listPasskeys(args.project_id, {
      accessToken: args.access_token,
    });
    const lines = [
      "## Passkeys",
      "",
      "| ID | RP ID | Label | Created | Last Used |",
      "|----|-------|-------|---------|-----------|",
      ...result.passkeys.map((p) =>
        `| \`${p.id}\` | ${p.rp_id} | ${p.label || ""} | ${p.created_at} | ${p.last_used_at || ""} |`,
      ),
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing passkeys");
  }
}

export async function handleDeletePasskey(args: {
  project_id: string;
  access_token: string;
  passkey_id: string;
}): Promise<McpResult> {
  try {
    await getSdk().auth.deletePasskey(args.project_id, {
      accessToken: args.access_token,
      passkeyId: args.passkey_id,
    });
    return {
      content: [{
        type: "text",
        text: `## Passkey Deleted\n\nPasskey \`${args.passkey_id}\` was deleted.`,
      }],
    };
  } catch (err) {
    return mapSdkError(err, "deleting passkey");
  }
}
