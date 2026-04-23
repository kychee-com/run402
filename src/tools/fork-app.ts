import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

export const forkAppSchema = {
  version_id: z.string().describe("The app version ID to fork (from browse_apps)"),
  name: z.string().describe("Name for the new forked project"),
  subdomain: z
    .string()
    .optional()
    .describe("Optional subdomain to claim for the forked app"),
};

export async function handleForkApp(args: {
  version_id: string;
  name: string;
  subdomain?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/fork/v1");
  if ("error" in auth) return auth.error;

  try {
    const body = await getSdk().apps.fork({
      versionId: args.version_id,
      name: args.name,
      subdomain: args.subdomain,
    });

    const lines = [
      `## App Forked: ${args.name}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| project_id | \`${body.project_id}\` |`,
      `| schema | ${body.schema_slot} |`,
    ];

    if (body.site_url) {
      lines.push(`| site | ${body.site_url} |`);
    }
    if (body.subdomain_url) {
      lines.push(`| subdomain | ${body.subdomain_url} |`);
    }

    lines.push(``);
    lines.push(`Keys saved to local key store.`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "forking app");
  }
}
