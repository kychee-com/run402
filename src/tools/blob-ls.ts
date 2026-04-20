import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const blobLsSchema = {
  project_id: z.string().describe("Project ID"),
  prefix: z.string().optional().describe("Filter: only return blobs whose key starts with this prefix"),
  limit: z.number().int().min(1).max(1000).optional().describe("Max results (default 100, max 1000)"),
  cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor"),
};

type Args = { project_id: string; prefix?: string; limit?: number; cursor?: string };

export async function handleBlobLs(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const qs = new URLSearchParams();
  if (args.prefix) qs.set("prefix", args.prefix);
  if (args.limit) qs.set("limit", String(args.limit));
  if (args.cursor) qs.set("cursor", args.cursor);

  const res = await apiRequest(`/storage/v1/blobs${qs.toString() ? "?" + qs.toString() : ""}`, {
    headers: { apikey: project.anon_key, Authorization: `Bearer ${project.anon_key}` },
  });
  if (!res.ok) return formatApiError(res, "listing blobs");

  const body = res.body as {
    blobs: Array<{ key: string; size_bytes: number; content_type: string | null; visibility: string; created_at: string }>;
    next_cursor: string | null;
  };

  if (body.blobs.length === 0) {
    return { content: [{ type: "text", text: args.prefix ? `No blobs matching prefix \`${args.prefix}\`` : "No blobs in project." }] };
  }

  const header = "| Key | Size | Visibility | Content-Type | Created |\n|---|---|---|---|---|";
  const rows = body.blobs.map((b) =>
    `| \`${b.key}\` | ${b.size_bytes.toLocaleString()} | ${b.visibility} | ${b.content_type ?? "—"} | ${b.created_at} |`,
  ).join("\n");
  const more = body.next_cursor ? `\n\nMore results available — pass \`cursor: "${body.next_cursor}"\` to the next call.` : "";
  return { content: [{ type: "text", text: `${header}\n${rows}${more}` }] };
}
