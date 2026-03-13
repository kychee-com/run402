import { z } from "zod";
import { apiRequest } from "../client.js";
import { getProject } from "../keystore.js";
import { formatApiError, projectNotFound } from "../errors.js";

export const updateVersionSchema = {
  project_id: z.string().describe("The project ID"),
  version_id: z.string().describe("The version ID to update"),
  description: z.string().optional().describe("Updated description"),
  tags: z.array(z.string()).optional().describe("Updated tags"),
  visibility: z.enum(["public", "unlisted", "private"]).optional().describe("Updated visibility"),
  fork_allowed: z.boolean().optional().describe("Whether forking is allowed"),
};

export async function handleUpdateVersion(args: {
  project_id: string;
  version_id: string;
  description?: string;
  tags?: string[];
  visibility?: string;
  fork_allowed?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const body: Record<string, unknown> = {};
  if (args.description !== undefined) body.description = args.description;
  if (args.tags !== undefined) body.tags = args.tags;
  if (args.visibility !== undefined) body.visibility = args.visibility;
  if (args.fork_allowed !== undefined) body.fork_allowed = args.fork_allowed;

  const res = await apiRequest(
    `/projects/v1/admin/${args.project_id}/versions/${args.version_id}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body,
    },
  );

  if (!res.ok) return formatApiError(res, "updating version");

  return {
    content: [{ type: "text", text: `Version \`${args.version_id}\` updated.` }],
  };
}
