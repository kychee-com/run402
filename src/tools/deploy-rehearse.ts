import { z } from "zod";

import { getSdk } from "../sdk.js";
import { loadDeployManifest } from "../../sdk/dist/node/index.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const deployRehearseSchema = {
  plan_id: z.string().optional().describe("Persisted apply plan ID. Its bytes must be uploaded; when the gateway answers REHEARSAL_CONTENT_MISSING and `manifest` is given, the manifest is planned, its bytes uploaded, and the rehearsal retried (a fresh plan is used and reported if facts changed). Omit with `manifest` to plan, upload, and rehearse in one call."),
  manifest: z.string().optional().describe("Path to a deploy manifest (run402.json, run402.deploy.json, app.json, or an executable config) to plan from and upload bytes for."),
  project_id: z.string().optional().describe("Project ID for operator-approval metadata and follow-up status reads."),
  teardown: z.enum(["keep", "on_pass", "always"]).optional().describe("Rehearsal branch cleanup policy. Default on_pass."),
};

function isContentMissing(err: unknown): boolean {
  const e = err as { code?: string; body?: { code?: string }; envelope?: { code?: string } } | null;
  const code = e?.code ?? e?.body?.code ?? e?.envelope?.code;
  return code === "REHEARSAL_CONTENT_MISSING";
}

async function planAndUpload(manifest: string, project?: string): Promise<{ planId: string; projectId: string }> {
  const sdk = getSdk();
  const normalized = await loadDeployManifest(manifest, { ...(project ? { project } : {}) });
  const planned = await sdk._applyEngine.plan(normalized.spec, { idempotencyKey: normalized.idempotencyKey, mode: "reviewedPlan" });
  const planId = planned.plan.plan_id;
  if (!planId) throw new Error("Rehearsal requires a persisted plan_id, but the plan response did not include one.");
  await sdk._applyEngine.upload(planned.plan, { project: normalized.spec.project, byteReaders: planned.byteReaders });
  return { planId, projectId: normalized.spec.project };
}

export async function handleDeployRehearse(args: {
  plan_id?: string;
  manifest?: string;
  project_id?: string;
  teardown?: "keep" | "on_pass" | "always";
}): Promise<ToolResult> {
  if (!args.plan_id && !args.manifest) {
    return { content: [{ type: "text", text: "Nothing to rehearse: pass `plan_id`, or `manifest` to plan, upload, and rehearse in one call." }], isError: true };
  }
  try {
    let planId = args.plan_id ?? null;
    let replanned: Record<string, string> | null = null;
    let rehearsal;
    if (!planId) {
      const fresh = await planAndUpload(args.manifest!, args.project_id);
      planId = fresh.planId;
      rehearsal = await getSdk()._applyEngine.rehearse(planId, { project: args.project_id ?? fresh.projectId, teardown: args.teardown });
    } else {
      try {
        rehearsal = await getSdk()._applyEngine.rehearse(planId, { project: args.project_id, teardown: args.teardown });
      } catch (err) {
        if (!isContentMissing(err) || !args.manifest) throw err;
        const fresh = await planAndUpload(args.manifest, args.project_id);
        if (fresh.planId !== args.plan_id) replanned = { original_plan_id: args.plan_id!, plan_id: fresh.planId, why: "plan facts changed since the given plan; a fresh reviewed plan was created, its bytes uploaded, and that plan rehearsed" };
        planId = fresh.planId;
        rehearsal = await getSdk()._applyEngine.rehearse(planId, { project: args.project_id ?? fresh.projectId, teardown: args.teardown });
      }
    }
    return jsonToolResult("Deploy Rehearsal", {
      ok: rehearsal.report.status === "passed",
      plan_id: planId,
      ...(replanned ? { replanned } : {}),
      rehearsal,
      commit_command: `run402 deploy apply --require-plan ${planId}`,
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
