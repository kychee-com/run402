import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const testNotificationSchema = {};

export async function handleTestNotification(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/notifications/test");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.testNotification();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "triggering test notification");
  }
}
