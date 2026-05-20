import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type { AssetFilter, AssetSortKey } from "../../sdk/dist/namespaces/assets.types.js";

export const blobLsSchema = {
  project_id: z.string().describe("Project ID"),
  prefix: z.string().optional().describe("Filter: only return blobs whose key starts with this prefix"),
  limit: z.number().int().min(1).max(1000).optional().describe("Max results (default 100, max 1000)"),
  cursor: z.string().optional().describe("Pagination cursor from a previous response's next_cursor. v1.50: cursor is sort-pinned — reuse with a different `sort` returns 400 INVALID_CURSOR_FOR_SORT."),
  sort: z.enum(["key:asc", "createdAt:asc", "createdAt:desc"]).optional().describe("v1.50: result ordering. Default 'key:asc' (legacy bare-key cursor). 'createdAt:*' variants use a base64url JSON cursor."),
  filter: z.object({
    uploaded_by: z.string().optional().describe("Match uploaded_by exactly."),
    tag: z.string().optional().describe("Match a metadata.tags[] element (case-sensitive)."),
    format: z.string().optional().describe("Match decoded image_format exactly (e.g. 'webp')."),
    is_image: z.boolean().optional().describe("Restrict to image (true) or non-image (false) rows."),
    min_width: z.number().int().min(0).optional(),
    max_width: z.number().int().min(0).optional(),
    min_height: z.number().int().min(0).optional(),
    max_height: z.number().int().min(0).optional(),
  }).optional().describe("v1.50: media-picker filter. Unknown keys are rejected with INVALID_FILTER_KEY before any HTTP call."),
};

type Args = {
  project_id: string;
  prefix?: string;
  limit?: number;
  cursor?: string;
  sort?: AssetSortKey;
  filter?: AssetFilter;
};

export async function handleBlobLs(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const body = await getSdk().assets.ls(args.project_id, {
      prefix: args.prefix,
      limit: args.limit,
      cursor: args.cursor,
      sort: args.sort,
      filter: args.filter,
    });

    if (body.blobs.length === 0) {
      return { content: [{ type: "text", text: args.prefix ? `No assets matching prefix \`${args.prefix}\`` : "No assets in project." }] };
    }

    const header = "| Key | Size | Visibility | Content-Type | Image | Metadata | Created |\n|---|---|---|---|---|---|---|";
    const rows = body.blobs.map((b) => {
      // v1.50: render a compact image summary (format + dimensions + a
      // single-line EXIF / image_info digest) and the caller-supplied
      // metadata bag. Pre-v1.50 rows have these fields absent — render as
      // an em-dash to keep the table aligned.
      const imageBits: string[] = [];
      if (b.image_format) imageBits.push(b.image_format);
      if (b.width_px !== undefined && b.height_px !== undefined) {
        imageBits.push(`${b.width_px}×${b.height_px}`);
      }
      if (b.image_exif_policy) imageBits.push(`exif=${b.image_exif_policy}`);
      const infoSummary = b.image_info ? summarizeRecord(b.image_info) : "";
      if (infoSummary) imageBits.push(infoSummary);
      const imageCol = imageBits.length === 0 ? "—" : imageBits.join("; ");
      const metaCol = b.metadata && Object.keys(b.metadata).length > 0
        ? JSON.stringify(b.metadata)
        : "—";
      return `| \`${b.key}\` | ${b.size_bytes.toLocaleString()} | ${b.visibility} | ${b.content_type ?? "—"} | ${imageCol} | ${metaCol} | ${b.created_at} |`;
    }).join("\n");
    const more = body.next_cursor ? `\n\nMore results available — pass \`cursor: "${body.next_cursor}"\` to the next call.` : "";
    return { content: [{ type: "text", text: `${header}\n${rows}${more}` }] };
  } catch (err) {
    return mapSdkError(err, "listing blobs");
  }
}

function summarizeRecord(rec: Record<string, unknown>): string {
  const keys = Object.keys(rec);
  if (keys.length === 0) return "";
  const parts: string[] = [];
  for (const k of keys.slice(0, 3)) {
    const v = rec[k];
    if (v === null || v === undefined) parts.push(`${k}=null`);
    else if (typeof v === "object") parts.push(`${k}={…}`);
    else parts.push(`${k}=${String(v)}`);
  }
  if (keys.length > parts.length) parts.push(`+${keys.length - parts.length}`);
  return parts.join(",");
}
