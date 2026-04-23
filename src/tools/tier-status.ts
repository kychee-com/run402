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
  } catch (err) {
    return mapSdkError(err, "checking tier status");
  }
}
