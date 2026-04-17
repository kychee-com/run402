import { apiRequest } from "../client.js";

export const serviceHealthSchema = {};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

interface HealthPayload {
  status?: string;
  checks?: Record<string, string>;
  version?: string;
}

export async function handleServiceHealth(
  _args: Record<string, never>,
): Promise<McpResult> {
  const res = await apiRequest("/health", { method: "GET" });

  if (!res.ok) {
    const bodyMsg = (res.body as { error?: string })?.error;
    const detail = res.status === 0
      ? `network error${bodyMsg ? `: ${bodyMsg}` : ""}`
      : `HTTP ${res.status}`;
    return {
      content: [{ type: "text", text: `Service /health check failed (${detail}).` }],
      isError: true,
    };
  }

  const body = res.body as HealthPayload;

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
