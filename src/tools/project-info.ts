import { z } from "zod";
import { getProject } from "../keystore.js";
import { getApiBase } from "../config.js";
import { projectNotFound } from "../errors.js";

export const projectInfoSchema = {
  project_id: z.string().describe("Project ID to inspect"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleProjectInfo(args: {
  project_id: string;
}): Promise<McpResult> {
  const project = getProject(args.project_id);
  if (!project) return projectNotFound(args.project_id);

  const apiBase = getApiBase();

  const lines = [
    `## Project Info: ${args.project_id}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| project_id | \`${args.project_id}\` |`,
    `| rest_url | \`${apiBase}/rest/v1\` |`,
    `| anon_key | \`${project.anon_key}\` |`,
    `| service_key | \`${project.service_key}\` |`,
    `| site_url | ${project.site_url ? `\`${project.site_url}\`` : "(none)"} |`,
    `| deployed_at | ${project.deployed_at || "(never)"} |`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
