export type ProjectSnapshotKind = "manual" | "pre_migration" | "pre_restore" | "scheduled";
export type ProjectSnapshotProfile = "snapshot";
export type ProjectSnapshotStatus = "running" | "ready" | "failed" | "expired";

export interface SnapshotNextAction {
  type: string;
  command?: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Caller metadata on a snapshot: a flat object of string, number, boolean, or
 * string[] values, at most 4 KB serialized (the asset-metadata rules).
 * Immutable once set. Returned to anyone who can read the project's
 * snapshots, so never put secrets in it.
 */
export type ProjectSnapshotMetadata = Record<string, string | number | boolean | string[]>;

/**
 * The credential that caused a snapshot. `platform` is an automatic capture
 * (`pre_migration`, `pre_restore`, `scheduled`); a `service_key` snapshot was
 * made by a deployed function and has no principal.
 */
export type ProjectSnapshotCreatorCredentialKind =
  | "control_plane_session"
  | "siwx_eoa"
  | "service_key"
  | "system"
  | "platform";

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
  /** Caller label; `null` for platform snapshots. */
  label: string | null;
  metadata: ProjectSnapshotMetadata | null;
  created_by: {
    credential_kind: ProjectSnapshotCreatorCredentialKind | (string & {});
    principal_id: string | null;
  };
  /** Set on a `pre_restore` snapshot: the restore that caused it. */
  restore_of: { snapshot_id: string; restore_id: string } | null;
  next_actions: SnapshotNextAction[];
}

export interface ProjectSnapshotCreateOptions {
  /** 1–120 characters after trimming, no control characters. Immutable. */
  label?: string;
  metadata?: ProjectSnapshotMetadata;
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

/**
 * `keep` (default) restores data only. `snapshot` also re-activates the
 * snapshot's capture-time release in the same transaction as the data flip:
 * live release pointer, static site, routes, and subdomains move back.
 * Function code does not: functions are not versioned per release, so the
 * plan lists any that differ in `release.warnings` (`FUNCTION_VERSION_MISMATCH`).
 */
export type SnapshotRestoreReleaseMode = "keep" | "snapshot";

export type SnapshotRestoreReleaseReason =
  | "restorable"
  | "already_live"
  | "no_capture_release"
  | "release_not_found"
  | "release_not_promotable"
  | "deployment_unservable"
  | "no_live_release";

export interface SnapshotRestoreOptions {
  includeAuth?: boolean;
  /** Must match between `restorePlan` and `restore`. Default `"keep"`. */
  release?: SnapshotRestoreReleaseMode;
}

export interface SnapshotRestoreConfirmOptions extends SnapshotRestoreOptions {
  /**
   * `true` (default): resolve with the terminal restore result, polling the
   * restore status read so a long restore never hits an HTTP timeout.
   * `false`: resolve immediately with the `202` handle.
   */
  wait?: boolean;
  /** Give up polling after this long (default 15 minutes). The restore keeps running. */
  timeoutMs?: number;
  /** Floor between polls in ms (default: the server's Retry-After, at least 1000). */
  pollIntervalMs?: number;
}

export interface SnapshotRestorePlanEnvelope {
  restore_plan: SnapshotRestorePlan;
}

export interface SnapshotRestoreWarning {
  code: string;
  severity?: string;
  message: string;
  affected: string[];
  requires_confirmation: boolean;
  [key: string]: unknown;
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
    mode: SnapshotRestoreReleaseMode | (string & {});
    snapshot_live_release_id: string | null;
    current_live_release_id: string | null;
    /** Whether `release: "snapshot"` can re-activate the capture-time release. */
    restorable: boolean;
    reason: SnapshotRestoreReleaseReason | (string & {});
    warnings: SnapshotRestoreWarning[];
    message: string;
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
  restore_id: string;
  project_id: string;
  snapshot_id: string;
  pre_restore_snapshot_id: string;
  old_schema_slot: string;
  new_schema_slot: string;
  migration_registry_rows: number;
  invalidated_plan_count: number;
  release_mode: SnapshotRestoreReleaseMode | (string & {});
  /** The project's live release after the restore. */
  live_release_id: string | null;
  /** Edge propagation for a re-activated release; absent when the release was kept. */
  edge?: Record<string, unknown>;
  message: string;
  status: "ready" | (string & {});
  next_actions: SnapshotNextAction[];
}

/** The `202` answer to a confirmed restore with `wait: false`. */
export interface SnapshotRestoreHandle {
  operation_id: string;
  restore_id: string;
  project_id: string;
  snapshot_id: string;
  release_mode: SnapshotRestoreReleaseMode | (string & {});
  include_auth: boolean;
  status: "running";
  retry_after_seconds: number;
  next_actions: SnapshotNextAction[];
}

export interface SnapshotRestoreStatus {
  operation_id: string;
  restore_id: string;
  project_id: string;
  snapshot_id: string;
  status: "running" | "ready" | "failed" | (string & {});
  release_mode: SnapshotRestoreReleaseMode | (string & {});
  include_auth: boolean;
  pre_restore_snapshot_id: string | null;
  live_release_id: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  error: { code: string; message: string } | null;
  /** When `ready`: the same result object a synchronous restore returns. */
  result: SnapshotRestoreResult | null;
  next_actions: SnapshotNextAction[];
}
