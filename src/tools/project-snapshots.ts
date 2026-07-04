import { z } from "zod";

import { getSdk } from "../sdk.js";
import { mapSdkError } from "../errors.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const createProjectSnapshotSchema = {
  project_id: z.string().describe("Project ID to snapshot."),
};

export const listProjectSnapshotsSchema = {
  project_id: z.string().describe("Project ID whose snapshots should be listed."),
  kind: z.enum(["manual", "pre_migration", "pre_restore", "scheduled"]).optional().describe("Optional snapshot kind filter."),
  limit: z.number().int().positive().max(100).optional().describe("Page size, max 100."),
  after: z.string().optional().describe("Keyset pagination cursor from a previous response."),
};

export const getProjectSnapshotSchema = {
  project_id: z.string().describe("Project ID that owns the snapshot."),
  snapshot_id: z.string().describe("Snapshot ID."),
};

export const restoreProjectSnapshotSchema = {
  project_id: z.string().describe("Project ID to restore."),
  snapshot_id: z.string().describe("Snapshot ID to restore from."),
  include_auth: z.boolean().optional().describe("When true, restore captured auth users/passkeys too. Sessions/tokens are never restored."),
  confirm: z.string().optional().describe("Confirm token from the restore_plan. Omit for a dry restore plan."),
};

export const deleteProjectSnapshotSchema = {
  project_id: z.string().describe("Project ID that owns the snapshot."),
  snapshot_id: z.string().describe("Snapshot ID to delete."),
};

export async function handleCreateProjectSnapshot(args: { project_id: string }): Promise<ToolResult> {
  try {
    const snapshot = await getSdk().snapshots.create(args.project_id);
    return jsonToolResult("Project Snapshot Create", { ok: snapshot.status === "ready", snapshot }, snapshot.status !== "ready");
  } catch (err) {
    return mapSdkError(err, "creating project snapshot");
  }
}

export async function handleListProjectSnapshots(args: {
  project_id: string;
  kind?: "manual" | "pre_migration" | "pre_restore" | "scheduled";
  limit?: number;
  after?: string;
}): Promise<ToolResult> {
  try {
    const result = await getSdk().snapshots.list(args.project_id, {
      kind: args.kind,
      limit: args.limit,
      after: args.after,
    });
    return jsonToolResult("Project Snapshots", { project_id: args.project_id, ...result });
  } catch (err) {
    return mapSdkError(err, "listing project snapshots");
  }
}

export async function handleGetProjectSnapshot(args: { project_id: string; snapshot_id: string }): Promise<ToolResult> {
  try {
    const snapshot = await getSdk().snapshots.get(args.project_id, args.snapshot_id);
    return jsonToolResult("Project Snapshot", { snapshot });
  } catch (err) {
    return mapSdkError(err, "getting project snapshot");
  }
}

export async function handleRestoreProjectSnapshot(args: {
  project_id: string;
  snapshot_id: string;
  include_auth?: boolean;
  confirm?: string;
}): Promise<ToolResult> {
  try {
    const sdk = getSdk();
    if (args.confirm) {
      const restore = await sdk.snapshots.restore(args.project_id, args.snapshot_id, args.confirm, {
        includeAuth: args.include_auth === true,
      });
      return jsonToolResult("Project Snapshot Restore", { ok: restore.status === "ready", restore }, restore.status !== "ready");
    }
    const planned = await sdk.snapshots.restorePlan(args.project_id, args.snapshot_id, {
      includeAuth: args.include_auth === true,
    });
    return jsonToolResult("Project Snapshot Restore Plan", {
      ok: true,
      ...planned,
      confirm_command: `run402 snapshots restore ${args.project_id} ${args.snapshot_id} --confirm ${JSON.stringify(planned.restore_plan.confirm.token)}${args.include_auth ? " --include-auth" : ""} --json`,
    });
  } catch (err) {
    return mapSdkError(err, "restoring project snapshot");
  }
}

export async function handleDeleteProjectSnapshot(args: { project_id: string; snapshot_id: string }): Promise<ToolResult> {
  try {
    await getSdk().snapshots.delete(args.project_id, args.snapshot_id);
    return jsonToolResult("Project Snapshot Delete", { ok: true, project_id: args.project_id, snapshot_id: args.snapshot_id, deleted: true });
  } catch (err) {
    return mapSdkError(err, "deleting project snapshot");
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
