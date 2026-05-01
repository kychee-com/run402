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

  const uptimeHours = (body.uptime_seconds / 3600).toFixed(1);

  const lines: string[] = [
    `## Run402 Service Status`,
    ``,
    `Current status: **${body.status}**`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| operator | ${body.operator.name} (${body.operator.contact}) |`,
    `| uptime | ${uptimeHours}h |`,
    `| version | ${body.deployment.version} |`,
  ];

  if (body.capabilities.length > 0) {
    lines.push(``);
    lines.push(`### Capabilities`);
    for (const name of body.capabilities) {
      lines.push(`- \`${name}\``);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
