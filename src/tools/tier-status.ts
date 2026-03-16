import { z } from "zod";
import { apiRequest } from "../client.js";
import { formatApiError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const tierStatusSchema = {};

export async function handleTierStatus(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth();
  if ("error" in auth) return auth.error;

  const res = await apiRequest("/tiers/v1/status", {
    method: "GET",
    headers: { ...auth.headers },
  });

  if (!res.ok) return formatApiError(res, "checking tier status");

  const body = res.body as {
    wallet: string;
    tier: string | null;
    lease_expires_at: string | null;
    status: string;
  };

  if (!body.tier) {
    return {
      content: [
        {
          type: "text",
          text: `## Tier Status\n\nNo active tier subscription. Use \`provision_postgres_project\` or \`bundle_deploy\` to subscribe to a tier.`,
        },
      ],
    };
  }

  const lines = [
    `## Tier Status`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| wallet | \`${body.wallet}\` |`,
    `| tier | ${body.tier} |`,
    `| status | ${body.status} |`,
    `| expires | ${body.lease_expires_at} |`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
