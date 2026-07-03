import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const projectKeyCacheExportSchema = {
  project_id: z.string().describe("Project ID to export from the local project-key credential cache"),
  reveal: z.boolean().describe("Must be true to emit secret key material"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleProjectKeyCacheExport(args: {
  project_id: string;
  reveal: boolean;
}): Promise<McpResult> {
  try {
    const keys = await getSdk().credentials.projectKeys.export(args.project_id, { reveal: args.reveal });

    const lines = [
      `## Local Project-Key Export: ${args.project_id}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| source | \`${keys.source}\` |`,
      `| anon_key | \`${keys.anon_key}\` |`,
      `| service_key | \`${keys.service_key}\` |`,
      `| site_url | ${keys.site_url ? `\`${keys.site_url}\`` : "(none)"} |`,
      `| cache_path | ${keys.cache_path ? `\`${keys.cache_path}\`` : "(unknown)"} |`,
      `| revealed | ${keys.revealed} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "exporting local project keys");
  }
}
