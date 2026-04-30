import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { updateProject } from "../keystore.js";
import type { DeployEvent } from "../../sdk/dist/node/sites-node.js";

export const deploySiteDirSchema = {
  project: z
    .string()
    .describe("Project ID to link this deployment to"),
  dir: z
    .string()
    .describe(
      "Local directory to deploy. The SDK walks this directory, hashes each file, and uploads only bytes the gateway doesn't already have via the unified deploy primitive (CAS-backed). Files named .git, node_modules, or .DS_Store are skipped. Symlinks are rejected.",
    ),
  target: z
    .string()
    .optional()
    .describe("Deployment target (e.g. 'production'). Tracked in DB for future alias support."),
};

/**
 * Render the buffered progress events as a fenced JSON code block. The agent
 * reading the MCP response can `JSON.parse` the contents to inspect what
 * happened during the deploy (file count, dedup ratio, copy duration, etc.).
 */
function renderEventsBlock(events: DeployEvent[]): string {
  return [
    `### Progress events`,
    ``,
    "```json",
    JSON.stringify(events, null, 2),
    "```",
  ].join("\n");
}

export async function handleDeploySiteDir(args: {
  project: string;
  dir: string;
  target?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/deploy/v2/plans");
  if ("error" in auth) return auth.error;

  const events: DeployEvent[] = [];

  try {
    const body = await getSdk().sites.deployDir({
      project: args.project,
      dir: args.dir,
      target: args.target,
      onEvent: (e) => events.push(e),
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

    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "text", text: renderEventsBlock(events) },
      ],
    };
  } catch (err) {
    const errResp = mapSdkError(err, "deploying site directory");
    // Surface the partial event log so the agent can see how far the deploy
    // got before failing — diagnostic info that's otherwise lost.
    if (events.length > 0) {
      errResp.content.push({ type: "text", text: renderEventsBlock(events) });
    }
    return errResp;
  }
}
