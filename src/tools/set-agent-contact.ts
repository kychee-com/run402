import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const setAgentContactSchema = {
  name: z.string().describe("Agent name"),
  email: z.string().optional().describe("Contact email (optional; new or changed emails start reply verification)"),
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

    return { content: [{ type: "text", text: formatAgentContact("Agent Contact Updated", result) }] };
  } catch (err) {
    return mapSdkError(err, "setting agent contact");
  }
}

export function formatAgentContact(title: string, result: {
  wallet: string;
  name: string;
  email?: string | null;
  webhook?: string | null;
  email_verification_status?: string;
  passkey_binding_status?: string;
  assurance_level?: string;
  email_verified_at?: string | null;
  email_challenge_sent_at?: string | null;
  passkey_bound_at?: string | null;
  updated_at?: string;
  verification_retry_after_seconds?: number;
  enrollment_sent_to?: string;
}): string {
  const lines = [
    `## ${title}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| wallet | ${result.wallet} |`,
    `| name | ${result.name} |`,
    `| email | ${result.email || "-"} |`,
    `| webhook | ${result.webhook || "-"} |`,
    `| assurance_level | ${result.assurance_level || "wallet_only"} |`,
    `| email_verification_status | ${result.email_verification_status || "none"} |`,
    `| passkey_binding_status | ${result.passkey_binding_status || "none"} |`,
    `| email_verified_at | ${result.email_verified_at || "-"} |`,
    `| email_challenge_sent_at | ${result.email_challenge_sent_at || "-"} |`,
    `| passkey_bound_at | ${result.passkey_bound_at || "-"} |`,
    `| updated_at | ${result.updated_at || "-"} |`,
  ];
  if (result.verification_retry_after_seconds !== undefined) {
    lines.push(`| verification_retry_after_seconds | ${result.verification_retry_after_seconds} |`);
  }
  if (result.enrollment_sent_to) {
    lines.push(`| enrollment_sent_to | ${result.enrollment_sent_to} |`);
  }
  return lines.join("\n");
}
