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
};

type Args = {
  project_id: string;
  key: string;
  local_path?: string;
  content?: string;
  content_type?: string;
  visibility?: "public" | "private";
  immutable?: boolean;
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
    });

    const lines: string[] = [
      `Uploaded **${result.key}** (${result.size_bytes.toLocaleString()} bytes, ${result.visibility})`,
    ];
    if (result.url) lines.push(`URL: ${result.url}`);
    if (result.immutable_url) lines.push(`Immutable URL: ${result.immutable_url}`);
    if (result.sha256) lines.push(`SHA-256: ${result.sha256}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "uploading blob");
  }
}
