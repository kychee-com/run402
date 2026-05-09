import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type { ProjectRestMethod } from "../../sdk/dist/index.js";

export const restQuerySchema = {
  project_id: z.string().describe("The project ID"),
  table: z.string().describe("Table name to query"),
  method: z
    .enum(["GET", "POST", "PATCH", "DELETE"])
    .default("GET")
    .describe("HTTP method"),
  params: z
    .record(z.string())
    .optional()
    .describe("PostgREST query params (e.g. {select: 'id,name', order: 'id.asc', limit: '10'})"),
  body: z
    .unknown()
    .optional()
    .describe("Request body for POST/PATCH (JSON object or array)"),
  key_type: z
    .enum(["anon", "service"])
    .default("anon")
    .describe("Which key to use: anon (default, respects RLS) or service (bypasses RLS)"),
};

export async function handleRestQuery(args: {
  project_id: string;
  table: string;
  method?: string;
  params?: Record<string, string>;
  body?: unknown;
  key_type?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const method = (args.method || "GET") as ProjectRestMethod;
  let status: number;
  let body: unknown;
  try {
    const response = await getSdk().projects.restResponse(args.project_id, args.table, {
      method,
      query: args.params,
      body: args.body,
      keyType: args.key_type === "service" ? "service" : "anon",
    });
    status = response.status;
    body = response.body;
  } catch (err) {
    return mapSdkError(err, "querying REST API");
  }

  const text =
    typeof body === "string"
      ? body
      : JSON.stringify(body, null, 2);

  return {
    content: [
      {
        type: "text",
        text: `**${method} /rest/v1/${args.table}** → ${status}\n\n\`\`\`json\n${text}\n\`\`\``,
      },
    ],
  };
}
