import { z } from "zod";
import { paidApiRequest } from "../paid-fetch.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const invokeFunctionSchema = {
  project_id: z.string().describe("The project ID"),
  name: z.string().describe("Function name to invoke"),
  method: z
    .string()
    .optional()
    .describe("HTTP method (default: POST)"),
  body: z
    .union([z.string(), z.record(z.unknown())])
    .optional()
    .describe("Request body (string or JSON object)"),
  headers: z
    .record(z.string())
    .optional()
    .describe("Additional headers to send"),
};

export async function handleInvokeFunction(args: {
  project_id: string;
  name: string;
  method?: string;
  body?: string | Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const method = args.method || "POST";
  const requestHeaders: Record<string, string> = {
    apikey: project.service_key,
    ...(args.headers || {}),
  };

  const startTime = Date.now();

  const res = await paidApiRequest(`/functions/v1/${args.name}`, {
    method,
    headers: requestHeaders,
    body: method !== "GET" && method !== "HEAD" ? args.body : undefined,
  });

  const durationMs = Date.now() - startTime;

  if (res.is402) {
    const body = res.body as Record<string, unknown>;
    return {
      content: [
        {
          type: "text",
          text: `## Payment Required\n\nAPI call limit exceeded. Renew or upgrade your project.\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``,
        },
      ],
    };
  }

  if (!res.ok) return formatApiError(res, "invoking function");

  const bodyStr = typeof res.body === "string"
    ? res.body
    : JSON.stringify(res.body, null, 2);

  const lines = [
    `## Function Response`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| status | ${res.status} |`,
    `| duration | ${durationMs}ms |`,
    ``,
    `**Response body:**`,
    `\`\`\`json`,
    bodyStr,
    `\`\`\``,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
