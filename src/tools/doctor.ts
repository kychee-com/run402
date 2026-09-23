/**
 * `doctor` — local health and configuration diagnostics: `r.doctor()`.
 *
 * `{ ok, blocking[], warnings[], checks[] }`, the same report `run402 doctor`
 * prints. `ok` is structural (no blocking finding); advisory findings land in
 * `warnings[]` and never change it.
 */

import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const doctorSchema = {
  project_id: z
    .string()
    .optional()
    .describe("Target this project's vault check. Omitted: the repository's own remote, else the active project."),
};

export async function handleDoctor(args: { project_id?: string } = {}): Promise<ToolResult> {
  try {
    const report = await getSdk().doctor({ project: args.project_id ?? null });
    const head = report.ok
      ? `## Doctor: ok (${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"})`
      : `## Doctor: ${report.blocking.length} blocking finding${report.blocking.length === 1 ? "" : "s"}`;
    return { content: [{ type: "text", text: [head, "", "```json", JSON.stringify(report, null, 2), "```"].join("\n") }] };
  } catch (err) {
    return mapSdkError(err, "running doctor");
  }
}
