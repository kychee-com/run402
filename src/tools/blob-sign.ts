import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const blobSignSchema = {
  project_id: z.string().describe("Project ID"),
  key: z.string().describe("Blob key to sign a GET URL for"),
  ttl_seconds: z.number().int().min(60).max(604800).optional().describe("URL lifetime in seconds (60 – 604 800, default 3600)"),
};

type Args = { project_id: string; key: string; ttl_seconds?: number };

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export async function handleBlobSign(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/storage/v1/blob/${encodeKey(args.key)}/sign`, {
    method: "POST",
    headers: { apikey: project.anon_key, Authorization: `Bearer ${project.anon_key}` },
    body: args.ttl_seconds !== undefined ? { ttl_seconds: args.ttl_seconds } : {},
  });
  if (!res.ok) return formatApiError(res, "signing blob URL");

  const body = res.body as { signed_url: string; expires_at: string; expires_in: number };
  return {
    content: [{
      type: "text",
      text: `Signed URL for \`${args.key}\` (expires in ${body.expires_in} seconds, at ${body.expires_at}):\n\n${body.signed_url}`,
    }],
  };
}
