import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const rotateWebhookSecretSchema = {};

export async function handleRotateWebhookSecret(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/webhook-secret/rotate");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.rotateWebhookSecret();
    return {
      content: [
        {
          type: "text",
          text:
            `${JSON.stringify(result, null, 2)}\n\n` +
            `IMPORTANT: this secret will not be shown again. Store it securely (vault, env file, secret manager).\n` +
            `The previous secret remains valid for ${result.grace_window_hours} hours so webhook receivers can update without downtime.`,
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "rotating webhook signing secret");
  }
}
