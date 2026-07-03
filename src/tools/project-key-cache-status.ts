import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const projectKeyCacheStatusSchema = {
  project_id: z.string().describe("Project ID to inspect in the local project-key credential cache"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleProjectKeyCacheStatus(args: {
  project_id: string;
}): Promise<McpResult> {
  try {
    const status = await getSdk().credentials.projectKeys.status(args.project_id);

    const lines = [
      `## Local Project-Key Cache: ${args.project_id}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| source | \`${status.source}\` |`,
      `| configured | ${status.configured} |`,
      `| has_anon_key | ${status.has_anon_key} |`,
      `| has_service_key | ${status.has_service_key} |`,
      `| anon_key_prefix | ${status.anon_key_prefix ? `\`${status.anon_key_prefix}\`` : "(none)"} |`,
      `| service_key_prefix | ${status.service_key_prefix ? `\`${status.service_key_prefix}\`` : "(none)"} |`,
      `| anon_key_fingerprint | ${status.anon_key_fingerprint ? `\`${status.anon_key_fingerprint}\`` : "(none)"} |`,
      `| service_key_fingerprint | ${status.service_key_fingerprint ? `\`${status.service_key_fingerprint}\`` : "(none)"} |`,
      `| site_url | ${status.site_url ? `\`${status.site_url}\`` : "(none)"} |`,
      `| cached_at | ${status.cached_at ?? "(unknown)"} |`,
      `| profile | ${status.profile ? `\`${status.profile}\`` : "(unknown)"} |`,
      `| cache_path | ${status.cache_path ? `\`${status.cache_path}\`` : "(unknown)"} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "reading local project-key cache status");
  }
}
