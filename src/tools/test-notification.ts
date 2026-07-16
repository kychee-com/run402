import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const testNotificationSchema = {
  source: z
    .enum(["app", "platform"])
    .optional()
    .describe(
      "Route the synthetic test event as if it came from the app lane or the platform, so it exercises a specific Telegram routing rule's `source` filter. Defaults to 'platform' when omitted.",
    ),
  event_type: z
    .string()
    .optional()
    .describe(
      "Synthetic event_type override (flat snake_case, e.g. `signature_failed`) — use this to exercise a specific routing rule's `event_types` filter precisely. Defaults to the gateway's built-in sample event when omitted.",
    ),
};

export async function handleTestNotification(args: {
  source?: "app" | "platform";
  event_type?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/notifications/test");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.testNotification({ source: args.source, eventType: args.event_type });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "triggering test notification");
  }
}
