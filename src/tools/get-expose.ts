import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const getExposeSchema = {
  project_id: z.string().describe("The project ID"),
};

export async function handleGetExpose(args: {
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const res = await apiRequest(`/projects/v1/admin/${args.project_id}/expose`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${project.service_key}`,
    },
  });

  if (!res.ok) return formatApiError(res, "fetching expose manifest");

  const body = res.body as {
    status: string;
    project_id: string;
    source: "applied" | "introspected";
    manifest: {
      version: string;
      tables: Array<Record<string, unknown>>;
      views: Array<Record<string, unknown>>;
      rpcs: Array<Record<string, unknown>>;
    };
  };

  const sourceNote =
    body.source === "applied"
      ? "from the last-applied manifest recorded in `internal.project_manifest`"
      : "reconstructed by introspecting live DB state (no manifest has ever been applied)";

  const lines = [
    `## Expose Manifest (source: ${body.source})`,
    ``,
    `_${sourceNote}_`,
    ``,
    "```json",
    JSON.stringify(body.manifest, null, 2),
    "```",
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
