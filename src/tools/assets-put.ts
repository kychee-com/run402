import { z } from "zod";
import { readFileSync, statSync, existsSync } from "node:fs";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type {
  BlobPutResult,
  BlobPutSource,
} from "../../sdk/dist/namespaces/assets.types.js";

export const blobPutSchema = {
  project_id: z.string().describe("Project ID"),
  key: z.string().describe("Destination key (path in the project's blob namespace). No leading slash. Example: 'images/logo.png' or 'circuits/v1.zkey'."),
  local_path: z.string().optional().describe("Path to a local file to upload. Mutually exclusive with `content`."),
  content: z.string().optional().describe("Inline content to upload (UTF-8 string). For small blobs ≤ 1 MB. Mutually exclusive with `local_path`."),
  content_type: z.string().optional().describe("MIME type (auto-detected from file extension if omitted)."),
  visibility: z.enum(["public", "private"]).optional().describe("Default: public. Public blobs get a CDN URL; private blobs require authenticated reads."),
  immutable: z.boolean().optional().describe("When true, the returned URL includes a content-hash suffix so overwrites produce distinct URLs. CLI auto-computes sha256."),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional().describe("v1.50: caller-provided flat metadata stored alongside the asset. Object with string / number / boolean / string[] leaves; ≤4 KB serialized. Nested objects rejected with INVALID_ASSET_METADATA (HTTP 400)."),
  exif_policy: z.enum(["keep", "strip"]).optional().describe("v1.50: EXIF retention policy for image uploads. Default 'keep'. 'strip' discards EXIF from the stored bytes and the image_exif response field."),
};

type Args = {
  project_id: string;
  key: string;
  local_path?: string;
  content?: string;
  content_type?: string;
  visibility?: "public" | "private";
  immutable?: boolean;
  metadata?: Record<string, string | number | boolean | string[]>;
  exif_policy?: "keep" | "strip";
};

export async function handleBlobPut(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if ((args.local_path && args.content !== undefined) || (!args.local_path && args.content === undefined)) {
    return { content: [{ type: "text", text: "Provide exactly one of `local_path` or `content`." }], isError: true };
  }

  try {
    const sdk = getSdk();
    let source: BlobPutSource;
    if (args.content !== undefined) {
      source = { content: args.content };
    } else {
      const path = args.local_path!;
      if (!existsSync(path)) {
        return { content: [{ type: "text", text: `File not found: ${path}` }], isError: true };
      }
      const stat = statSync(path);
      if (!stat.isFile()) {
        return { content: [{ type: "text", text: `local_path must point to a regular file: ${path}` }], isError: true };
      }
      source = { bytes: new Uint8Array(readFileSync(path)) };
    }

    const result: BlobPutResult = await sdk.assets.put(args.project_id, args.key, source, {
      contentType: args.content_type,
      visibility: args.visibility,
      immutable: args.immutable,
      metadata: args.metadata,
      exifPolicy: args.exif_policy,
    });

    const lines: string[] = [
      `Uploaded **${result.key}** (${result.size_bytes.toLocaleString()} bytes, ${result.visibility})`,
    ];
    if (result.url) lines.push(`URL: ${result.url}`);
    if (result.immutable_url) lines.push(`Immutable URL: ${result.immutable_url}`);
    if (result.sha256) lines.push(`SHA-256: ${result.sha256}`);
    // v1.49+ image-variant fields. Present only for image MIMEs uploaded
    // against a v1.49+ gateway; absent for non-images. We surface them so
    // the LLM can directly read the dimensions / variant URLs from the
    // tool output without a separate roundtrip.
    if (result.width_px !== undefined && result.height_px !== undefined) {
      lines.push(`Dimensions: ${result.width_px}×${result.height_px}`);
    }
    if (result.blurhash) lines.push(`Blurhash: ${result.blurhash}`);
    if (result.display_url && result.display_url !== result.cdnUrl) {
      // Only print when display_url differs (HEIC sources); for non-HEIC
      // images display_url === cdn_url and the existing URL line covers it.
      lines.push(`Display URL: ${result.display_url}`);
    }
    if (result.variants) {
      const kinds: string[] = [];
      if (result.variants.thumb) kinds.push(`thumb (${result.variants.thumb.width_px}w WebP)`);
      if (result.variants.medium) kinds.push(`medium (${result.variants.medium.width_px}w WebP)`);
      if (result.variants.large) kinds.push(`large (${result.variants.large.width_px}w WebP)`);
      if (result.variants.display_jpeg) kinds.push(`display_jpeg (${result.variants.display_jpeg.width_px}w JPEG)`);
      if (kinds.length > 0) lines.push(`Variants: ${kinds.join(", ")}`);
    }
    // v1.50: surface metadata + EXIF policy + intrinsic image info so an
    // agent can keep reasoning about the upload without a follow-up roundtrip.
    if (result.image_format) lines.push(`Image format: ${result.image_format}`);
    if (result.image_info) lines.push(`Image info: ${summarizeRecord(result.image_info)}`);
    if (result.image_exif_policy) lines.push(`EXIF policy: ${result.image_exif_policy}`);
    if (result.image_exif) lines.push(`EXIF: ${summarizeRecord(result.image_exif)}`);
    if (result.metadata && Object.keys(result.metadata).length > 0) {
      lines.push(`Metadata: ${JSON.stringify(result.metadata)}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "uploading blob");
  }
}

function summarizeRecord(rec: Record<string, unknown>): string {
  const keys = Object.keys(rec);
  if (keys.length === 0) return "{}";
  const parts: string[] = [];
  for (const k of keys.slice(0, 6)) {
    const v = rec[k];
    if (v === null || v === undefined) parts.push(`${k}=null`);
    else if (typeof v === "object") parts.push(`${k}={…}`);
    else parts.push(`${k}=${String(v)}`);
  }
  if (keys.length > parts.length) parts.push(`…(+${keys.length - parts.length} more)`);
  return parts.join(", ");
}
