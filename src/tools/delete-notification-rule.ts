import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const deleteNotificationRuleSchema = {
  rule_id: z.string().describe("The routing rule id to delete."),
};

export async function handleDeleteNotificationRule(args: {
  rule_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/notifications/rules");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.rules.delete(args.rule_id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return mapSdkError(err, "deleting notification routing rule");
  }
}
