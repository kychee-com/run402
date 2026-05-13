import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const tierStatusSchema = {};

export async function handleTierStatus(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/tiers/v1/status");
  if ("error" in auth) return auth.error;

  try {
    const body = await getSdk().tier.status();

    if (!body.tier) {
      return {
        content: [
          {
            type: "text",
            text: `## Tier Status\n\nNo active tier subscription. Use \`set_tier\` to subscribe, then \`provision_postgres_project\` to create a project.`,
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
      `| active | ${body.active ? "yes" : "no"} |`,
      `| started | ${body.lease_started_at ?? "(none)"} |`,
      `| expires | ${body.lease_expires_at ?? "(none)"} |`,
      `| projects | ${body.pool_usage.projects} |`,
      `| api calls | ${body.pool_usage.total_api_calls.toLocaleString()} / ${body.pool_usage.api_calls_limit.toLocaleString()} |`,
      `| storage | ${(body.pool_usage.total_storage_bytes / 1_048_576).toFixed(1)} MB / ${(body.pool_usage.storage_bytes_limit / 1_048_576).toFixed(0)} MB |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "checking tier status");
  }
}
