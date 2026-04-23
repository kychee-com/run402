import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { PaymentRequired } from "../../sdk/dist/index.js";

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
  try {
    const result = await getSdk().functions.invoke(args.project_id, args.name, {
      method: args.method,
      body: args.body,
      headers: args.headers,
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
    if (err instanceof PaymentRequired) {
      const body = (err.body ?? {}) as Record<string, unknown>;
      return {
        content: [
          {
            type: "text",
            text: `## Payment Required\n\nAPI call limit exceeded. Renew or upgrade your project.\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``,
          },
        ],
      };
    }
    return mapSdkError(err, "invoking function");
  }
}
