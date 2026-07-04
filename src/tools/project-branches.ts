import { z } from "zod";

import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const createProjectBranchSchema = {
  project_id: z.string().describe("Parent project ID."),
  from_snapshot_id: z.string().optional().describe("Existing ready snapshot to branch from. Omit to capture a fresh contained snapshot first."),
  name: z.string().optional().describe("Human-readable branch project name."),
  email_mode: z.enum(["sandbox", "off"]).optional().describe("Branch email containment. Default sandbox."),
  enable_cron: z.boolean().optional().describe("Enable scheduled functions on the branch. Default false."),
  ttl_days: z.number().int().min(1).max(30).optional().describe("Branch TTL in days. Default 7, max 30."),
};

export const listProjectBranchesSchema = {
  project_id: z.string().describe("Parent project ID."),
};

export const renewProjectBranchSchema = {
  project_id: z.string().describe("Parent project ID."),
  branch_project_id: z.string().describe("Branch project ID."),
  ttl_days: z.number().int().min(1).max(30).optional().describe("New TTL extension in days."),
};

export const deleteProjectBranchSchema = {
  project_id: z.string().describe("Parent project ID."),
  branch_project_id: z.string().describe("Branch project ID to delete."),
};

export async function handleCreateProjectBranch(args: {
  project_id: string;
  from_snapshot_id?: string;
  name?: string;
  email_mode?: "sandbox" | "off";
  enable_cron?: boolean;
  ttl_days?: number;
}): Promise<ToolResult> {
  try {
    const branch = await getSdk().branches.create(args.project_id, {
      fromSnapshotId: args.from_snapshot_id,
      name: args.name,
      emailMode: args.email_mode,
      enableCron: args.enable_cron,
      ttlDays: args.ttl_days,
    });
    return jsonToolResult("Project Branch Create", { ok: true, branch });
  } catch (err) {
    return mapSdkError(err, "creating project branch");
  }
}

export async function handleListProjectBranches(args: { project_id: string }): Promise<ToolResult> {
  try {
    const result = await getSdk().branches.list(args.project_id);
    return jsonToolResult("Project Branches", { project_id: args.project_id, ...result });
  } catch (err) {
    return mapSdkError(err, "listing project branches");
  }
}

export async function handleRenewProjectBranch(args: {
  project_id: string;
  branch_project_id: string;
  ttl_days?: number;
}): Promise<ToolResult> {
  try {
    const branch = await getSdk().branches.renew(args.project_id, args.branch_project_id, {
      ttlDays: args.ttl_days,
    });
    return jsonToolResult("Project Branch Renew", { ok: true, branch });
  } catch (err) {
    return mapSdkError(err, "renewing project branch");
  }
}

export async function handleDeleteProjectBranch(args: { project_id: string; branch_project_id: string }): Promise<ToolResult> {
  try {
    await getSdk().branches.delete(args.project_id, args.branch_project_id);
    return jsonToolResult("Project Branch Delete", {
      ok: true,
      project_id: args.project_id,
      branch_project_id: args.branch_project_id,
      deleted: true,
    });
  } catch (err) {
    return mapSdkError(err, "deleting project branch");
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
