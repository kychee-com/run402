import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

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
  idempotency_key: z
    .string()
    .optional()
    .describe("Stable Idempotency-Key required by paid function invocations. Reuse it for the same paid intent; use a new key only for a new paid intent."),
  wait: z
    .boolean()
    .optional()
    .describe("When a paid invocation returns a 202 run handle, poll the run and replay the same idempotency key for the retained result."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum wait time in milliseconds when wait is true."),
  poll_interval_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Polling interval in milliseconds when wait is true."),
};

export async function handleInvokeFunction(args: {
  project_id: string;
  name: string;
  method?: string;
  body?: string | Record<string, unknown>;
  headers?: Record<string, string>;
  idempotency_key?: string;
  wait?: boolean;
  timeout_ms?: number;
  poll_interval_ms?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const wait = args.wait
      ? {
          ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
          ...(args.poll_interval_ms !== undefined ? { intervalMs: args.poll_interval_ms } : {}),
        }
      : undefined;
    const result = await getSdk().functions.invoke(args.project_id, args.name, {
      method: args.method,
      body: args.body,
      headers: args.headers,
      idempotencyKey: args.idempotency_key,
      wait,
    });

    const bodyStr = typeof result.body === "string"
      ? result.body
      : JSON.stringify(result.body, null, 2);

    const lines = [
      `## Function Response`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| status | ${result.status} |`,
      `| duration | ${result.duration_ms}ms |`,
      ``,
      `**Response body:**`,
      `\`\`\`json`,
      bodyStr,
      `\`\`\``,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "invoking function");
  }
}
