import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const listSecretsSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleListSecrets(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().secrets.list(args.project_id);

    if (body.secrets.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Secrets\n\n_No secrets set. Use \`set_secret\` to add one._`,
          },
        ],
      };
    }

    const lines = [
      `## Secrets (${body.secrets.length})`,
      ``,
      `| Key | Hash |`,
      `|-----|------|`,
      ...body.secrets.map((s) => `| \`${s.key}\` | ${s.value_hash ? `\`${s.value_hash}\`` : "—"} |`),
      ``,
      `_Hash is the first 8 hex chars of SHA-256 — use it to verify the correct value was set._`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "listing secrets");
  }
}
