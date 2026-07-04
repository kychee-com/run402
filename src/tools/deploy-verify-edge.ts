import { z } from "zod";
import { getSdk } from "../sdk.js";
import { formatCanonicalErrorContext, mapSdkError } from "../errors.js";
import { requireAllowanceAuth } from "../allowance-auth.js";
import { Run402DeployError } from "../../sdk/dist/index.js";
import type { EdgeCoherenceReport } from "../../sdk/dist/index.js";

/**
 * MCP `deploy_verify_edge` tool — verify that gateway and edge pointers agree
 * on the active release for a deploy operation.
 */

export const deployVerifyEdgeSchema = {
  operation_id: z
    .string()
    .describe("Operation id returned by a prior `deploy` call. Must start with `op_`."),
  project_id: z
    .string()
    .describe("Project ID that owns the operation. Required (apikey-gated endpoint)."),
  wait: z
    .boolean()
    .optional()
    .describe("Poll until coherent or timeout. Defaults to false."),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum seconds to wait when `wait` is true. Defaults to 60."),
};

export async function handleDeployVerifyEdge(args: {
  operation_id: string;
  project_id: string;
  wait?: boolean;
  timeout_seconds?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const auth = requireAllowanceAuth("/apply/v1/operations");
  if ("error" in auth) return auth.error;

  try {
    const p = await getSdk().project(args.project_id);
    const result = args.wait
      ? await p.apply.waitEdgeCoherent(args.operation_id, {
          timeoutMs: (args.timeout_seconds ?? 60) * 1000,
        })
      : await edgeCoherenceOnce(p, args.operation_id);
    const report = result.report;
    const coherent = args.wait ? result.coherent : report.coherent;

    const lines: string[] = [
      `## Deploy Edge Coherence`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| operation_id | \`${report.operation_id}\` |`,
      `| project_id | \`${report.project_id}\` |`,
      `| release_id | \`${report.release_id}\` |`,
      `| release_generation | ${report.release_generation} |`,
      `| coherent | ${coherent ? "yes" : "no"} |`,
      `| pending_count | ${report.pending_count} |`,
      `| path_count | ${report.path_count}/${report.total_path_count} |`,
      `| paths_truncated | ${report.paths_truncated ? "yes" : "no"} |`,
      `| attempts | ${result.attempts} |`,
      `| elapsed_ms | ${result.elapsedMs} |`,
    ];
    if (report.probe_basis) {
      lines.push(`| probe_basis | ${report.probe_basis} |`);
    }
    lines.push(``);

    if (report.paths.length > 0) {
      lines.push(`| Path | Host | State | Confidence |`);
      lines.push(`|------|------|-------|------------|`);
      for (const path of report.paths.slice(0, 20)) {
        lines.push(
          `| \`${path.path}\` | ${path.host} | ${path.state} | ${path.observed_confidence} |`,
        );
      }
      lines.push(``);
    }

    if (report.next_actions.length > 0) {
      lines.push(`### Next Actions`, ``);
      for (const action of report.next_actions) lines.push(`- ${action}`);
      lines.push(``);
    }

    return {
      content: [
        { type: "text", text: lines.join("\n") },
        {
          type: "text",
          text: [
            "### Raw report",
            "",
            "```json",
            JSON.stringify({ ...result, coherent }, null, 2),
            "```",
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    if (err instanceof Run402DeployError) {
      const lines = [
        `## Edge Verification Failed`,
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
    return mapSdkError(err, "verifying deploy edge coherence");
  }
}

async function edgeCoherenceOnce(
  projectClient: {
    apply: {
      edgeCoherence(operationId: string): Promise<EdgeCoherenceReport>;
    };
  },
  operationId: string,
): Promise<{
  coherent: boolean;
  attempts: number;
  elapsedMs: number;
  report: EdgeCoherenceReport;
}> {
  const report = await projectClient.apply.edgeCoherence(operationId);
  return {
    coherent: report.coherent,
    attempts: 1,
    elapsedMs: 0,
    report,
  };
}
