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
    const functionLimits = functionLimitsFromTierStatus(body);
    if (functionLimits) {
      lines.push(
        `| max function timeout | ${formatLimit(functionLimits.max_function_timeout_seconds, "s")} |`,
        `| max function memory | ${formatLimit(functionLimits.max_function_memory_mb, " MB")} |`,
        `| max scheduled functions | ${formatLimit(functionLimits.max_scheduled_functions)} |`,
        `| min cron interval | ${formatLimit(functionLimits.min_cron_interval_minutes, " min")} |`,
        `| current scheduled functions | ${formatLimit(functionLimits.current_scheduled_functions)} |`,
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "checking tier status");
  }
}

function functionLimitsFromTierStatus(
  body: {
    function_limits?: Record<string, unknown>;
    limits?: { functions?: Record<string, unknown> };
  },
): Record<string, unknown> | null {
  return body.function_limits ?? body.limits?.functions ?? null;
}

function formatLimit(value: unknown, suffix = ""): string {
  return typeof value === "number" ? `${value.toLocaleString()}${suffix}` : "(not returned)";
}
