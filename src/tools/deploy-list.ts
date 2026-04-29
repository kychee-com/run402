import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";

/**
 * MCP `deploy_list` tool — list recent deploy operations for a project.
 *
 * Wraps `r.deploy.list()` over `GET /deploy/v2/operations`. Returns a
 * markdown summary table and the structured operation snapshots for the
 * agent to reason over (status, release_id, timestamps).
 */

export const deployListSchema = {
  project_id: z
    .string()
    .describe("Project ID to list operations for. Required (apikey-gated)."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum number of operations to return. Forwarded to the gateway as `?limit=`; the gateway picks a default when omitted.",
    ),
};

export async function handleDeployList(args: {
  project_id: string;
  limit?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/deploy/v2/operations");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().deploy.list({
      project: args.project_id,
      limit: args.limit,
    });

    const lines: string[] = [
      `## Deploy Operations`,
      ``,
      `Project: \`${args.project_id}\``,
      `Returned: ${result.operations.length}`,
    ];
    if (result.cursor) {
      lines.push(`Next cursor: \`${result.cursor}\``);
    }
    lines.push(``);
    if (result.operations.length === 0) {
      lines.push("No operations found.");
    } else {
      lines.push(
        `| Operation | Status | Release | Updated |`,
        `|-----------|--------|---------|---------|`,
      );
      for (const op of result.operations) {
        lines.push(
          `| \`${op.operation_id}\` | ${op.status} | ${op.release_id ?? "—"} | ${op.updated_at} |`,
        );
      }
    }

    return {
      content: [
        { type: "text", text: lines.join("\n") },
        {
          type: "text",
          text: ["### Raw operations", "", "```json", JSON.stringify(result, null, 2), "```"].join("\n"),
        },
      ],
    };
  } catch (err) {
    return mapSdkError(err, "listing deploy operations");
  }
}
