export type ProjectArchiveScope = "portable-runtime-v1";
export type ProjectArchiveAuthExport = "none" | "stubs";
export type ProjectArchiveConsistencyInput = "pause-writes" | "cloud_write_pause_v1";
export type ProjectArchiveConsistencyMode = "cloud_write_pause_v1";
export type ProjectArchiveStatus = "running" | "ready" | "failed" | "expired";

export type ArchiveDiagnosticSeverity = "info" | "warning" | "blocking";
export type ArchiveNextActionType =
  | "run_command"
  | "set_secret"
  | "change_export_scope"
  | "remove_unsupported_feature"
  | "retry_later"
  | "contact_support"
  | "read_docs"
  | "none";

export interface ArchiveNextAction {
  type: ArchiveNextActionType;
  command?: string;
  env_var?: string;
  docs_url?: string;
  message?: string;
}

export interface ArchiveDiagnostic {
  code: string;
  severity: ArchiveDiagnosticSeverity;
  resource_type: string;
  resource_id?: string;
  path?: string;
  message: string;
  next_action: ArchiveNextAction;
  retryable: boolean;
  context?: Record<string, unknown>;
}

export interface ArchiveSecretRequirement {
  name: string;
  required: boolean;
  targets?: string[];
  description?: string;
}

export interface ArchivePortabilityReport {
  schema_version?: string;
  entries: ArchiveDiagnostic[];
}

export interface ArchiveExportReport {
  schema_version?: string;
  export_scope?: string;
  auth_export?: string;
  consistency?: string;
  omitted_sensitive_resource_count?: number;
  unsupported_resource_count?: number;
  [key: string]: unknown;
}

export interface ArchiveImportLimits {
  maxFiles?: number;
  maxExpandedBytes?: number;
  maxFileBytes?: number;
  maxDescriptorBytes?: number;
  maxDescriptorDepth?: number;
}

export interface ArchiveVerifyResult {
  ok: boolean;
  archive_version: "run402-project-archive.v1" | null;
  archive_digest: `sha256:${string}` | null;
  transport: "directory" | "tar" | null;
  file_count: number;
  total_bytes: number;
  descriptor_count: number;
  required_capabilities: string[];
  required_secrets: ArchiveSecretRequirement[];
  auth_subject_stub_count: number;
  export_report: ArchiveExportReport | null;
  portability_report: ArchivePortabilityReport | null;
  diagnostics: ArchiveDiagnostic[];
}

export type ArchiveInspectResult = ArchiveVerifyResult;

export interface ArchiveImportResult {
  schema_version: "run402.project_archive.import_result.v1";
  status: "dry_run" | "imported" | "blocked" | "failed";
  archive_digest: `sha256:${string}` | null;
  project_id?: string;
  project_name?: string;
  release_id?: string | null;
  required_secrets: ArchiveSecretRequirement[];
  diagnostics: ArchiveDiagnostic[];
  next_action: ArchiveNextAction;
}

export interface ProjectArchiveCreateOptions {
  scope?: ProjectArchiveScope;
  auth?: ProjectArchiveAuthExport;
  consistency?: ProjectArchiveConsistencyInput;
  idempotencyKey?: string;
}

export interface ProjectArchiveDto {
  archive_id: string;
  operation_id: string;
  project_id: string;
  status: ProjectArchiveStatus;
  format_version: string;
  scope: string;
  auth_export: ProjectArchiveAuthExport | (string & {});
  consistency_mode: ProjectArchiveConsistencyMode | (string & {});
  active_release_id: string | null;
  consistency: unknown;
  export_report: ArchiveExportReport | unknown;
  portability_report: ArchivePortabilityReport | unknown;
  error: unknown | null;
  byte_count: number | null;
  sha256: string | null;
  content_type: string | null;
  download_url: string | null;
  download_authorized_until: string | null;
  expires_at: string;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  next_action: ArchiveNextAction;
}

export interface ProjectArchiveWaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onProgress?: (event: ProjectArchiveProgressEvent) => void | Promise<void>;
}

export interface ProjectArchiveDownload {
  archive: ProjectArchiveDto;
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export interface ProjectArchiveExportOptions extends ProjectArchiveCreateOptions, ProjectArchiveWaitOptions {}

export interface ProjectArchiveExportResult extends ProjectArchiveDownload {
  created: ProjectArchiveDto;
}

export interface ProjectArchiveProgressEvent {
  event: string;
  stage: "create" | "wait" | "download" | "complete";
  resource_type: "project_archive";
  resource_id: string | null;
  project_id: string;
  status: ProjectArchiveStatus | "created" | "downloaded" | "complete";
  completed_units: number;
  total_units: number;
  code: string | null;
  message: string;
  next_action: ArchiveNextAction;
  retryable: boolean;
  context?: Record<string, unknown>;
}

export interface ArchiveImportToCoreOptions {
  archivePath: string;
  name?: string;
  coreUrl?: string;
  envFile?: string;
  secretValues?: Record<string, string>;
  dryRun?: boolean;
  requireRunnable?: boolean;
  limits?: ArchiveImportLimits;
}

export interface ArchiveDiagnosticEnvelope {
  code: string;
  severity: ArchiveDiagnostic["severity"];
  resource_type: string;
  resource_id?: string;
  path?: string;
  message: string;
  next_action: ArchiveNextAction;
  retryable: boolean;
  context?: Record<string, unknown>;
}
