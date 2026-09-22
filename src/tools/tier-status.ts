import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { formatBytesDecimal } from "../format-bytes.js";
import { requireWalletAuth } from "../wallet-auth.js";

export const tierStatusSchema = {};

export async function handleTierStatus(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireWalletAuth("/tiers/v1/status");
  if ("error" in auth) return auth.error;

  try {
    const body = await getSdk().tier.status();

    if (!body.tier) {
      return {
        content: [
          {
            type: "text",
            text: `## Tier Status\n\nNo active tier. Use \`tier_set\` to set one (prototype is free), then \`provision_postgres_project\` to create a project.`,
          },
        ],
      };
    }

    const lines = [
      `## Tier Status`,
      ``,
      `Tier is per organization. The \`pool_usage\` totals below sum`,
      `\`api_calls\` and \`storage_bytes\` across every project in the organization,`,
      `across every wallet linked to it.`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| wallet | \`${body.wallet}\` |`,
      `| organization tier | ${body.tier} |`,
      `| active | ${body.active ? "yes" : "no"} |`,
      `| started | ${body.lease_started_at ?? "(none)"} |`,
      `| expires | ${body.lease_expires_at ?? "(none)"} |`,
      `| projects in pool | ${body.pool_usage.projects} |`,
      `| pooled api calls | ${body.pool_usage.total_api_calls.toLocaleString()} / ${body.pool_usage.api_calls_limit.toLocaleString()} |`,
      `| pooled storage | ${body.pool_usage.total_storage ?? formatBytesDecimal(body.pool_usage.total_storage_bytes)} / ${body.pool_usage.storage_limit ?? formatBytesDecimal(body.pool_usage.storage_bytes_limit)} |`,
      `| pooled vault | ${body.pool_usage.vault_source ?? formatBytesDecimal(body.pool_usage.vault_source_bytes ?? 0)} / ${body.pool_usage.source_limit ?? formatBytesDecimal(body.pool_usage.source_bytes_limit ?? 0)} |`,
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
