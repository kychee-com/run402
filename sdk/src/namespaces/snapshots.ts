import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  ProjectSnapshotDto,
  ProjectSnapshotsListOptions,
  ProjectSnapshotsListResult,
  SnapshotRestoreOptions,
  SnapshotRestorePlanEnvelope,
  SnapshotRestoreResult,
} from "./snapshots.types.js";

export class Snapshots {
  constructor(private readonly client: Client) {}

  async create(projectId: string): Promise<ProjectSnapshotDto> {
    assertProjectId(projectId, "creating project snapshot");
    return this.client.request<ProjectSnapshotDto>(snapshotCollectionPath(projectId), {
      method: "POST",
      body: {},
      authMeta: {
        method: "snapshots.create",
        capability: "project.snapshots.manage",
        target: { project_id: projectId },
      },
      context: "creating project snapshot",
    });
  }

  async list(projectId: string, opts: ProjectSnapshotsListOptions = {}): Promise<ProjectSnapshotsListResult> {
    assertProjectId(projectId, "listing project snapshots");
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.after !== undefined) qs.set("after", opts.after);
    if (opts.kind !== undefined) qs.set("kind", opts.kind);
    const query = qs.toString();
    return this.client.request<ProjectSnapshotsListResult>(
      `${snapshotCollectionPath(projectId)}${query ? `?${query}` : ""}`,
      {
        authMeta: {
          method: "snapshots.list",
          capability: "project.snapshots.manage",
          target: { project_id: projectId },
        },
        context: "listing project snapshots",
      },
    );
  }

  async get(projectId: string, snapshotId: string): Promise<ProjectSnapshotDto> {
    assertProjectId(projectId, "getting project snapshot");
    assertSnapshotId(snapshotId, "getting project snapshot");
    return this.client.request<ProjectSnapshotDto>(snapshotPath(projectId, snapshotId), {
      authMeta: {
        method: "snapshots.get",
        capability: "project.snapshots.manage",
        target: { project_id: projectId },
      },
      context: "getting project snapshot",
    });
  }

  async delete(projectId: string, snapshotId: string): Promise<void> {
    assertProjectId(projectId, "deleting project snapshot");
    assertSnapshotId(snapshotId, "deleting project snapshot");
    await this.client.request<unknown>(snapshotPath(projectId, snapshotId), {
      method: "DELETE",
      authMeta: {
        method: "snapshots.delete",
        capability: "project.snapshots.manage",
        target: { project_id: projectId },
      },
      context: "deleting project snapshot",
    });
  }

  async restorePlan(
    projectId: string,
    snapshotId: string,
    opts: SnapshotRestoreOptions = {},
  ): Promise<SnapshotRestorePlanEnvelope> {
    assertProjectId(projectId, "planning project snapshot restore");
    assertSnapshotId(snapshotId, "planning project snapshot restore");
    return this.client.request<SnapshotRestorePlanEnvelope>(`${snapshotPath(projectId, snapshotId)}/restore`, {
      method: "POST",
      body: restoreBody(opts),
      authMeta: {
        method: "snapshots.restorePlan",
        capability: "project.snapshots.manage",
        target: { project_id: projectId },
      },
      context: "planning project snapshot restore",
    });
  }

  async restore(
    projectId: string,
    snapshotId: string,
    confirm: string,
    opts: SnapshotRestoreOptions = {},
  ): Promise<SnapshotRestoreResult> {
    assertProjectId(projectId, "restoring project snapshot");
    assertSnapshotId(snapshotId, "restoring project snapshot");
    if (!confirm || typeof confirm !== "string") {
      throw new LocalError("snapshots.restore requires a confirm token from snapshots.restorePlan", "restoring project snapshot");
    }
    return this.client.request<SnapshotRestoreResult>(`${snapshotPath(projectId, snapshotId)}/restore`, {
      method: "POST",
      body: { ...restoreBody(opts), confirm },
      authMeta: {
        method: "snapshots.restore",
        capability: "project.snapshots.manage",
        target: { project_id: projectId },
      },
      context: "restoring project snapshot",
    });
  }
}

function snapshotCollectionPath(projectId: string): string {
  return `/projects/v1/${encodeURIComponent(projectId)}/snapshots`;
}

function snapshotPath(projectId: string, snapshotId: string): string {
  return `${snapshotCollectionPath(projectId)}/${encodeURIComponent(snapshotId)}`;
}

function restoreBody(opts: SnapshotRestoreOptions): Record<string, unknown> {
  return opts.includeAuth ? { include: ["auth"] } : {};
}

function assertProjectId(value: string, context: string): void {
  if (!value || typeof value !== "string") {
    throw new LocalError("snapshots helper requires a projectId", context);
  }
}

function assertSnapshotId(value: string, context: string): void {
  if (!value || typeof value !== "string") {
    throw new LocalError("snapshots helper requires a snapshotId", context);
  }
}
