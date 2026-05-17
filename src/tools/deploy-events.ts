import { z } from "zod";
import { getSdk } from "../sdk.js";
import { formatCanonicalErrorContext, mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { Run402DeployError } from "../../sdk/dist/index.js";

/**
 * MCP `deploy_events` tool — fetch the recorded phase event stream for a
 * deploy operation.
 *
 * Wraps `r.deploy.events()` over `GET /apply/v1/operations/:id/events`.
 * Useful for inspecting a deploy after the fact (no live subscription) —
 * for live progress events during an in-flight deploy, the `deploy` tool
 * already returns them inline in its response.
 */

export const deployEventsSchema = {
  operation_id: z
    .string()
    .describe(
      "Operation id returned by a prior `deploy` call. Must start with `op_`.",
    ),
  project_id: z
    .string()
    .describe(
      "Project ID that owns the operation. Required (apikey-gated endpoint).",
    ),
};

export async function handleDeployEvents(args: {
  operation_id: string;
  project_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/apply/v1/operations");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().deploy.events(args.operation_id, {
      project: args.project_id,
    });

    const lines: string[] = [
      `## Deploy Events`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| operation_id | \`${args.operation_id}\` |`,
      `| project_id | \`${args.project_id}\` |`,
      `| event_count | ${result.events.length} |`,
    ];

    return {
      content: [
        { type: "text", text: lines.join("\n") },
        {
          type: "text",
          text: ["### Events", "", "```json", JSON.stringify(result.events, null, 2), "```"].join("\n"),
        },
      ],
    };
  } catch (err) {
    if (err instanceof Run402DeployError) {
      const lines = [
        `## Fetch Events Failed`,
        ``,
        ...formatCanonicalErrorContext(err, { includeDetails: true }),
      ];
      if (err.phase) lines.push(`**Phase:** \`${err.phase}\``);
      if (err.resource) lines.push(`**Resource:** \`${err.resource}\``);
      lines.push(``, err.message);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: true,
      };
    }
    return mapSdkError(err, "fetching deploy events");
  }
}
