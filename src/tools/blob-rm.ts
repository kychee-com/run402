import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const blobRmSchema = {
  project_id: z.string().describe("Project ID"),
  key: z.string().describe("Blob key to delete"),
};

type Args = { project_id: string; key: string };

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export async function handleBlobRm(args: Args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/storage/v1/blob/${encodeKey(args.key)}`, {
    method: "DELETE",
    headers: { apikey: project.anon_key, Authorization: `Bearer ${project.anon_key}` },
  });
  if (!res.ok) return formatApiError(res, "deleting blob");

  return { content: [{ type: "text", text: `Deleted \`${args.key}\`.` }] };
}
