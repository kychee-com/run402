import { z } from "zod";
import { getProject } from "../keystore.js";
import { projectNotFound } from "../errors.js";

export const projectKeysSchema = {
  project_id: z.string().describe("Project ID to get keys for"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleProjectKeys(args: {
  project_id: string;
}): Promise<McpResult> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const lines = [
    `## Project Keys: ${args.project_id}`,
    ``,
    `| Key | Value |`,
    `|-----|-------|`,
    `| anon_key | \`${project.anon_key}\` |`,
    `| service_key | \`${project.service_key}\` |`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
