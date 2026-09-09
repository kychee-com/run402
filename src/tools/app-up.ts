import { z } from "zod";
import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

export const appUpSchema = {
  source: z.string().optional().describe("Local app directory or public Git repository URL. Defaults to the current directory."),
  name: z.string().optional().describe("Project/app instance name, for example kysigned2."),
  project_id: z.string().optional().describe("Existing project id to install into."),
  manifest: z.string().optional().describe("Explicit manifest path. Defaults to run402.json, then advanced release-only manifests."),
  dir: z.string().optional().describe("Workspace directory to inspect when source is omitted."),
  tier: z.enum(["prototype", "hobby", "team"]).optional().describe("Bootstrap tier if account readiness is needed."),
  dry_run: z.boolean().optional().describe("Plan only. No gateway mutation, build execution, release commit, local link write, or prune."),
  yes: z.boolean().optional().describe("Approve non-interactive prerequisite, spend, and local-write prompts."),
  allow_prune: z.boolean().optional().describe("Approve destructive managed-resource prune steps."),
  max_spend_usd: z.number().nonnegative().optional().describe("Maximum spend app_up may approve for readiness steps."),
  build_mode: z.enum(["local", "remote", "sandbox"]).optional().describe("Override app build mode."),
  allow_shell_build: z.boolean().optional().describe("Approve shell-string build commands after review."),
  idempotency_key: z.string().optional().describe("Root idempotency key for resumable app-up graph mutations."),
  no_rehearse: z.boolean().optional().describe("Skip the automatic rehearsal. By default a migration-bearing deploy against a project with a live release is rehearsed on a contained branch and committed only on a passing report; a first deploy has nothing to protect and commits directly (result.deploy.rehearsal says which)."),
  display_name: z.string().min(1).max(64).optional().describe("Display name to set on this principal when it has none yet (promotion credit and room presence use it). Omitted: the detected client name (claude-code, codex, cursor, or agent) is set and reported as identity.source \"detected\"."),
};

type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function handleAppUp(args: {
  source?: string;
  name?: string;
  project_id?: string;
  manifest?: string;
  dir?: string;
  tier?: "prototype" | "hobby" | "team";
  dry_run?: boolean;
  yes?: boolean;
  allow_prune?: boolean;
  max_spend_usd?: number;
  build_mode?: "local" | "remote" | "sandbox";
  allow_shell_build?: boolean;
  idempotency_key?: string;
  no_rehearse?: boolean;
  display_name?: string;
}): Promise<McpResult> {
  try {
    const result = await getSdk().up({
      source: args.source,
      ...(args.no_rehearse ? { noRehearse: true } : {}),
      ...(args.display_name ? { identityName: args.display_name } : {}),
      name: args.name,
      projectId: args.project_id,
      manifest: args.manifest,
      dir: args.dir,
      tier: args.tier,
      idempotencyKey: args.idempotency_key,
      allowPrune: args.allow_prune,
      maxSpendUsd: args.max_spend_usd,
      buildMode: args.build_mode,
      allowShellBuild: args.allow_shell_build,
    }, {
      dryRun: args.dry_run === true,
      approval: args.yes === true ? "yes" : "never",
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result.result?.app_result ?? result, null, 2),
      }],
    };
  } catch (err) {
    return mapSdkError(err, "running app_up");
  }
}
