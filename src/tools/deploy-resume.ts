import { z } from "zod";
import { getSdk } from "../sdk.js";
import { formatCanonicalErrorContext, mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { Run402DeployError } from "../../sdk/dist/index.js";
import type { DeployEvent } from "../../sdk/dist/index.js";

/**
 * MCP `deploy_resume` tool — re-runs a stuck deploy operation forward.
 *
 * Used when a previous `deploy` call ended in `activation_pending` or
 * `schema_settling` (e.g. a transient gateway failure between the SQL
 * commit and the pointer-swap activation). The gateway re-runs only the
 * failed phase forward; SQL is never replayed.
 */

export const deployResumeSchema = {
  operation_id: z
    .string()
    .describe(
      "Operation id returned by a prior `deploy` call. Required.",
    ),
};

export async function handleDeployResume(args: {
  operation_id: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/deploy/v2/operations");
  if ("error" in auth) return auth.error;

  const events: DeployEvent[] = [];
  const onEvent = (e: DeployEvent): void => {
    events.push(e);
  };

  try {
    const result = await getSdk().deploy.resume(args.operation_id, { onEvent });
    const lines = [
      `## Deploy Resumed`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| operation_id | \`${result.operation_id}\` |`,
      `| release_id | \`${result.release_id}\` |`,
    ];
    for (const [k, v] of Object.entries(result.urls)) {
      lines.push(`| ${k} | ${v} |`);
    }
    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "text", text: renderEventsBlock(events) },
      ],
    };
  } catch (err) {
    if (err instanceof Run402DeployError) {
      const lines = [
        `## Resume Failed`,
        ``,
        ...formatCanonicalErrorContext(err, { includeDetails: true }),
      ];
      if (err.phase) lines.push(`**Phase:** \`${err.phase}\``);
      if (err.resource) lines.push(`**Resource:** \`${err.resource}\``);
      lines.push(``, err.message);
      const out: { content: Array<{ type: "text"; text: string }>; isError?: boolean } = {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: true,
      };
      if (events.length > 0) {
        out.content.push({ type: "text", text: renderEventsBlock(events) });
      }
      return out;
    }
    return mapSdkError(err, "resuming deploy operation");
  }
}

function renderEventsBlock(events: DeployEvent[]): string {
  return [
    `### Progress events`,
    ``,
    "```json",
    JSON.stringify(events, null, 2),
    "```",
  ].join("\n");
}
