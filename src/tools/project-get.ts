import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const projectGetSchema = {
  project_id: z.string().describe("Project ID to read (authoritative server view; no keys)"),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleProjectGet(args: {
  project_id: string;
}): Promise<McpResult> {
  try {
    const p = await getSdk().projects.get(args.project_id);

    const lastDeploy = p.last_deploy
      ? `\`${p.last_deploy.release_id}\` @ ${p.last_deploy.activated_at}`
      : "(none)";
    const domains = p.custom_domains?.length ? p.custom_domains.join(", ") : "(none)";
    const mailbox = p.mailbox?.length ? p.mailbox.join(", ") : "(none)";
    const u = p.usage;
    const n = (v: number) => v.toLocaleString("en-US");

    const lines = [
      `## Project: ${p.name} (\`${p.project_id}\`)`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| public_id | \`${p.public_id}\` |`,
      `| org_id | \`${p.org_id}\` |`,
      `| tier | ${p.tier} |`,
      `| status | ${p.effective_status} (org: ${p.organization_lifecycle_state}) |`,
      `| site_url | ${p.site_url ? `\`${p.site_url}\`` : "(none)"} |`,
      `| custom_domains | ${domains} |`,
      `| last_deploy | ${lastDeploy} |`,
      `| mailbox | ${mailbox} |`,
      `| api_calls | ${n(u.api_calls)} / ${n(u.api_calls_limit)} |`,
      `| storage_bytes | ${n(u.storage_bytes)} / ${n(u.storage_bytes_limit)} |`,
      `| created_at | ${p.created_at} |`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "getting project");
  }
}
