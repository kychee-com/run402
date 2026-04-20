import { z } from "zod";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getApiBase } from "../config.js";
import { getProject } from "../keystore.js";
import { projectNotFound } from "../errors.js";

export const blobGetSchema = {
  project_id: z.string().describe("Project ID"),
  key: z.string().describe("Blob key to download"),
  output_path: z.string().describe("Local filesystem path to write the bytes to. Parent directories will be created."),
};

type Args = { project_id: string; key: string; output_path: string };

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export async function handleBlobGet(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const url = `${getApiBase()}/storage/v1/blob/${encodeKey(args.key)}`;
  const res = await fetch(url, {
    headers: { apikey: project.anon_key, Authorization: `Bearer ${project.anon_key}` },
  });
  if (!res.ok) {
    return { content: [{ type: "text", text: `GET ${args.key} failed: HTTP ${res.status}` }], isError: true };
  }
  if (!res.body) {
    return { content: [{ type: "text", text: "Empty response body" }], isError: true };
  }

  const outPath = resolve(args.output_path);
  mkdirSync(dirname(outPath), { recursive: true });
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  const sha256 = res.headers.get("x-run402-sha256");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(outPath));

  const lines: string[] = [
    `Downloaded **${args.key}** → ${outPath}`,
  ];
  if (contentLength > 0) lines.push(`Size: ${contentLength.toLocaleString()} bytes`);
  if (sha256) lines.push(`SHA-256: ${sha256}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
