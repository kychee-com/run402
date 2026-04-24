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
      "Local directory to deploy. The server walks this directory, auto-detects binary files, and builds the deployment manifest. Files named .git, node_modules, or .DS_Store are skipped. Symlinks are rejected. Practical size limit today is ~100 MB (inline JSON payload) — use smaller sites or wait for blob-backed deploys for larger.",
    ),
  target: z
    .string()
    .optional()
    .describe("Deployment target (e.g. 'production'). Tracked in DB for future alias support."),
  inherit: z
    .boolean()
    .optional()
    .describe(
      "If true, copy unchanged files from the previous deployment server-side. Useful for faster incremental deploys when most files are the same.",
    ),
};

export async function handleDeploySiteDir(args: {
  project: string;
  dir: string;
  target?: string;
  inherit?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/deployments/v1");
  if ("error" in auth) return auth.error;

  try {
    const body = await getSdk().sites.deployDir({
      project: args.project,
      dir: args.dir,
      target: args.target,
      inherit: args.inherit,
    });

    // Persist the last deployment ID on the project (MCP-local side effect).
    updateProject(args.project, { last_deployment_id: body.deployment_id });

    const lines = [
      `## Site Deployed`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| deployment_id | \`${body.deployment_id}\` |`,
      `| url | ${body.url} |`,
      `| source | \`${args.dir}\` |`,
      ``,
      `The site is live at **${body.url}**`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "deploying site directory");
  }
}
