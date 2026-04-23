import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const setAgentContactSchema = {
  name: z.string().describe("Agent name"),
  email: z.string().optional().describe("Contact email (optional)"),
  webhook: z.string().optional().describe("Webhook URL for notifications (optional)"),
};

export async function handleSetAgentContact(args: {
  name: string;
  email?: string;
  webhook?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/agent/v1/contact");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().admin.setAgentContact({
      name: args.name,
      email: args.email,
      webhook: args.webhook,
    });

    const lines = [
      `## Agent Contact Updated`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| wallet | ${result.wallet} |`,
      `| name | ${result.name} |`,
      `| email | ${result.email || "-"} |`,
      `| webhook | ${result.webhook || "-"} |`,
      `| updated_at | ${result.updated_at} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "setting agent contact");
  }
}
