import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const blobLsSchema = {
  project_id: z.string().describe("Project ID"),
  prefix: z.string().optional().describe("Filter: only return blobs whose key starts with this prefix"),
  limit: z.number().int().min(1).max(1000).optional().describe("Max results (default 100, max 1000)"),
  cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor"),
};

type Args = { project_id: string; prefix?: string; limit?: number; cursor?: string };

export async function handleBlobLs(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().assets.ls(args.project_id, {
      prefix: args.prefix,
      limit: args.limit,
      cursor: args.cursor,
    });

    if (body.assets.length === 0) {
      return { content: [{ type: "text", text: args.prefix ? `No blobs matching prefix \`${args.prefix}\`` : "No blobs in project." }] };
    }

    const header = "| Key | Size | Visibility | Content-Type | Created |\n|---|---|---|---|---|";
    const rows = body.assets.map((b) =>
      `| \`${b.key}\` | ${b.size_bytes.toLocaleString()} | ${b.visibility} | ${b.content_type ?? "—"} | ${b.created_at} |`,
    ).join("\n");
    const more = body.next_cursor ? `\n\nMore results available — pass \`cursor: "${body.next_cursor}"\` to the next call.` : "";
    return { content: [{ type: "text", text: `${header}\n${rows}${more}` }] };
  } catch (err) {
    return mapSdkError(err, "listing blobs");
  }
}
