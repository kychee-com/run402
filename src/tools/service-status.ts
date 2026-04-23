import { getSdk } from "../sdk.js";
import { NetworkError, Run402Error } from "../../sdk/dist/index.js";

export const serviceStatusSchema = {};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleServiceStatus(
  _args: Record<string, never>,
): Promise<McpResult> {
  let body: Awaited<ReturnType<ReturnType<typeof getSdk>["service"]["status"]>>;
  try {
    body = await getSdk().service.status();
  } catch (err) {
    let detail: string;
    if (err instanceof NetworkError) {
      detail = `network error: ${err.message}`;
    } else if (err instanceof Run402Error) {
      detail = `HTTP ${err.status ?? "?"}`;
    } else {
      detail = (err as Error)?.message ?? String(err);
    }
    return {
      content: [{ type: "text", text: `Service /status check failed (${detail}).` }],
      isError: true,
    };
  }

  if (body?.schema_version !== "run402-status-v1") {
    return {
      content: [
        {
          type: "text",
          text: `## Run402 Service Status\n\nCurrent status: **${body?.current_status ?? "unknown"}**.\n\n(Unrecognized schema_version: \`${body?.schema_version ?? "missing"}\`. Showing minimal view.)`,
        },
      ],
    };
  }

  const uptime30d = body.availability?.last_30d?.uptime_pct;
  const uptime7d = body.availability?.last_7d?.uptime_pct;
  const uptime24h = body.availability?.last_24h?.uptime_pct;

  const lines: string[] = [
    `## Run402 Service Status`,
    ``,
    `Current status: **${body.current_status ?? "unknown"}**`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| operator | ${body.operator?.legal_name ?? "(unknown)"} |`,
    `| uptime (24h) | ${uptime24h != null ? `${uptime24h}%` : "(unknown)"} |`,
    `| uptime (7d) | ${uptime7d != null ? `${uptime7d}%` : "(unknown)"} |`,
    `| uptime (30d) | ${uptime30d != null ? `${uptime30d}%` : "(unknown)"} |`,
  ];

  if (body.deployment?.cloud || body.deployment?.region) {
    lines.push(`| deployment | ${body.deployment.cloud ?? "?"} / ${body.deployment.region ?? "?"} |`);
  }

  if (body.capabilities && Object.keys(body.capabilities).length > 0) {
    lines.push(``);
    lines.push(`### Capabilities`);
    for (const [name, state] of Object.entries(body.capabilities)) {
      lines.push(`- \`${name}\`: ${state}`);
    }
  }

  if (body.links?.health) {
    lines.push(``);
    lines.push(`Health probe: ${body.links.health}`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
