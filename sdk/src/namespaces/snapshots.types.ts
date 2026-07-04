export type ProjectSnapshotKind = "manual" | "pre_migration" | "pre_restore" | "scheduled";
export type ProjectSnapshotProfile = "snapshot";
export type ProjectSnapshotStatus = "running" | "ready" | "failed" | "expired";

export interface SnapshotNextAction {
  type: string;
  command?: string;
  message: string;
  [key: string]: unknown;
}

export interface ProjectSnapshotDto {
  snapshot_id: string;
  operation_id: string;
  project_id: string;
  kind: ProjectSnapshotKind | (string & {});
  profile: ProjectSnapshotProfile | (string & {});
  status: ProjectSnapshotStatus | (string & {});
  manifest_sha256: string | null;
  size_bytes: number;
  live_release_id: string | null;
  captured_at: string | null;
  expires_at: string | null;
  error: unknown | null;
  created_at: string;
  updated_at: string;
  next_actions: SnapshotNextAction[];
}

export interface ProjectSnapshotsListOptions {
  limit?: number;
  after?: string;
  kind?: ProjectSnapshotKind | (string & {});
}

export interface ProjectSnapshotsListResult {
  snapshots: ProjectSnapshotDto[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface SnapshotRestoreOptions {
  includeAuth?: boolean;
}

export interface SnapshotRestorePlanEnvelope {
  restore_plan: SnapshotRestorePlan;
}

export interface SnapshotRestorePlan {
  snapshot_id: string;
  project_id: string;
  snapshot_at: string;
  data_loss_statement: string;
  auth: {
    mode: "not_restored" | "restore_on_confirm" | (string & {});
    users: number;
    passkeys: number;
    message: string;
  };
  release: {
    snapshot_live_release_id: string | null;
    current_live_release_id: string | null;
  };
  target: {
    current_schema_slot: string;
    behavior: "offline_materialize_then_atomic_flip" | (string & {});
  };
  confirm: {
    token: string;
    expires_at: string;
  };
  next_actions: SnapshotNextAction[];
}

export interface SnapshotRestoreResult {
  operation_id: string;
  project_id: string;
  snapshot_id: string;
  pre_restore_snapshot_id: string;
  old_schema_slot: string;
  new_schema_slot: string;
  migration_registry_rows: number;
  status: "ready" | (string & {});
  next_actions: SnapshotNextAction[];
}
