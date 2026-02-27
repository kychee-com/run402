import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";

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
  const project = getProject(args.project_id);
  if (!project) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Project \`${args.project_id}\` not found in key store. Provision a project first.`,
        },
      ],
      isError: true,
    };
  }

  const method = args.method || "GET";
  const keyType = args.key_type || "anon";
  const key = keyType === "service" ? project.service_key : project.anon_key;

  // Build query string from params
  let queryStr = "";
  if (args.params && Object.keys(args.params).length > 0) {
    const sp = new URLSearchParams(args.params);
    queryStr = `?${sp.toString()}`;
  }

  const path = `/rest/v1/${args.table}${queryStr}`;
  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };

  // For mutating requests, ask PostgREST to return the result
  if (method !== "GET") {
    headers["Prefer"] = "return=representation";
  }

  const res = await apiRequest(path, {
    method,
    headers,
    body: args.body,
  });

  if (!res.ok) {
    const body = res.body as Record<string, unknown>;
    const msg =
      (body.message as string) ||
      (body.error as string) ||
      `HTTP ${res.status}`;
    return {
      content: [{ type: "text", text: `REST Error: ${msg}` }],
      isError: true,
    };
  }

  const text =
    typeof res.body === "string"
      ? res.body
      : JSON.stringify(res.body, null, 2);

  return {
    content: [
      {
        type: "text",
        text: `**${method} /rest/v1/${args.table}** → ${res.status}\n\n\`\`\`json\n${text}\n\`\`\``,
      },
    ],
  };
}
