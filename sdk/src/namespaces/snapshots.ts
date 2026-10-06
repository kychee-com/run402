import type { Client } from "../kernel.js";
import { ApiError, LocalError } from "../errors.js";
import { waitFor } from "../wait.js";
import type {
  ProjectSnapshotCreateOptions,
  ProjectSnapshotDto,
  ProjectSnapshotsListOptions,
  ProjectSnapshotsListResult,
  SnapshotRestoreConfirmOptions,
  SnapshotRestoreHandle,
  SnapshotRestoreOptions,
  SnapshotRestorePlanEnvelope,
  SnapshotRestoreResult,
  SnapshotRestoreStatus,
} from "./snapshots.types.js";

/** How long `restore()` polls before giving up (the restore itself keeps running). */
const DEFAULT_RESTORE_WAIT_MS = 15 * 60 * 1000;

export class Snapshots {
  constructor(private readonly client: Client) {}

  /**
   * Create a manual snapshot. `label` and `metadata` are immutable and live
   * outside the tenant schema, so a restore never rewinds them: the snapshot
   * list is a ledger of restore points that survives restores.
   */
  async create(projectId: string, opts: ProjectSnapshotCreateOptions = {}): Promise<ProjectSnapshotDto> {
    assertProjectId(projectId, "creating project snapshot");
    return this.client.request<ProjectSnapshotDto>(snapshotCollectionPath(projectId), {
      method: "POST",
      body: {
        ...(opts.label !== undefined ? { label: opts.label } : {}),
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      },
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

  /**
   * Plan a restore without mutating anything. Pass the same `release` and
   * `includeAuth` to `restore` that you plan with; the confirm token binds them.
   */
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

  /**
   * Confirm a restore. By default this resolves with the terminal result: it
   * starts the restore in the background (`wait: false` on the wire) and
   * polls the restore status read, so a long restore never hits an HTTP
   * timeout. A `failed` restore rejects with the gateway's error code. Pass
   * `{ wait: false }` to resolve immediately with the `202` handle and poll
   * `getRestore` yourself.
   */
  restore(
    projectId: string,
    snapshotId: string,
    confirm: string,
    opts: SnapshotRestoreConfirmOptions & { wait: false },
  ): Promise<SnapshotRestoreHandle>;
  restore(
    projectId: string,
    snapshotId: string,
    confirm: string,
    opts?: SnapshotRestoreConfirmOptions,
  ): Promise<SnapshotRestoreResult>;
  async restore(
    projectId: string,
    snapshotId: string,
    confirm: string,
    opts: SnapshotRestoreConfirmOptions = {},
  ): Promise<SnapshotRestoreResult | SnapshotRestoreHandle> {
    const context = "restoring project snapshot";
    assertProjectId(projectId, context);
    assertSnapshotId(snapshotId, context);
    if (!confirm || typeof confirm !== "string") {
      throw new LocalError("snapshots.restore requires a confirm token from snapshots.restorePlan", context);
    }
    const started = await this.client.request<SnapshotRestoreHandle | SnapshotRestoreResult>(
      `${snapshotPath(projectId, snapshotId)}/restore`,
      {
        method: "POST",
        body: { ...restoreBody(opts), confirm, wait: false },
        authMeta: {
          method: "snapshots.restore",
          capability: "project.snapshots.manage",
          target: { project_id: projectId },
        },
        context,
      },
    );
    // A gateway that predates asynchronous restore ignores `wait` and answers
    // with the terminal result synchronously.
    if (started.status !== "running") return started as SnapshotRestoreResult;
    const handle = started as SnapshotRestoreHandle;
    if (opts.wait === false) return handle;

    const pollMs = Math.max(opts.pollIntervalMs ?? (handle.retry_after_seconds ?? 5) * 1000, 1000);
    const waited = await waitFor(
      () => this.getRestore(projectId, snapshotId, handle.restore_id),
      (status) => status.status !== "running",
      { pollMs, timeoutMs: opts.timeoutMs ?? DEFAULT_RESTORE_WAIT_MS },
    );
    const status = waited.state;
    if (status.status === "ready" && status.result) return status.result;
    if (status.status === "failed") {
      throw new ApiError(
        `${status.error?.message ?? "Restore failed"} while ${context}`,
        null,
        {
          code: status.error?.code ?? "SNAPSHOT_RESTORE_FAILED",
          message: status.error?.message ?? "Restore failed",
          details: { restore_id: status.restore_id, snapshot_id: snapshotId, project_id: projectId },
          next_actions: status.next_actions,
        },
        context,
      );
    }
    // Still running when the wait ran out (or ready from a gateway that does
    // not record the result yet): the restore keeps going server-side.
    throw new LocalError(
      status.status === "running"
        ? `Restore ${handle.restore_id} is still running after ${Math.round(waited.elapsedMs / 1000)}s; it continues server-side`
        : `Restore ${handle.restore_id} is ready; read it with getRestore for its outcome`,
      context,
      {
        code: status.status === "running" ? "SNAPSHOT_RESTORE_WAIT_TIMEOUT" : "SNAPSHOT_RESTORE_RESULT_UNAVAILABLE",
        details: { restore_id: handle.restore_id, snapshot_id: snapshotId, project_id: projectId, status: status.status },
        next_actions: handle.next_actions,
      },
    );
  }

  /** Status and outcome of one restore, including a background (`wait: false`) restore. */
  async getRestore(projectId: string, snapshotId: string, restoreId: string): Promise<SnapshotRestoreStatus> {
    const context = "reading project snapshot restore";
    assertProjectId(projectId, context);
    assertSnapshotId(snapshotId, context);
    if (!restoreId || typeof restoreId !== "string") {
      throw new LocalError("snapshots.getRestore requires a restoreId", context);
    }
    return this.client.request<SnapshotRestoreStatus>(
      `${snapshotPath(projectId, snapshotId)}/restores/${encodeURIComponent(restoreId)}`,
      {
        authMeta: {
          method: "snapshots.getRestore",
          capability: "project.snapshots.manage",
          target: { project_id: projectId },
        },
        context,
      },
    );
  }
}

function snapshotCollectionPath(projectId: string): string {
  return `/projects/v1/${encodeURIComponent(projectId)}/snapshots`;
}

function snapshotPath(projectId: string, snapshotId: string): string {
  return `${snapshotCollectionPath(projectId)}/${encodeURIComponent(snapshotId)}`;
}

function restoreBody(opts: SnapshotRestoreOptions): Record<string, unknown> {
  return {
    ...(opts.includeAuth ? { include: ["auth"] } : {}),
    ...(opts.release !== undefined ? { release: opts.release } : {}),
  };
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
