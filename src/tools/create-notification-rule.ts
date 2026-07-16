import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const createNotificationRuleSchema = {
  telegram_binding_id: z
    .string()
    .describe(
      "The Telegram binding (chat) this rule routes matching events to. Must be an active binding owned by this operator — see list_notification_channels.",
    ),
  project_id: z.string().optional().describe("Only match events for this project. Omit to match every project (wildcard)."),
  source: z
    .enum(["app", "platform"])
    .optional()
    .describe(
      "Only match events from this source: 'app' (a deployed function's events.emit(...) calls) or 'platform' (deploys, lifecycle, verification, ...). Omit to match both.",
    ),
  event_types: z
    .array(z.string())
    .optional()
    .describe(
      "Only match these exact event_type names (matches ANY listed value). Omit to match any event_type. An empty array matches NOTHING (not a wildcard).",
    ),
  classes: z
    .array(z.string())
    .optional()
    .describe(
      "Only match these notification classes (matches ANY listed value), e.g. 'lifecycle', 'app'. Omit to match any class. An empty array matches NOTHING (not a wildcard).",
    ),
};

export async function handleCreateNotificationRule(args: {
  telegram_binding_id: string;
  project_id?: string;
  source?: "app" | "platform";
  event_types?: string[];
  classes?: string[];
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/notifications/rules");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.rules.create({
      telegramBindingId: args.telegram_binding_id,
      projectId: args.project_id,
      source: args.source,
      eventTypes: args.event_types,
      classes: args.classes,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "creating notification routing rule");
  }
}
