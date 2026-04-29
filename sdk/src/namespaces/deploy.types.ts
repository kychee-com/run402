/**
 * Type definitions for the unified `deploy.apply` primitive (`unified-deploy`
 * capability, gateway routes `POST /deploy/v2/plans` + commit + operations).
 *
 * The user-facing inputs accept polymorphic byte sources (strings, Uint8Array,
 * Blob, web streams, plus the Node-only `fileSetFromDir`). The wire shapes
 * carry only `ContentRef` objects — the SDK normalizes byte sources into
 * refs via the CAS content service before issuing the plan request.
 */

// ─── Byte sources ────────────────────────────────────────────────────────────

/**
 * Marker for a filesystem file path. Produced by `fileSetFromDir` from
 * `@run402/sdk/node` so the normalizer can stream-hash from disk without
 * loading bytes into memory.
 *
 * Exposed as a discriminated shape rather than a class so it round-trips
 * through `JSON.parse(JSON.stringify(...))` without losing its identity.
 */
export interface FsFileSource {
  readonly __source: "fs-file";
  readonly path: string;
  readonly contentType?: string;
}

/**
 * Anything the SDK can normalize into a `ContentRef`. Pass UTF-8 strings,
 * raw bytes, `Blob`/`File` (web), web `ReadableStream`, an `FsFileSource`
 * from `fileSetFromDir`, or a wrapper `{ data, contentType? }` for explicit
 * MIME-type control.
 */
export type ContentSource =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | FsFileSource
  | { data: ContentSource; contentType?: string }
  | ContentRef;

// ─── ContentRef + FileSet ────────────────────────────────────────────────────

/**
 * Wire-level reference to a content-addressed object. Produced by hashing a
 * byte source locally and (optionally) negotiating presence via
 * `POST /content/v1/plans`. The `sha256` is lowercase hex; `integrity` is
 * the browser SRI form (`sha256-<base64>`) when emitted.
 */
export interface ContentRef {
  sha256: string;
  size: number;
  contentType?: string;
  integrity?: string;
}

/** A path-keyed set of content. Values may be byte sources (normalized by the
 *  SDK) or already-resolved `ContentRef` objects (from a prior upload). */
export type FileSet = Record<string, ContentSource>;

// ─── ReleaseSpec ─────────────────────────────────────────────────────────────

/** Caller-facing spec passed to `r.deploy.apply(spec)`. */
export interface ReleaseSpec {
  /** Project id the release belongs to. */
  project: string;
  /** Diff base for the new release. Default: `{ release: "current" }`. Pass
   *  `{ release: "empty" }` for a fresh deploy that should fail if a release
   *  already exists, or `{ release_id: "rel_..." }` to pin a specific base. */
  base?: { release: "current" | "empty" } | { release_id: string };

  database?: DatabaseSpec;
  secrets?: SecretsSpec;
  functions?: FunctionsSpec;
  site?: SiteSpec;
  subdomains?: SubdomainsSpec;
  routes?: RouteSpec;
  checks?: SmokeCheck[];
}

export interface DatabaseSpec {
  migrations?: MigrationSpec[];
  /** Declarative authorization manifest — replaces the deprecated
   *  template-based `rls` from the legacy bundle deploy. */
  expose?: ExposeManifest;
  /** Opt-in: skip the migrate-gate phase. Only safe when migrations are
   *  declared backward-compatible (no breaking schema changes). */
  zero_downtime?: boolean;
}

export interface MigrationSpec {
  /** Stable migration id, e.g. `"001_init"`. Same id + same checksum across
   *  re-deploys is a registry noop; same id + different checksum is a hard
   *  error. */
  id: string;
  /** Lowercase hex SHA-256 of the migration SQL. Computed by the SDK from
   *  `sql` if not provided. */
  checksum?: string;
  /** Inline SQL (UTF-8). The SDK uploads to CAS and replaces with `sql_ref`
   *  before the plan request. Either `sql` or `sql_ref` is required. */
  sql?: string;
  /** Pre-uploaded SQL CAS reference. */
  sql_ref?: ContentRef;
  /** Default `"required"` — runs in a single advisory-locked transaction.
   *  `"none"` opts out (and on failure, sends the operation to
   *  `needs_repair` rather than rolling back). */
  transaction?: "required" | "none";
}

/** Declarative authorization manifest. Pass-through shape — the gateway
 *  validates the schema. See https://run402.com/schemas/manifest.v1.json. */
export interface ExposeManifest {
  version?: string;
  tables?: Array<Record<string, unknown>>;
  views?: Array<Record<string, unknown>>;
  rpcs?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface SecretsSpec {
  /** Set or update specific secrets. Existing secrets not in `set` remain. */
  set?: Record<string, { value: string }>;
  /** Delete specific secrets by key. */
  delete?: string[];
  /** Replace all secrets with this exact set (anything else is removed). */
  replace_all?: Record<string, { value: string }>;
}

export interface FunctionsSpec {
  /** The new desired set — functions absent here are removed in the new
   *  release. */
  replace?: Record<string, FunctionSpec>;
  /** Surgical updates — only listed functions change. */
  patch?: { set?: Record<string, FunctionSpec>; delete?: string[] };
}

export interface FunctionSpec {
  runtime?: "node22";
  /** Bundled source (single file). Mutually exclusive with `files`. */
  source?: ContentSource;
  /** Multi-file function (entrypoint + assets). Provide `entrypoint` when
   *  using this shape. */
  files?: FileSet;
  /** Required when `files` is set. The relative path of the entrypoint
   *  within the file set (e.g., `"index.mjs"`). */
  entrypoint?: string;
  config?: { timeoutSeconds?: number; memoryMb?: number };
  /** 5-field cron expression. Pass `null` to remove an existing schedule;
   *  omit to leave it unchanged in `patch` mode. */
  schedule?: string | null;
}

export type SiteSpec =
  | { replace: FileSet }
  | { patch: { put?: FileSet; delete?: string[] } };

export interface SubdomainsSpec {
  /** The exact desired set. Currently limited to one element per project —
   *  the gateway returns `SUBDOMAIN_MULTI_NOT_SUPPORTED` for multi-element
   *  arrays. */
  set?: string[];
  /** Add specific subdomains without disturbing others. */
  add?: string[];
  /** Remove specific subdomains. */
  remove?: string[];
}

/** Forward-compat scaffold for same-origin function routes (e.g. `/api`). */
export interface RouteSpec {
  /** Path → resource mapping. Reserved for the route-table follow-up. */
  [path: string]: { function: string } | { redirect: string } | unknown;
}

export interface SmokeCheck {
  name: string;
  http?: { path: string; method?: string; expect?: { status?: number } };
}

// ─── Plan + commit + operation ───────────────────────────────────────────────

export interface PlanResponse {
  plan_id: string;
  operation_id: string;
  base_release_id: string | null;
  manifest_digest: string;
  /** Per-ref presence list. The gateway reports which content SHAs the
   *  project already has and which need to be uploaded. Items with
   *  `present: false` must be uploaded via `POST /content/v1/plans` before
   *  the deploy commit will succeed. */
  missing_content: PlanContentRef[];
  diff: DeployDiff;
  payment_required?: PaymentRequiredHint | null;
}

export interface PlanContentRef {
  sha256: string;
  size: number;
  present: boolean;
}

/**
 * Upload session entry for a missing content SHA. Returned by
 * `POST /content/v1/plans` after the deploy plan reports refs as missing.
 * The SDK PUTs bytes to each part's presigned URL; multipart sessions
 * complete via `POST /content/v1/plans/:id/commit`.
 */
export interface MissingContent {
  sha256: string;
  mode: "single" | "multipart";
  parts: Array<{
    part_number: number;
    url: string;
    byte_start: number;
    byte_end: number;
  }>;
  part_size_bytes: number;
  part_count: number;
  upload_id: string;
  staging_key: string;
  expires_at: string;
}

export interface ContentPlanResponse {
  plan_id: string;
  expires_at: string;
  missing: MissingContent[];
  entries: Array<{ sha256: string; missing: boolean }>;
}

export interface PaymentRequiredHint {
  amount: string;
  asset: string;
  payTo: string;
  reason: string;
}

/** Server-side summary of the diff between the base release and the new
 *  spec. Pass-through shape — the gateway authors the contents and the SDK
 *  surfaces it via the `plan.diff` event. */
export interface DeployDiff {
  resources?: Record<string, unknown>;
  migrations?: Array<{
    id: string;
    state: "new" | "noop" | "checksum_mismatch";
  }>;
  routes?: Array<{ kind: "added" | "removed"; path: string }>;
  subdomains?: Array<{ kind: "added" | "removed"; subdomain: string }>;
  [key: string]: unknown;
}

/** All operation states the gateway exposes. The SDK polls until it reaches
 *  a terminal state. */
export type OperationStatus =
  | "planning"
  | "uploading"
  | "committing"
  | "staging"
  | "gating"
  | "migrating"
  | "schema_settling"
  | "activating"
  | "activation_pending"
  | "needs_repair"
  | "ready"
  | "failed"
  | "rolled_back";

/** Status returned by the synchronous commit response (a subset of
 *  OperationStatus — the commit endpoint never returns mid-phase states like
 *  `gating`/`migrating`; those only appear via subsequent operation polls). */
export type CommitStatus =
  | "running"
  | "schema_settling"
  | "activation_pending"
  | "ready"
  | "failed";

export interface CommitResponse {
  operation_id: string;
  status: CommitStatus;
  release_id?: string;
  urls?: Record<string, string>;
  error?: GatewayDeployError | null;
}

export interface OperationSnapshot {
  operation_id: string;
  project_id: string;
  plan_id: string;
  status: OperationStatus;
  base_release_id: string | null;
  target_release_id: string | null;
  release_id: string | null;
  urls: Record<string, string> | null;
  payment_required: PaymentRequiredHint | null;
  error: GatewayDeployError | null;
  activate_attempts: number;
  last_activate_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Response from `GET /deploy/v2/operations`. The gateway may return a
 *  pagination cursor when there are more operations than the requested
 *  page size; clients pass it back as `?cursor=` to fetch the next page. */
export interface DeployListResponse {
  operations: OperationSnapshot[];
  cursor?: string | null;
}

/** Response from `GET /deploy/v2/operations/:id/events`. Returns the
 *  synthesized phase event stream the gateway has recorded so far for the
 *  operation. Same shape as the events emitted by `r.deploy.start().events()`
 *  during an in-flight deploy. */
export interface DeployEventsResponse {
  events: DeployEvent[];
}

/** Wire-shape for a structured deploy error from the gateway. The SDK
 *  translates this into `Run402DeployError` for callers. The gateway is
 *  permitted to omit `message` for terse validation errors (e.g. just
 *  `{code: "invalid_spec"}`); the SDK synthesizes a default in that case. */
export interface GatewayDeployError {
  code: string;
  phase?: string | null;
  resource?: string | null;
  message?: string;
  retryable?: boolean;
  fix?: { action: string; path?: string; [key: string]: unknown } | null;
  logs?: string[] | null;
  rolled_back?: boolean;
  /** Operation id supplied by the gateway when the error is associated with a
   *  specific deploy operation (e.g., MIGRATION_CHECKSUM_MISMATCH). The SDK
   *  prefers this over the caller-supplied operation id when constructing
   *  `Run402DeployError`, so resume hints round-trip correctly. */
  operation_id?: string;
  /** Plan id supplied by the gateway when the error originates inside a plan
   *  context. Same precedence rule as `operation_id`. */
  plan_id?: string;
  [key: string]: unknown;
}

// ─── Wire-level plan request shape (post-normalization) ──────────────────────

/** What the SDK actually POSTs to `/deploy/v2/plans`. Bytes are content
 *  refs, not inline. The gateway's wire envelope is `{ spec, manifest_ref?,
 *  idempotency_key? }`. Most callers never construct this directly; it's
 *  produced by the SDK's normalizer and exposed for the low-level
 *  `deploy.plan` layer. */
export interface PlanRequest {
  spec: NormalizedReleaseSpec;
  manifest_ref?: ContentRef;
  idempotency_key?: string;
}

export interface NormalizedReleaseSpec {
  project: string;
  base?: ReleaseSpec["base"];
  database?: NormalizedDatabaseSpec;
  secrets?: SecretsSpec;
  functions?: NormalizedFunctionsSpec;
  site?: NormalizedSiteSpec;
  subdomains?: SubdomainsSpec;
  routes?: RouteSpec;
  checks?: SmokeCheck[];
}

export interface NormalizedDatabaseSpec {
  migrations?: NormalizedMigrationSpec[];
  expose?: ExposeManifest;
  zero_downtime?: boolean;
}

export interface NormalizedMigrationSpec {
  id: string;
  /** Lowercase hex SHA-256 of the migration SQL. Required by the gateway. */
  checksum: string;
  sql_ref: ContentRef;
  transaction?: "required" | "none";
}

export interface NormalizedFunctionsSpec {
  replace?: Record<string, NormalizedFunctionSpec>;
  patch?: { set?: Record<string, NormalizedFunctionSpec>; delete?: string[] };
}

export interface NormalizedFunctionSpec {
  runtime?: "node22";
  source?: ContentRef;
  files?: Record<string, ContentRef>;
  entrypoint?: string;
  config?: { timeoutSeconds?: number; memoryMb?: number };
  schedule?: string | null;
}

export type NormalizedSiteSpec =
  | { replace: Record<string, ContentRef> }
  | { patch: { put?: Record<string, ContentRef>; delete?: string[] } };

// ─── Events + result ─────────────────────────────────────────────────────────

export type DeployEvent =
  | { type: "plan.started" }
  | { type: "plan.diff"; diff: DeployDiff }
  | {
      type: "payment.required";
      amount: string;
      asset: string;
      payTo: string;
      reason: string;
    }
  | { type: "payment.paid"; tx?: string }
  | {
      type: "content.upload.skipped";
      label: string;
      sha256: string;
      reason: "present" | "satisfied_by_plan";
    }
  | {
      type: "content.upload.progress";
      label: string;
      sha256: string;
      done: number;
      total: number;
    }
  | {
      type: "commit.phase";
      phase:
        | "validate"
        | "stage"
        | "migrate-gate"
        | "migrate"
        | "schema-settle"
        | "activate"
        | "ready";
      status: "started" | "done" | "failed";
    }
  | {
      type: "log";
      resource: string;
      stream: "stdout" | "stderr";
      line: string;
    }
  | { type: "ready"; releaseId: string; urls: Record<string, string> };

export interface DeployResult {
  release_id: string;
  operation_id: string;
  urls: Record<string, string>;
  /** The `diff` from the plan response — useful for "what changed in this
   *  deploy" UX. */
  diff: DeployDiff;
}

// ─── Apply / start / low-level options ───────────────────────────────────────

export interface ApplyOptions {
  /** Synchronous progress callback. Throws inside the callback are caught
   *  and silently dropped — a buggy consumer cannot abort a deploy. */
  onEvent?: (event: DeployEvent) => void;
  /** Client-side idempotency key. The SDK passes this to the gateway, which
   *  combines it with the manifest digest to deduplicate retries. Default:
   *  the gateway-computed manifest digest itself acts as the key. */
  idempotencyKey?: string;
}

export interface StartOptions extends ApplyOptions {}

export interface DeployOperation {
  /** The operation id (also exposed via the snapshot). */
  readonly id: string;
  /** Async iterable of events for as long as the operation is non-terminal. */
  events(): AsyncIterable<DeployEvent>;
  /** Resolves with the final result, or rejects with `Run402DeployError`. */
  result(): Promise<DeployResult>;
  /** Latest snapshot from the gateway. */
  snapshot(): Promise<OperationSnapshot>;
}
