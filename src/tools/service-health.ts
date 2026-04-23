import { getSdk } from "../sdk.js";
import { NetworkError, Run402Error } from "../../sdk/dist/index.js";

export const serviceHealthSchema = {};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleServiceHealth(
  _args: Record<string, never>,
): Promise<McpResult> {
  let body: Awaited<ReturnType<ReturnType<typeof getSdk>["service"]["health"]>>;
  try {
    body = await getSdk().service.health();
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
      content: [{ type: "text", text: `Service /health check failed (${detail}).` }],
      isError: true,
    };
  }

  const lines: string[] = [
    `## Run402 Service Health`,
    ``,
    `Status: **${body?.status ?? "unknown"}**`,
  ];

  if (body?.version) {
    lines.push(`Version: \`${body.version}\``);
  }

  if (body?.checks && Object.keys(body.checks).length > 0) {
    lines.push(``);
    lines.push(`### Dependency checks`);
    for (const [name, state] of Object.entries(body.checks)) {
      lines.push(`- \`${name}\`: ${state}`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
