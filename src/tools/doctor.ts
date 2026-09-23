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
import { jsonBlock, okResult, type ToolResult } from "../structured.js";


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
    const structured = okResult(report);
    return { content: [{ type: "text", text: [head, "", jsonBlock(structured)].join("\n") }], structuredContent: structured };
  } catch (err) {
    return mapSdkError(err, "running doctor");
  }
}
