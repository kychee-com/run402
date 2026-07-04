import { z } from "zod";

import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const deployRehearseSchema = {
  plan_id: z.string().describe("Persisted apply plan ID returned by deploy planning."),
  project_id: z.string().optional().describe("Project ID for operator-approval metadata and follow-up status reads."),
  teardown: z.enum(["keep", "on_pass", "always"]).optional().describe("Rehearsal branch cleanup policy. Default keep."),
};

export async function handleDeployRehearse(args: {
  plan_id: string;
  project_id?: string;
  teardown?: "keep" | "on_pass" | "always";
}): Promise<ToolResult> {
  try {
    const rehearsal = await getSdk()._applyEngine.rehearse(args.plan_id, {
      project: args.project_id,
      teardown: args.teardown,
    });
    return jsonToolResult("Deploy Rehearsal", {
      ok: rehearsal.report.status === "passed",
      rehearsal,
      commit_command: `run402 deploy apply --require-plan ${args.plan_id}`,
    }, rehearsal.report.status !== "passed");
  } catch (err) {
    return mapSdkError(err, "rehearsing deploy plan");
  }
}

function jsonToolResult(title: string, value: unknown, isError = false): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [`## ${title}`, "", "```json", JSON.stringify(value, null, 2), "```"].join("\n"),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}
