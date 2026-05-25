import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const listNotificationsSchema = {
  type: z.string().optional().describe("Filter by event_type (e.g. project_past_due)"),
  since: z.string().optional().describe("ISO timestamp; only notifications at or after this time"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50, max 200)"),
  offset: z.number().int().min(0).optional().describe("Pagination offset"),
};

export async function handleListNotifications(args: {
  type?: string;
  since?: string;
  limit?: number;
  offset?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/notifications");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.listNotifications(args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "listing notifications");
  }
}
