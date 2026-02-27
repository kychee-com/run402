import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";

export const uploadFileSchema = {
  project_id: z.string().describe("The project ID"),
  bucket: z.string().describe("Storage bucket name"),
  path: z.string().describe("File path within the bucket (e.g. 'logs/2024-01-01.txt')"),
  content: z.string().describe("Text content to upload"),
  content_type: z
    .string()
    .default("text/plain")
    .describe("MIME type (default: text/plain)"),
};

export async function handleUploadFile(args: {
  project_id: string;
  bucket: string;
  path: string;
  content: string;
  content_type?: string;
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

  const contentType = args.content_type || "text/plain";
  const apiPath = `/storage/v1/object/${args.bucket}/${args.path}`;

  const res = await apiRequest(apiPath, {
    method: "POST",
    rawBody: args.content,
    headers: {
      "Content-Type": contentType,
      apikey: project.anon_key,
      Authorization: `Bearer ${project.anon_key}`,
    },
  });

  if (!res.ok) {
    const body = res.body as Record<string, unknown>;
    const msg = (body.error as string) || `HTTP ${res.status}`;
    return {
      content: [{ type: "text", text: `Upload Error: ${msg}` }],
      isError: true,
    };
  }

  const body = res.body as { key: string; size: number };
  return {
    content: [
      {
        type: "text",
        text: `File uploaded: **${body.key}** (${body.size} bytes)`,
      },
    ],
  };
}
