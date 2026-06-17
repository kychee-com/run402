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
  /**
   * Provision into an EXISTING org by id (v1.82). The caller must hold a
   * `developer`+ membership on that org (a project-scoped grant cannot authorize
   * creating a new project). Omit for the cold-start path — the wallet's billing
   * account is used or auto-created exactly as before. Note: tier is governed by
   * the org/organization, not the project — the gateway ignores a client tier.
   */
  orgId?: string;
}

export interface ProvisionResult {
  project_id: string;
  anon_key: string;
  service_key: string;
  schema_slot: string;
}

// ─── list ───────────────────────────────────────────────────────────────

/**
 * Lifecycle state of the owning organization (gateway v1.57+). The state
 * machine moved from `internal.projects` to `internal.organizations`; every
 * project on the account inherits the same value. `purging` is an internal
 * transition state and is not exposed on the wire.
 */
export type OrganizationLifecycleState =
  | "active"
  | "past_due"
  | "frozen"
  | "dormant"
  | "purged";

/**
 * Effective project status, derived from `(organization_lifecycle_state,
 * deleted_at, archived_at)`:
 *   - `deleted_at` set → `"deleted"`
 *   - `archived_at` set → `"archived"`
 *   - otherwise → the organization's `lifecycle_state`
 *
 * Use this for serving / UX decisions instead of trying to combine the
 * underlying fields yourself.
 */
export type EffectiveProjectStatus =
  | "active"
  | "past_due"
  | "frozen"
  | "dormant"
  | "archived"
  | "deleted";

/**
 * One project row from the named, domain-aware inventory (gateway
 * `project-findability`). Returned by `GET /projects/v1` (membership-scoped)
 * and `GET /agent/v1/operator/projects` (operator email-union, `--all`) — both
 * share this shape.
 *
 * Tier and lifecycle live on the owning organization, not the project; the
 * row mirrors them for convenience but read `r.tier.status()` for the
 * authoritative account view.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Account-derived tier (mirror; authoritative source is `r.tier.status()`). */
  tier?: string;
  /**
   * Primary public URL: the first claimed run402.com subdomain, else the first
   * custom domain, else null. Surfaced by the named inventory (`GET /projects/v1`
   * and the operator `--all` read).
   */
  site_url?: string | null;
  /**
   * Every custom hostname mapped to this project (empty when none). The
   * run402.com subdomain is reflected in `site_url`, not here.
   */
  custom_domains?: string[];
  /** Derived effective status — see {@link EffectiveProjectStatus}. */
  status?: EffectiveProjectStatus;
  /** Alias of `status` (gateway v1.57 canonical field). */
  effective_status?: EffectiveProjectStatus;
  /** Owning organization's lifecycle state. */
  organization_lifecycle_state?: OrganizationLifecycleState;
  /** Account-level lease-perpetual escape hatch (mirror). */
  lease_perpetual?: boolean;
  /**
   * Owning org (organization) id — v1.77 org-owned control plane. A wallet
   * authenticates; the org owns the project. Surfaced as `org_id` in CLI/MCP
   * output. `null` for legacy rows; optional because the legacy wallet-scoped
   * list (`GET /wallets/v1/:address/projects`) omits it.
   */
  org_id?: string | null;
  /**
   * Provisioning principal id — provenance for who created the project (v1.77).
   * Optional for the same reason as {@link ProjectSummary.org_id}.
   */
  created_by?: string | null;
  created_at: string;
  deleted_at?: string | null;
  archived_at?: string | null;
  /**
   * Legacy wallet-scoped list (`GET /wallets/v1/:address/projects`) only — the
   * named inventory does not include per-project usage counters. Read
   * `r.projects.getUsage(id)` for live usage.
   */
  api_calls?: number;
  /** See {@link ProjectSummary.api_calls}. */
  storage_bytes?: number;
}

/**
 * Options for {@link Projects.list}.
 *
 * Membership-scoped by default (`GET /projects/v1` — every project owned by an
 * org the caller's principal is an active member of). The cold-start lone-agent
 * path is `list()` with no options.
 */
export interface ListProjectsOptions {
  /**
   * Narrow to projects owned by one org (organization) id. Authorize-before-
   * reveal: a non-member or guessed id returns the same 403 as a real-but-
   * unauthorized org; a non-UUID id is a clean 400.
   */
  org?: string;
  /**
   * Read the operator email-union inventory across every wallet controlling the
   * operator's verified email (`GET /agent/v1/operator/projects`) instead of the
   * single membership-scoped slice. Supply `token` for the cross-wallet union;
   * without it, `all` authenticates with SIWX wallet auth and returns only that
   * wallet's slice. Mutually exclusive with `org`.
   */
  all?: boolean;
  /**
   * Operator-session bearer token for the `all` email-union read. When omitted,
   * `all` uses SIWX wallet auth. Ignored when `all` is not set.
   */
  token?: string;
  /** Page size. Server default 50, max 200. Ignored for `all` (union, unpaged). */
  limit?: number;
  /** Opaque pagination cursor from a previous response's `next_cursor`. */
  cursor?: string;
}

export interface ListProjectsResult {
  projects: ProjectSummary[];
  /** True when more pages remain (membership-scoped reads). */
  has_more?: boolean;
  /** Cursor to fetch the next page, or null at the end. */
  next_cursor?: string | null;
  /** `all` reads echo the resolved scope: `"email"` (union) or `"wallet"` (slice). */
  scope?: string;
}

/** Result of {@link Projects.rename}. */
export interface RenameProjectResult {
  project_id: string;
  name: string;
}

// ─── single-project read (server, authoritative) ─────────────────────────

/** Active-release pointer on {@link ProjectDetail}. `null` when nothing is live. */
export interface ProjectLastDeploy {
  release_id: string;
  activated_at: string;
}

/** Usage counters paired with the owning account's tier limits. */
export interface ProjectUsageWithLimits {
  api_calls: number;
  storage_bytes: number;
  api_calls_limit: number;
  storage_bytes_limit: number;
}

/**
 * Authoritative server-side view of one project, from `GET /projects/v1/:project_id`
 * (gateway `project.read`). A superset of {@link ProjectSummary} that adds the
 * public id, the active-release pointer, active mailbox addresses, and usage vs.
 * tier limits. Carries NO key material — the endpoint never returns secrets; read
 * `r.projects.keys(id)` (local) for the anon/service keys.
 *
 * Authorize-before-reveal: a caller without `project.read` authority sees the same
 * `Unauthorized` for a real-but-forbidden project as for an absent one — never a
 * 404 that would confirm existence.
 */
export interface ProjectDetail {
  project_id: string;
  /** Short public identifier (distinct from the `prj_…` id). */
  public_id: string;
  name: string;
  /** Owning org (organization) id — v1.77 org-owned control plane. */
  org_id: string;
  /** Account-derived tier (authoritative source is `r.tier.status()`). */
  tier: string;
  /** Derived effective status — see {@link EffectiveProjectStatus}. */
  effective_status: EffectiveProjectStatus;
  /** Owning organization's lifecycle state. */
  organization_lifecycle_state: OrganizationLifecycleState;
  /** Primary public URL, or `null` when none is claimed. */
  site_url: string | null;
  /** Every custom hostname mapped to this project (empty when none). */
  custom_domains: string[];
  /** Active-release pointer, or `null` when nothing is deployed. */
  last_deploy: ProjectLastDeploy | null;
  /** Active mailbox addresses (formatted, e.g. `hello@mail.run402.com`). */
  mailbox: string[];
  /** Usage counters paired with the owning account's tier limits. */
  usage: ProjectUsageWithLimits;
  created_at: string;
  /** Forward-compat: unknown future fields a newer gateway may add. */
  [key: string]: unknown;
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
  /** Derived effective status — see {@link EffectiveProjectStatus}. */
  effective_status: EffectiveProjectStatus;
  /** Owning organization's lifecycle state. */
  organization_lifecycle_state: OrganizationLifecycleState;
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
  /**
   * Planner row estimate (`reltuples`), refreshed by ANALYZE/VACUUM. Always an
   * estimate, never an exact count. `null` when the table was never analyzed
   * (so "unknown" stays distinguishable from a real zero); may be absent from
   * gateways predating the field.
   */
  row_estimate?: number | null;
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
