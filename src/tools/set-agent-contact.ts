import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";
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
  const body: Record<string, string> = { name: args.name };
  if (args.email) body.email = args.email;
  if (args.webhook) body.webhook = args.webhook;

  const auth = requireAllowanceAuth();
  if ("error" in auth) return auth.error;

  const res = await apiRequest("/agent/v1/contact", {
    method: "POST",
    headers: { ...auth.headers },
    body,
  });

  if (!res.ok) return formatApiError(res, "setting agent contact");

  const result = res.body as { wallet: string; name: string; email?: string; webhook?: string; updated_at: string };

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
}
