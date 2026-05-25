import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const getNotificationPreferencesSchema = {};

export async function handleGetNotificationPreferences(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/notifications/preferences");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.getNotificationPreferences();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "fetching notification preferences");
  }
}
