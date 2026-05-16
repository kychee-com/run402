import { z } from "zod";
import { createReadStream, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import type {
  BlobPutResult,
  BlobPutSource,
  BlobUploadPart,
} from "../../sdk/dist/namespaces/blobs.types.js";

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
    let result: BlobPutResult;
    if (args.content !== undefined) {
      const source: BlobPutSource = { content: args.content };
      result = await sdk.blobs.put(args.project_id, args.key, source, {
        contentType: args.content_type,
        visibility: args.visibility,
        immutable: args.immutable,
      });
    } else {
      if (!existsSync(args.local_path!)) {
        return { content: [{ type: "text", text: `File not found: ${args.local_path}` }], isError: true };
      }
      result = await uploadLocalPath(args);
    }

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

async function uploadLocalPath(args: Args): Promise<BlobPutResult> {
  const path = args.local_path!;
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`local_path must point to a regular file: ${path}`);
  }
  const sdk = getSdk();
  const contentType = args.content_type ?? guessContentType(args.key);
  const sha256 = await sha256File(path);
  const init = await sdk.blobs.initUploadSession(args.project_id, {
    key: args.key,
    size_bytes: stat.size,
    content_type: contentType,
    visibility: args.visibility,
    immutable: args.immutable,
    sha256,
  });

  const parts: Array<{ etag: string; sha256: string }> = new Array(init.part_count);
  for (const part of init.parts) {
    const uploaded = await putPart(path, part);
    parts[part.part_number - 1] = uploaded;
  }
  const completeBody = init.mode === "multipart"
    ? { parts: parts.map((part, index) => ({ part_number: index + 1, etag: part.etag, sha256: part.sha256 })) }
    : {};
  return sdk.blobs.completeUploadSession(args.project_id, init.upload_id, completeBody, {
    contentType,
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function putPart(path: string, part: BlobUploadPart): Promise<{ etag: string; sha256: string }> {
  const body = await readRange(path, part.byte_start, part.byte_end);
  const checksum = sha256BufferHexAndBase64(body);
  const res = await fetch(part.url, {
    method: "PUT",
    headers: checksumHeadersForPresignedUrl(part.url, checksum.base64),
    body: body as unknown as BodyInit,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Part ${part.part_number} PUT failed: ${res.status} ${res.statusText}${detail ? " - " + detail.slice(0, 200) : ""}`,
    );
  }
  return {
    etag: res.headers.get("etag") ?? "",
    sha256: checksum.hex,
  };
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = createReadStream(path, { start, end });
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sha256BufferHexAndBase64(body: Buffer): { hex: string; base64: string } {
  const digest = createHash("sha256").update(body).digest();
  return {
    hex: digest.toString("hex"),
    base64: digest.toString("base64"),
  };
}

function checksumHeadersForPresignedUrl(url: string, checksumBase64: string): Record<string, string> {
  try {
    if (new URL(url).searchParams.has("x-amz-checksum-sha256")) return {};
  } catch {
    return { "x-amz-checksum-sha256": checksumBase64 };
  }
  return { "x-amz-checksum-sha256": checksumBase64 };
}

function guessContentType(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    pdf: "application/pdf",
    zip: "application/zip",
    tgz: "application/gzip",
    gz: "application/gzip",
  };
  return map[ext] ?? "application/octet-stream";
}
