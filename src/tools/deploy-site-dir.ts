import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { updateProject } from "../keystore.js";

export const deploySiteDirSchema = {
  project: z
    .string()
    .describe("Project ID to link this deployment to"),
  dir: z
    .string()
    .describe(
      "Local directory to deploy. The SDK walks this directory, hashes each file, and uploads only bytes the gateway doesn't already have via the v1.32 plan/commit transport. Files named .git, node_modules, or .DS_Store are skipped. Symlinks are rejected.",
    ),
  target: z
    .string()
    .optional()
    .describe("Deployment target (e.g. 'production'). Tracked in DB for future alias support."),
};

export async function handleDeploySiteDir(args: {
  project: string;
  dir: string;
  target?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/deploy/v1/plan");
  if ("error" in auth) return auth.error;

  try {
    const body = await getSdk().sites.deployDir({
      project: args.project,
      dir: args.dir,
      target: args.target,
    });

    updateProject(args.project, { last_deployment_id: body.deployment_id });

    const rows = [
      `| deployment_id | \`${body.deployment_id}\` |`,
      `| url | ${body.url} |`,
      `| source | \`${args.dir}\` |`,
    ];
    if (body.bytes_total !== undefined) {
      rows.push(`| bytes_total | ${body.bytes_total} |`);
    }
    if (body.bytes_uploaded !== undefined) {
      rows.push(`| bytes_uploaded | ${body.bytes_uploaded} |`);
    }

    const lines = [
      `## Site Deployed`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      ...rows,
      ``,
      `The site is live at **${body.url}**`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "deploying site directory");
  }
}
