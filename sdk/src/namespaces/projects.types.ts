/**
 * Request and response types for the `projects` namespace.
 *
 * These types map to the shapes of the run402 API endpoints exposed by
 * the gateway. They are intentionally not re-used from the gateway source
 * (private repo) — the SDK version is the canonical client-side contract.
 */

import type { ProjectKeys } from "../credentials.js";

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
  lease_expires_at: string;
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

// ─── RLS templates (used by apps.bundleDeploy expose translation) ─────

export type RlsTemplate =
  | "user_owns_rows"
  | "public_read_authenticated_write"
  | "public_read_write_UNRESTRICTED";

export interface RlsTableSpec {
  /** Table name (unqualified — the project's schema is implicit). */
  table: string;
  /** Column holding the owning user's id. Required when `template: "user_owns_rows"`. */
  owner_column?: string;
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
}

export interface QuoteResult {
  tiers: Record<string, TierQuote>;
}

// ─── local (keystore-backed) ────────────────────────────────────────────

export interface ProjectInfo extends ProjectKeys {
  project_id: string;
}
