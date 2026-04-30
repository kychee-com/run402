import { z } from "zod";
import { getSdk } from "../sdk.js";
import { getApiBase } from "../config.js";
import { mapSdkError } from "../errors.js";

export const projectInfoSchema = {
  project_id: z.string().describe("Project ID to inspect"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleProjectInfo(args: {
  project_id: string;
}): Promise<McpResult> {
  try {
    const info = await getSdk().projects.info(args.project_id);
    const apiBase = getApiBase();

    const lines = [
      `## Project Info: ${args.project_id}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| project_id | \`${args.project_id}\` |`,
      `| rest_url | \`${apiBase}/rest/v1\` |`,
      `| anon_key | \`${info.anon_key}\` |`,
      `| service_key | \`${info.service_key}\` |`,
      `| site_url | ${info.site_url ? `\`${info.site_url}\`` : "(none)"} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "fetching project info");
  }
}
