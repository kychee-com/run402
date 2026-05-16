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
  cursor: z
    .string()
    .optional()
    .describe(
      "Legacy pagination cursor returned by an older deploy_list response. Forwarded to the gateway as `?before=`.",
    ),
  before: z
    .string()
    .optional()
    .describe("Pagination cursor from `next_cursor`. Forwarded to the gateway as `?before=`."),
  status: z
    .string()
    .optional()
    .describe("Optional operation status filter, for example `ready`, `failed`, or `activation_pending`."),
  since: z
    .string()
    .optional()
    .describe("Optional ISO timestamp filter for recent deploy operations."),
  filter_project_id: z
    .string()
    .optional()
    .describe("Optional project_id filter when the gateway supports filtering operation history."),
  include_total: z
    .boolean()
    .optional()
    .describe(
      "When true, asks the gateway to include an optional total count in the deploy operation list response.",
    ),
};

export async function handleDeployList(args: {
  project_id: string;
  limit?: number;
  cursor?: string;
  before?: string;
  status?: string;
  since?: string;
  filter_project_id?: string;
  include_total?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/deploy/v2/operations");
  if ("error" in auth) return auth.error;

  try {
    const result = await getSdk().deploy.list({
      project: args.project_id,
      limit: args.limit,
      before: args.before ?? args.cursor,
      status: args.status,
      since: args.since,
      project_id: args.filter_project_id,
      includeTotal: args.include_total,
    });

    const lines: string[] = [
      `## Deploy Operations`,
      ``,
      `Project: \`${args.project_id}\``,
      `Returned: ${result.operations.length}`,
    ];
    const nextCursor = result.next_cursor ?? result.cursor;
    if (typeof result.total === "number") {
      lines.push(`Total: ${result.total}`);
    }
    if (typeof result.has_more === "boolean") {
      lines.push(`Has more: ${result.has_more ? "yes" : "no"}`);
    }
    if (nextCursor) {
      lines.push(`Next cursor: \`${nextCursor}\``);
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
