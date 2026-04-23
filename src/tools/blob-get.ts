import { z } from "zod";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const blobGetSchema = {
  project_id: z.string().describe("Project ID"),
  key: z.string().describe("Blob key to download"),
  output_path: z.string().describe("Local filesystem path to write the bytes to. Parent directories will be created."),
};

type Args = { project_id: string; key: string; output_path: string };

export async function handleBlobGet(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  let res: Response;
  try {
    res = await getSdk().blobs.get(args.project_id, args.key);
  } catch (err) {
    return mapSdkError(err, "downloading blob");
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
