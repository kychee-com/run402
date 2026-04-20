import { z } from "zod";
import { readFileSync, statSync, existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { apiRequest } from "../client.js";
import { getApiBase } from "../config.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

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

function sha256Hex(buf: Buffer | string): string {
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) h.update(chunk as Buffer);
  return h.digest("hex");
}

function guessContentType(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", webp: "image/webp",
    html: "text/html", css: "text/css", js: "text/javascript", json: "application/json",
    txt: "text/plain", md: "text/markdown", pdf: "application/pdf",
    zip: "application/zip", tgz: "application/gzip", gz: "application/gzip",
  };
  return map[ext] ?? "application/octet-stream";
}

export async function handleBlobPut(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  if ((args.local_path && args.content !== undefined) || (!args.local_path && args.content === undefined)) {
    return { content: [{ type: "text", text: "Provide exactly one of `local_path` or `content`." }], isError: true };
  }

  // Prepare body + size + sha256
  let bodyBuffer: Buffer | null = null;
  let sizeBytes: number;
  let sha256: string | undefined;

  if (args.content !== undefined) {
    bodyBuffer = Buffer.from(args.content, "utf8");
    sizeBytes = bodyBuffer.length;
    if (sizeBytes > 1_048_576) {
      return { content: [{ type: "text", text: "`content` is limited to 1 MB. Use `local_path` for larger uploads." }], isError: true };
    }
    if (args.immutable) sha256 = sha256Hex(bodyBuffer);
  } else {
    if (!existsSync(args.local_path!)) {
      return { content: [{ type: "text", text: `File not found: ${args.local_path}` }], isError: true };
    }
    sizeBytes = statSync(args.local_path!).size;
    if (args.immutable) sha256 = await sha256File(args.local_path!);
  }

  const contentType = args.content_type ?? guessContentType(args.key);

  // 1. Init
  const init = await apiRequest("/storage/v1/uploads", {
    method: "POST",
    headers: { apikey: project.anon_key, Authorization: `Bearer ${project.anon_key}` },
    body: {
      key: args.key,
      size_bytes: sizeBytes,
      content_type: contentType,
      visibility: args.visibility ?? "public",
      immutable: args.immutable ?? false,
      sha256,
    },
  });
  if (!init.ok) return formatApiError(init, "initializing upload");

  const initBody = init.body as {
    upload_id: string;
    mode: "single" | "multipart";
    parts: Array<{ part_number: number; url: string; byte_start: number; byte_end: number }>;
    part_count: number;
  };

  // 2. PUT each part (bytes direct to S3 — NOT through the gateway).
  //    Presigned URLs sign without ChecksumAlgorithm (see gateway
  //    s3-presign.ts); the client-asserted sha256 is the integrity
  //    attestation. No x-amz-checksum-sha256 header is sent.
  const partEtags: Array<{ etag: string }> = new Array(initBody.part_count);
  for (const part of initBody.parts) {
    const partBuffer = await readPart(bodyBuffer, args.local_path, part.byte_start, part.byte_end);
    const putRes = await fetch(part.url, { method: "PUT", body: partBuffer as unknown as BodyInit });
    if (!putRes.ok) {
      const errBody = await putRes.text().catch(() => "");
      return {
        content: [{ type: "text", text: `Part ${part.part_number} PUT failed: ${putRes.status} ${putRes.statusText}${errBody ? " — " + errBody.slice(0, 200) : ""}` }],
        isError: true,
      };
    }
    partEtags[part.part_number - 1] = {
      etag: (putRes.headers.get("etag") ?? "").replace(/^"|"$/g, ""),
    };
  }

  // 3. Complete
  const completeBody = initBody.mode === "multipart"
    ? { parts: partEtags.map((e, i) => ({ part_number: i + 1, etag: `"${e.etag}"` })) }
    : {};
  const complete = await apiRequest(`/storage/v1/uploads/${initBody.upload_id}/complete`, {
    method: "POST",
    headers: { apikey: project.anon_key, Authorization: `Bearer ${project.anon_key}` },
    body: completeBody,
  });
  if (!complete.ok) return formatApiError(complete, "completing upload");

  const result = complete.body as {
    key: string;
    size_bytes: number;
    sha256: string | null;
    visibility: "public" | "private";
    url: string | null;
    immutable_url: string | null;
  };

  const lines: string[] = [
    `Uploaded **${result.key}** (${result.size_bytes.toLocaleString()} bytes, ${result.visibility})`,
  ];
  if (result.url) lines.push(`URL: ${result.url}`);
  if (result.immutable_url) lines.push(`Immutable URL: ${result.immutable_url}`);
  if (result.sha256) lines.push(`SHA-256: ${result.sha256}`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function readPart(
  bodyBuffer: Buffer | null,
  localPath: string | undefined,
  start: number,
  end: number,
): Promise<Buffer> {
  if (bodyBuffer) return bodyBuffer.subarray(start, end + 1);
  if (!localPath) throw new Error("No source to read from");

  // Read a byte-range from the file. For multipart uploads we read each part
  // as needed; this avoids loading a 10 GiB file into memory up front.
  const fd = readFileSync(localPath);
  return fd.subarray(start, end + 1);
}

// Use `getApiBase` to make bundlers happy (even though we only reference it
// transitively via apiRequest). Keeps tree-shakers from dropping the import.
void getApiBase;
