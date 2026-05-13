/**
 * Request and response types for the `projects` namespace.
 *
 * These types map to the shapes of the run402 API endpoints exposed by
 * the gateway. They are intentionally not re-used from the gateway source
 * (private repo) — the SDK version is the canonical client-side contract.
 */

import type { ProjectKeys } from "../credentials.js";
import type { ExposeManifest } from "./deploy.types.js";

// ─── provision ──────────────────────────────────────────────────────────

export type ProjectTier = "prototype" | "hobby" | "team";

export interface ProvisionOptions {
  /** Tier determines price, lease length, storage, and API-call limits. Default: "prototype". */
  tier?: ProjectTier;
  /** Optional display name. Auto-generated when omitted. */
  name?: string;
}

export interface ProvisionResult {
  project_id: string;
  anon_key: string;
  service_key: string;
  schema_slot: string;
}

// ─── list ───────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  tier: string;
  status: string;
  api_calls: number;
  storage_bytes: number;
  /**
   * Optional: the gateway's project list does not currently include the
   * lease expiry. Read it from `r.tier.status()` if you need it.
   * `null` is reserved for unleased accounts.
   */
  lease_expires_at?: string | null;
  created_at: string;
}

export interface ListProjectsResult {
  wallet: string;
  projects: ProjectSummary[];
}

// ─── usage ──────────────────────────────────────────────────────────────

export interface UsageReport {
  project_id: string;
  tier: string;
  api_calls: number;
  api_calls_limit: number;
  storage_bytes: number;
  storage_limit_bytes: number;
  /**
   * Optional: the `/projects/v1/admin/:id/usage` endpoint does not currently
   * include the lease expiry. Read it from `tier.status()` if you need it.
   * `null` is reserved for unleased accounts (see GH-163).
   */
  lease_expires_at?: string | null;
  status: string;
}

// ─── schema ─────────────────────────────────────────────────────────────

export interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  default_value: string | null;
}

export interface ConstraintSchema {
  name: string;
  type: string;
  definition: string;
}

export interface RlsPolicy {
  name: string;
  command: string;
  using_expression: string | null;
  check_expression: string | null;
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  constraints: ConstraintSchema[];
  rls_enabled: boolean;
  policies: RlsPolicy[];
}

export interface SchemaReport {
  schema: string;
  tables: TableSchema[];
}

// ─── REST / PostgREST ─────────────────────────────────────────────────

export type ProjectRestMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type ProjectRestKeyType = "anon" | "service";

export interface ProjectRestOptions {
  /** HTTP method. Default: "GET". */
  method?: ProjectRestMethod;
  /** Query string without leading "?", or key/value query parameters. */
  query?: string | Record<string, string>;
  /** JSON body for POST/PATCH/DELETE requests. */
  body?: unknown;
  /** Key used for apikey + bearer auth. Default: "anon". */
  keyType?: ProjectRestKeyType;
}

export interface ProjectRestResponse<T = unknown> {
  status: number;
  body: T;
}

// ─── expose manifest validation ───────────────────────────────────────

export type ExposeManifestValidationInput = ExposeManifest | string;

export interface ValidateExposeOptions {
  /** Project id used for live-schema validation. Omit for projectless validation. */
  project?: string;
  /** Alias for `project`, accepted for callers that already use gateway/MCP naming. */
  project_id?: string;
  /** Migration SQL used as validation context only; it is not executed. */
  migrationSql?: string;
}

export type ExposeManifestValidationIssueType =
  | "missing-table"
  | "missing-column"
  | "missing-view-base"
  | "missing-rpc"
  | "ambiguous-rpc"
  | "unrestricted-ack-required"
  | "sensitive-column-public-write"
  | "grant-to-role-unknown"
  | "force-owner-without-owner-column"
  | "validation-inconclusive"
  | "schema-shape";

export type ExposeManifestValidationSeverity = "error" | "warning";

export interface ExposeManifestValidationIssue {
  type: ExposeManifestValidationIssueType;
  severity: ExposeManifestValidationSeverity;
  detail: string;
  fix?: string;
}

export interface ExposeManifestValidationResult {
  hasErrors: boolean;
  errors: ExposeManifestValidationIssue[];
  warnings: ExposeManifestValidationIssue[];
}

// ─── pin ────────────────────────────────────────────────────────────────

export interface PinResult {
  status: string;
  project_id: string;
  message?: string;
}

// ─── quote ──────────────────────────────────────────────────────────────

export interface TierQuote {
  price: string;
  lease_days: number;
  storage_mb: number;
  api_calls: number;
  max_functions: number;
  description: string;
}

export interface QuoteResult {
  tiers: Record<string, TierQuote>;
  auth?: Record<string, unknown>;
}

// ─── local (keystore-backed) ────────────────────────────────────────────

export interface ProjectInfo extends ProjectKeys {
  project_id: string;
}
