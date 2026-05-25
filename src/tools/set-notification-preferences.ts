import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const setNotificationPreferencesSchema = {
  digest_cadence: z
    .enum(["off", "daily", "weekly", "monthly"])
    .optional()
    .describe("Periodic digest cadence"),
  digest_day_of_week: z
    .number()
    .int()
    .min(1)
    .max(7)
    .optional()
    .describe("Day of week for weekly digest (1=Mon, 7=Sun)"),
  digest_hour_utc: z
    .number()
    .int()
    .min(0)
    .max(23)
    .optional()
    .describe("Hour (UTC) for the digest send"),
  threshold_alerts: z
    .enum(["off", "digest_only", "immediate"])
    .optional()
    .describe("Threshold-alert delivery mode (immediate ships in v1.5)"),
  lifecycle_events: z
    .enum(["off", "critical_only", "all"])
    .optional()
    .describe("Which lifecycle events fire notifications"),
  webhook_url: z
    .string()
    .nullable()
    .optional()
    .describe("HTTPS webhook URL (requires operator_passkey assurance)"),
  locale: z.string().optional().describe("BCP-47 (e.g. en-US)"),
  timezone: z.string().optional().describe("IANA timezone (e.g. UTC)"),
};

export async function handleSetNotificationPreferences(args: {
  digest_cadence?: "off" | "daily" | "weekly" | "monthly";
  digest_day_of_week?: number;
  digest_hour_utc?: number;
  threshold_alerts?: "off" | "digest_only" | "immediate";
  lifecycle_events?: "off" | "critical_only" | "all";
  webhook_url?: string | null;
  locale?: string;
  timezone?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/notifications/preferences");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.setNotificationPreferences(args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "updating notification preferences");
  }
}
