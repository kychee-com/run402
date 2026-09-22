import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireWalletAuth } from "../wallet-auth.js";

export const listNotificationRulesSchema = {};

export async function handleListNotificationRules(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireWalletAuth("/agent/v1/notifications/rules");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.rules.list();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "listing notification routing rules");
  }
}
