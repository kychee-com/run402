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
  /** JSON Schema metadata for editor-authored specs. Stripped before plan requests. */
  $schema?: string;
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
  routes?: ReleaseRoutesSpec;
  checks?: SmokeCheck[];
}

export interface DatabaseSpec {
  migrations?: MigrationSpec[];
  /** Declarative authorization manifest applied during deploy. */
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
  /** Keys that must already exist in the project's secret store at commit time.
   *  Plan-time emits a MISSING_REQUIRED_SECRET warning for absent keys;
   *  commit-time hard-errors if they are still missing. */
  require?: string[];
  /** Delete specific secrets by key at activation. Unknown keys hard-error at commit-time gating. */
  delete?: string[];
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

export interface PublicStaticPathSpec {
  /** Release static asset path, e.g. "events.html". This is not a public URL. */
  asset: string;
  cache_class?: StaticCacheClass;
}

export type SitePublicPathsSpec =
  | { mode: "implicit"; replace?: never }
  | { mode: "explicit"; replace: Record<string, PublicStaticPathSpec> };

export type SiteSpec =
  | { replace: FileSet; patch?: never; public_paths?: SitePublicPathsSpec }
  | { patch: { put?: FileSet; delete?: string[] }; replace?: never; public_paths?: SitePublicPathsSpec }
  | { public_paths: SitePublicPathsSpec; replace?: never; patch?: never };

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

export const ROUTE_HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export type RouteHttpMethod = (typeof ROUTE_HTTP_METHODS)[number];

export interface FunctionRouteTarget {
  type: "function";
  /** Materialized release function name, not a file name or handler export. */
  name: string;
}

export interface StaticRouteTarget {
  type: "static";
  /** Materialized static-site file path, relative to the site root. */
  file: string;
}

export type RouteTarget = FunctionRouteTarget | StaticRouteTarget;

/** One deploy-v2 web route entry. */
export interface RouteSpec {
  pattern: string;
  /** Omit to allow every supported method. Empty arrays are invalid. */
  methods?: readonly RouteHttpMethod[];
  target: RouteTarget;
  /** Durable acknowledgement for intentional read-only wildcard function routes.
   *  Valid only with final-wildcard function routes whose methods are limited
   *  to GET/HEAD. */
  acknowledge_readonly?: true;
}

/** Top-level release route resource. Omit or pass null to carry routes forward. */
export type ReleaseRoutesSpec = null | { replace: RouteSpec[] };

export interface SmokeCheck {
  name: string;
  http?: { path: string; method?: string; expect?: { status?: number } };
}

// ─── Stable static assets + public URL diagnostics ──────────────────────────

type LiteralUnion<T extends string> = T | (string & {});

export type KnownStaticCacheClass =
  | "html"
  | "immutable_versioned"
  | "revalidating_asset";

export type StaticCacheClass = LiteralUnion<KnownStaticCacheClass>;

export interface StaticManifestMetadata {
  file_count: number;
  total_bytes: number;
  cache_classes: Record<string, number>;
  cache_class_sources: Record<string, number>;
  spa_fallback: string | null;
}

export const EMPTY_STATIC_MANIFEST_METADATA: StaticManifestMetadata = {
  file_count: 0,
  total_bytes: 0,
  cache_classes: {},
  cache_class_sources: {},
  spa_fallback: null,
};

export function normalizeStaticManifestMetadata(
  metadata: StaticManifestMetadata | null | undefined,
): StaticManifestMetadata {
  return metadata ?? EMPTY_STATIC_MANIFEST_METADATA;
}

export interface StaticAssetsDiff {
  unchanged: number;
  changed: number;
  added: number;
  removed: number;
  newly_uploaded_cas_bytes: number;
  reused_cas_bytes: number;
  deployment_copy_bytes_eliminated: number;
  legacy_immutable_warnings: Array<{
    path: string;
    sha256: string;
    reason: string;
  }>;
  previous_immutable_failures: Array<{
    path: string;
    previous_sha256: string;
    candidate_sha256: string;
  }>;
  cas_authorization_failures: string[];
}

export type DeployResolveMethod = RouteHttpMethod | (string & {});

export type KnownDeployResolveMatch =
  | "host_missing"
  | "manifest_missing"
  | "active_release_missing"
  | "unsupported_manifest_version"
  | "path_error"
  | "none"
  | "static_exact"
  | "static_index"
  | "spa_fallback"
  | "spa_fallback_missing"
  | "route_function"
  | "route_static_alias"
  | "route_method_miss";

export type DeployResolveMatch = LiteralUnion<KnownDeployResolveMatch>;

export type KnownDeployResolveAuthorizationResult =
  | "authorized"
  | "not_public"
  | "not_applicable"
  | "manifest_missing"
  | "target_missing"
  | "active_release_missing"
  | "unsupported_manifest_version"
  | "path_error"
  | "missing_cas_object"
  | "unfinalized_or_deleting_cas_object"
  | "size_mismatch"
  | "unauthorized_cas_object";

export type DeployResolveAuthorizationResult =
  LiteralUnion<KnownDeployResolveAuthorizationResult>;

export type KnownDeployResolveFallbackState =
  | "unavailable"
  | "active_release_missing"
  | "unsupported_manifest_version"
  | "negative_cache_hit"
  | "path_error"
  | "method_not_static"
  | "not_used"
  | "target_missing"
  | "used"
  | "not_configured"
  | "not_eligible";

export type DeployResolveFallbackState =
  LiteralUnion<KnownDeployResolveFallbackState>;

export type KnownDeployResolveResult = 200 | 400 | 404 | 405 | 503;

export interface DeployResolveRouteMatch {
  pattern: string;
  methods: RouteHttpMethod[] | string[] | null;
  target: RouteTarget;
}

export interface DeployResolveCasObject {
  sha256: string;
  exists: boolean;
  expected_size: number;
  actual_size?: number | null;
  [key: string]: unknown;
}

export interface DeployResolveResponseVariant {
  kind: string;
  varies_by: string | string[];
  hostname: string;
  release_id: string | null;
  release_generation: number | null;
  path: string;
  raw_static_sha256: string;
  variant_inputs_hash: string;
  [key: string]: unknown;
}

export type DeployResolveOptions =
  | {
      project: string;
      url: string | URL;
      method?: DeployResolveMethod;
      host?: never;
      path?: never;
    }
  | {
      project: string;
      host: string;
      path?: string;
      method?: DeployResolveMethod;
      url?: never;
    };

export type ScopedDeployResolveOptions =
  | (Omit<Extract<DeployResolveOptions, { url: string | URL }>, "project"> & {
      project?: string;
    })
  | (Omit<Extract<DeployResolveOptions, { host: string }>, "project"> & {
      project?: string;
    });

export interface NormalizedDeployResolveRequest {
  project: string;
  project_scope: "credential_lookup_only";
  project_sent_to_gateway: false;
  original_url?: string;
  host: string;
  path: string;
  method?: string;
  ignored?: {
    query?: string;
    fragment?: string;
  };
}

export interface DeployResolveResponse {
  hostname: string;
  host_binding_id?: string | null;
  binding_status?: string | null;
  project_id?: string | null;
  channel?: string | null;
  release_id?: string | null;
  release_generation?: number | null;
  route_manifest_sha256?: string | null;
  static_manifest_sha256?: string | null;
  static_manifest_metadata?: StaticManifestMetadata | null;
  normalized_path?: string | null;
  match: DeployResolveMatch;
  route?: DeployResolveRouteMatch | null;
  asset_path?: string | null;
  reachability_authority?: StaticReachabilityAuthority | null;
  direct?: boolean | null;
  static_sha256?: string | null;
  content_type?: string | null;
  cache_class?: StaticCacheClass | null;
  cache_policy?: string | null;
  authorization_result?: DeployResolveAuthorizationResult | null;
  cas_object?: DeployResolveCasObject | null;
  response_variant?: DeployResolveResponseVariant | null;
  allow?: RouteHttpMethod[] | string[] | null;
  route_pattern?: string | null;
  target_type?: LiteralUnion<"function" | "static"> | null;
  target_name?: string | null;
  target_file?: string | null;
  authorized: boolean;
  fallback_state: DeployResolveFallbackState;
  error_code?: string | null;
  legacy_immutable_risk?: Array<Record<string, unknown>>;
  emergency_fallback?: Record<string, unknown> | null;
  /** Diagnostic body status. This is not necessarily the HTTP response status. */
  result: number;
  [key: string]: unknown;
}

export interface DeployResolveWarning {
  code: string;
  message: string;
}

export interface DeployResolveNextStep {
  code: string;
  message: string;
}

export interface DeployResolveSummary {
  would_serve: boolean;
  diagnostic_status: number;
  match: DeployResolveMatch;
  category: string;
  summary: string;
  warnings: DeployResolveWarning[];
  next_steps: DeployResolveNextStep[];
}

export function normalizeDeployResolveRequest(
  opts: DeployResolveOptions,
): NormalizedDeployResolveRequest {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("Deploy resolve options must be an object");
  }
  const hasUrl = "url" in opts && opts.url !== undefined;
  const hasHost = "host" in opts && opts.host !== undefined;
  if (hasUrl === hasHost) {
    throw new TypeError(
      "Deploy resolve requires exactly one input form: a full absolute url, or a clean host/path pair.",
    );
  }
  if (!opts.project || typeof opts.project !== "string") {
    throw new TypeError("Deploy resolve requires project");
  }

  const method = normalizeDeployResolveMethod(opts.method);
  if (hasUrl) {
    const original = String(opts.url);
    let parsed: URL;
    try {
      parsed = opts.url instanceof URL ? opts.url : new URL(original);
    } catch {
      throw new TypeError(
        "Deploy resolve url must be an absolute HTTP(S) public URL.",
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError(
        "Deploy resolve url must use http: or https:.",
      );
    }
    if (parsed.username || parsed.password) {
      throw new TypeError(
        "Deploy resolve url must not include username or password credentials.",
      );
    }
    const ignored: NormalizedDeployResolveRequest["ignored"] = {};
    if (parsed.search) ignored.query = parsed.search;
    if (parsed.hash) ignored.fragment = parsed.hash;
    return {
      project: opts.project,
      project_scope: "credential_lookup_only",
      project_sent_to_gateway: false,
      original_url: original,
      host: parsed.hostname,
      path: parsed.pathname || "/",
      ...(method ? { method } : {}),
      ...(Object.keys(ignored).length > 0 ? { ignored } : {}),
    };
  }

  const host = opts.host;
  if (typeof host !== "string" || host.length === 0) {
    throw new TypeError("Deploy resolve host must be a non-empty hostname.");
  }
  if (
    /\s/.test(host) ||
    host.includes("/") ||
    host.includes("?") ||
    host.includes("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(host) ||
    host.includes("@")
  ) {
    throw new TypeError(
      "Deploy resolve host must be a clean hostname without scheme, credentials, path, query, or fragment.",
    );
  }
  const path = opts.path;
  if (path !== undefined) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("Deploy resolve path must start with '/'.");
    }
    if (path.includes("?") || path.includes("#")) {
      throw new TypeError(
        "Deploy resolve host/path mode does not accept query strings or fragments in path.",
      );
    }
  }
  return {
    project: opts.project,
    project_scope: "credential_lookup_only",
    project_sent_to_gateway: false,
    host,
    path: path ?? "/",
    ...(method ? { method } : {}),
  };
}

export function isDeployResolveStaticHit(
  response: DeployResolveResponse,
): response is DeployResolveResponse & {
  match: "static_exact" | "static_index" | "spa_fallback";
} {
  return (
    response.match === "static_exact" ||
    response.match === "static_index" ||
    response.match === "spa_fallback"
  );
}

export function isDeployResolveRouteHit(
  response: DeployResolveResponse,
): response is DeployResolveResponse & { route: DeployResolveRouteMatch } {
  return !!response.route && typeof response.route === "object";
}

export function buildDeployResolveSummary(
  response: DeployResolveResponse,
  request: NormalizedDeployResolveRequest,
): DeployResolveSummary {
  const warnings = deployResolveWarningsForRequest(request);
  const next_steps = deployResolveNextSteps(response);
  const would_serve =
    response.authorized === true &&
    isDeployResolveAuthorizationPassing(response) &&
    response.result >= 200 &&
    response.result < 400 &&
    response.match !== "host_missing" &&
    response.match !== "route_method_miss" &&
    !isDeployResolveCasFailure(response);
  const method = request.method ?? "GET";
  const url = `${method} ${request.original_url ? displayResolveUrl(request) : `https://${request.host}${request.path}`}`;
  const category = deployResolveCategory(response);
  const summary = deployResolveSummaryText(response, url);
  return {
    would_serve,
    diagnostic_status: response.result,
    match: response.match,
    category,
    summary,
    warnings,
    next_steps,
  };
}

export function summarizeDeployResult(result: DeployResult): DeploySummary {
  const diff = result.diff ?? {};
  const summary: DeploySummary = {
    schema_version: "deploy-summary.v1",
    release_id: result.release_id,
    operation_id: result.operation_id,
    ...(typeof diff.is_noop === "boolean" ? { is_noop: diff.is_noop } : {}),
    headline: "",
    warnings: summarizeDeployWarnings(result.warnings),
  };

  const site = summarizeDeploySite(diff);
  if (site) summary.site = site;

  if (isModernFunctionsDiff(diff.functions)) {
    summary.functions = {
      added: [...diff.functions.added],
      removed: [...diff.functions.removed],
      changed: diff.functions.changed.map((entry) => ({
        name: entry.name,
        fields_changed: [...entry.fields_changed],
      })),
    };
  }

  if (isModernPlanMigrationDiff(diff.migrations)) {
    summary.migrations = {
      new: diff.migrations.new.map((entry) => entry.id),
      noop: diff.migrations.noop.map((entry) => entry.id),
    };
  }

  if (isModernRoutesDiff(diff.routes)) {
    summary.routes = summarizeResourceCounts(diff.routes);
  }

  if (isModernSecretsDiff(diff.secrets)) {
    summary.secrets = {
      added: diff.secrets.added.length,
      removed: diff.secrets.removed.length,
    };
  }

  if (isModernSubdomainsDiff(diff.subdomains)) {
    summary.subdomains = {
      added: diff.subdomains.added.length,
      removed: diff.subdomains.removed.length,
    };
  }

  summary.headline = buildDeploySummaryHeadline(summary);
  return summary;
}

function summarizeDeployWarnings(warnings: WarningEntry[]): DeploySummaryWarnings {
  const codes = Array.from(new Set(warnings.map((warning) => warning.code))).sort();
  return {
    count: warnings.length,
    blocking: warnings.filter(
      (warning) =>
        warning.requires_confirmation || warning.code === "MISSING_REQUIRED_SECRET",
    ).length,
    codes,
  };
}

function summarizeDeploySite(diff: DeployDiff): DeploySummarySite | undefined {
  const out: DeploySummarySite = {};
  if (isStaticAssetsDiff(diff.static_assets)) {
    out.paths = {
      added: diff.static_assets.added,
      changed: diff.static_assets.changed,
      removed: diff.static_assets.removed,
      unchanged: diff.static_assets.unchanged,
      total_changed:
        diff.static_assets.added +
        diff.static_assets.changed +
        diff.static_assets.removed,
    };
    out.cas = {
      newly_uploaded_bytes: diff.static_assets.newly_uploaded_cas_bytes,
      reused_bytes: diff.static_assets.reused_cas_bytes,
      deployment_copy_bytes_eliminated:
        diff.static_assets.deployment_copy_bytes_eliminated,
    };
  } else if (isModernSiteDiff(diff.site)) {
    const added = diff.site.totals?.added ?? diff.site.added.length;
    const changed = diff.site.totals?.changed ?? diff.site.changed.length;
    const removed = diff.site.totals?.removed ?? diff.site.removed.length;
    out.paths = {
      added,
      changed,
      removed,
      total_changed: added + changed + removed,
    };
  }

  return out.paths || out.cas ? out : undefined;
}

function summarizeResourceCounts(diff: RoutesDiff | SiteDiff): DeploySummaryResourceCounts {
  const added = diff.totals?.added ?? diff.added.length;
  const changed = diff.totals?.changed ?? diff.changed.length;
  const removed = diff.totals?.removed ?? diff.removed.length;
  return { added, changed, removed };
}

function isStaticAssetsDiff(value: unknown): value is StaticAssetsDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as StaticAssetsDiff;
  return (
    typeof obj.unchanged === "number" &&
    typeof obj.changed === "number" &&
    typeof obj.added === "number" &&
    typeof obj.removed === "number" &&
    typeof obj.newly_uploaded_cas_bytes === "number" &&
    typeof obj.reused_cas_bytes === "number" &&
    typeof obj.deployment_copy_bytes_eliminated === "number"
  );
}

function isModernSiteDiff(value: unknown): value is SiteDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as SiteDiff;
  return (
    Array.isArray(obj.added) &&
    Array.isArray(obj.changed) &&
    Array.isArray(obj.removed)
  );
}

function isModernFunctionsDiff(value: unknown): value is FunctionsDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as FunctionsDiff;
  return (
    Array.isArray(obj.added) &&
    Array.isArray(obj.removed) &&
    Array.isArray(obj.changed)
  );
}

function isModernPlanMigrationDiff(value: unknown): value is PlanMigrationDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as PlanMigrationDiff;
  return Array.isArray(obj.new) && Array.isArray(obj.noop);
}

function isModernRoutesDiff(value: unknown): value is RoutesDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as RoutesDiff;
  return Array.isArray(obj.added) && Array.isArray(obj.changed) && Array.isArray(obj.removed);
}

function isModernSecretsDiff(value: unknown): value is SecretsDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as SecretsDiff;
  return Array.isArray(obj.added) && Array.isArray(obj.removed);
}

function isModernSubdomainsDiff(value: unknown): value is SubdomainsDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as SubdomainsDiff;
  return Array.isArray(obj.added) && Array.isArray(obj.removed);
}

function buildDeploySummaryHeadline(summary: DeploySummary): string {
  const parts: string[] = [];
  const paths = summary.site?.paths;
  if (paths) {
    parts.push(
      paths.total_changed === 0
        ? "no static path changes"
        : `${formatCount(paths.total_changed, "static path")} changed`,
    );
  }

  const cas = summary.site?.cas;
  if (cas) {
    parts.push(
      `${formatBytes(cas.newly_uploaded_bytes)} uploaded, ${formatBytes(cas.reused_bytes)} reused`,
    );
  }

  const functions = summary.functions;
  if (functions) {
    const count =
      functions.added.length + functions.removed.length + functions.changed.length;
    parts.push(
      count === 0
        ? "no functions changed"
        : `${formatCount(count, "function")} changed`,
    );
  }

  const migrations = summary.migrations;
  if (migrations && migrations.new.length > 0) {
    parts.push(`${formatCount(migrations.new.length, "migration")} new`);
  }

  const routes = summary.routes;
  if (routes) {
    const count = routes.added + routes.changed + routes.removed;
    if (count > 0) parts.push(`${formatCount(count, "route")} changed`);
  }

  if (parts.length > 0) return parts.join("; ");
  if (summary.is_noop === true) return "no deploy changes reported";
  return "deploy summary unavailable";
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return `${bytes} B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (Math.abs(value) >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${bytes} B`;
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function normalizeDeployResolveMethod(
  method: DeployResolveMethod | undefined,
): string | undefined {
  if (method === undefined) return undefined;
  if (typeof method !== "string") {
    throw new TypeError("Deploy resolve method must be a string.");
  }
  const normalized = method.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/.test(normalized)) {
    throw new TypeError(
      "Deploy resolve method must be a valid HTTP token such as GET, HEAD, POST, or OPTIONS.",
    );
  }
  return normalized;
}

function displayResolveUrl(request: NormalizedDeployResolveRequest): string {
  if (!request.original_url) return `https://${request.host}${request.path}`;
  try {
    const url = new URL(request.original_url);
    return `${url.protocol}//${url.host}${url.pathname || "/"}`;
  } catch {
    return `${request.host}${request.path}`;
  }
}

function deployResolveWarningsForRequest(
  request: NormalizedDeployResolveRequest,
): DeployResolveWarning[] {
  const warnings: DeployResolveWarning[] = [];
  if (request.ignored?.query) {
    warnings.push({
      code: "query_ignored",
      message: "Query strings do not affect Run402 route resolution.",
    });
  }
  if (request.ignored?.fragment) {
    warnings.push({
      code: "fragment_ignored",
      message: "URL fragments are never sent to the server and do not affect resolution.",
    });
  }
  return warnings;
}

function deployResolveCategory(response: DeployResolveResponse): string {
  if (isDeployResolveCasFailure(response)) return "cas";
  if (response.match === "route_method_miss") return "route_method";
  if (response.match === "active_release_missing") return "release";
  if (response.match === "unsupported_manifest_version") return "manifest";
  if (isDeployResolveRouteHit(response)) return "route";
  if (response.match === "route_function" || response.match === "route_static_alias") {
    return "route";
  }
  if (isDeployResolveStaticHit(response)) return "static";
  if (response.match === "host_missing") return "host";
  if (response.match === "manifest_missing") return "manifest";
  if (response.match === "path_error") return "path";
  if (response.match === "spa_fallback_missing") return "fallback";
  if (response.match === "none") return "miss";
  return "unknown";
}

function deployResolveSummaryText(
  response: DeployResolveResponse,
  url: string,
): string {
  if (isDeployResolveCasFailure(response)) {
    const sha = response.cas_object?.sha256;
    const suffix = sha ? ` for CAS object ${sha}` : "";
    switch (response.authorization_result) {
      case "missing_cas_object":
        return `${url} matched static content, but the backing CAS object is missing${suffix}.`;
      case "unfinalized_or_deleting_cas_object":
        return `${url} matched static content, but the backing CAS object is not finalized or is being deleted${suffix}.`;
      case "size_mismatch":
        return `${url} matched static content, but the backing CAS object size does not match the release manifest${suffix}.`;
      case "unauthorized_cas_object":
        return `${url} matched static content, but the selected credentials are not authorized to inspect the backing CAS object${suffix}.`;
      default:
        return `${url} matched static content, but CAS object health prevented a servable diagnostic${suffix}.`;
    }
  }
  if (response.match === "host_missing") {
    return `${url} did not resolve because the host is not bound to this account/project context.`;
  }
  if (response.match === "manifest_missing") {
    return `${url} reached the host, but no active static manifest is available for diagnostics.`;
  }
  if (response.match === "active_release_missing") {
    return `${url} reached the host, but no active release is available for diagnostics.`;
  }
  if (
    response.match === "unsupported_manifest_version" ||
    response.authorization_result === "unsupported_manifest_version"
  ) {
    return `${url} reached the host, but the active static manifest version is not supported by the gateway.`;
  }
  if (response.match === "path_error") {
    return `${url} could not be evaluated because the path is not a valid Run402 public path.`;
  }
  if (response.match === "route_method_miss") {
    const allowed = formatAllowedMethods(response.allow);
    return allowed
      ? `${url} matched a deploy route pattern, but the method is not allowed. Allowed methods: ${allowed}.`
      : `${url} matched a deploy route pattern, but the method is not allowed.`;
  }
  if (response.match === "none") {
    return `${url} did not match a materialized static file or SPA fallback.`;
  }
  if (response.match === "spa_fallback_missing") {
    return `${url} was eligible for SPA fallback, but the configured fallback file is missing.`;
  }
  if (response.match === "spa_fallback") {
    return `${url} would serve the configured SPA fallback.`;
  }
  if (response.match === "static_index") {
    return `${url} would serve a static index file.`;
  }
  if (response.match === "static_exact") {
    return `${url} would serve an exact static file.`;
  }
  if (response.match === "route_function") {
    return `${url} matched a deploy function route.`;
  }
  if (response.match === "route_static_alias") {
    return `${url} matched a deploy static route alias.`;
  }
  if (isDeployResolveRouteHit(response)) {
    return `${url} matched a deploy route.`;
  }
  if (response.result >= 200 && response.result < 400) {
    return `${url} resolved with gateway match ${String(response.match)}.`;
  }
  return `${url} did not resolve to a servable public response; gateway match was ${String(response.match)}.`;
}

function deployResolveNextSteps(
  response: DeployResolveResponse,
): DeployResolveNextStep[] {
  if (isDeployResolveCasFailure(response)) {
    switch (response.authorization_result) {
      case "unauthorized_cas_object":
        return [
          {
            code: "check_credentials",
            message: "Check that the selected project credentials can inspect the backing static asset CAS object.",
          },
          {
            code: "inspect_release_asset",
            message: "Inspect the active release asset path and redeploy the affected static asset if the CAS authorization is unexpected.",
          },
        ];
      case "missing_cas_object":
        return [
          {
            code: "redeploy_static_asset",
            message: "Redeploy the affected static asset so the backing CAS object is uploaded and finalized.",
          },
          {
            code: "inspect_release_asset",
            message: "Inspect the active release asset path and CAS SHA in the full resolution payload.",
          },
        ];
      case "unfinalized_or_deleting_cas_object":
        return [
          {
            code: "retry_after_cas_finalization",
            message: "Retry diagnostics after the backing CAS object has finalized, or redeploy the affected static asset.",
          },
          {
            code: "inspect_release_asset",
            message: "Inspect the active release asset path and CAS SHA in the full resolution payload.",
          },
        ];
      case "size_mismatch":
        return [
          {
            code: "redeploy_static_asset",
            message: "Redeploy the affected static asset so release metadata and CAS object size agree.",
          },
          {
            code: "inspect_cas_object",
            message: "Compare cas_object.expected_size and cas_object.actual_size in the full resolution payload.",
          },
        ];
      default:
        return [
          {
            code: "inspect_cas_object",
            message: "Inspect authorization_result and cas_object in the full resolution payload.",
          },
          {
            code: "redeploy_static_asset",
            message: "Redeploy the affected static asset if the CAS health failure persists.",
          },
        ];
    }
  }

  switch (response.match) {
    case "host_missing":
      return [
        {
          code: "check_domain_binding",
          message: "Check that the host is configured as a Run402 custom domain or subdomain.",
        },
        {
          code: "check_dns",
          message: "Check DNS and domain binding status.",
        },
        {
          code: "check_credentials",
          message: "Check that the selected local project credentials can inspect this host.",
        },
      ];
    case "manifest_missing":
      return [
        {
          code: "check_active_release",
          message: "Check that the project has an active deploy-v2 release.",
        },
        {
          code: "redeploy_static_site",
          message: "Deploy static site content again if the active release predates static manifest metadata.",
        },
      ];
    case "active_release_missing":
      return [
        {
          code: "check_active_release",
          message: "Check that the project has an active deploy-v2 release.",
        },
        {
          code: "deploy_release",
          message: "Deploy site content or routes before diagnosing this public URL.",
        },
      ];
    case "unsupported_manifest_version":
      return [
        {
          code: "redeploy_static_site",
          message: "Redeploy static site content so the active release has a current static manifest.",
        },
        {
          code: "inspect_release",
          message: "Inspect the active release static_manifest_sha256 and retry diagnostics after redeploy.",
        },
      ];
    case "path_error":
      return [
        {
          code: "check_public_path",
          message: "Use an absolute URL path that starts with '/' and does not contain invalid encoded segments.",
        },
      ];
    case "none":
      return [
        {
          code: "check_static_path",
          message: "Check active release static_public_paths for browser reachability and site.paths for backing release assets.",
        },
        {
          code: "check_spa_fallback",
          message: "Check whether the release has a configured SPA fallback.",
        },
      ];
    case "spa_fallback_missing":
      return [
        {
          code: "restore_spa_fallback",
          message: "Deploy the configured SPA fallback file or remove the fallback declaration.",
        },
      ];
    case "route_method_miss": {
      const allowed = formatAllowedMethods(response.allow);
      return [
        {
          code: "check_route_methods",
          message: allowed
            ? `Retry with one of the allowed methods (${allowed}) or update the route method list.`
            : "Inspect the route method list and retry with an allowed method or update the route.",
        },
        {
          code: "inspect_route",
          message: "Inspect route_pattern, target_type, target_name, and target_file in the full resolution payload.",
        },
      ];
    }
    default:
      return response.result >= 200 && response.result < 400
        ? []
        : [
            {
              code: "inspect_resolution",
              message: "Inspect the full resolution payload for gateway-specific fields.",
            },
          ];
  }
}

function isDeployResolveAuthorizationPassing(
  response: DeployResolveResponse,
): boolean {
  const result = response.authorization_result;
  return result === undefined || result === null || result === "authorized" || result === "not_applicable";
}

function isDeployResolveCasFailure(response: DeployResolveResponse): boolean {
  switch (response.authorization_result) {
    case "missing_cas_object":
    case "unfinalized_or_deleting_cas_object":
    case "size_mismatch":
    case "unauthorized_cas_object":
      return true;
  }
  const cas = response.cas_object;
  if (!cas) return false;
  if (cas.exists === false) return true;
  return typeof cas.actual_size === "number" && cas.actual_size !== cas.expected_size;
}

function formatAllowedMethods(methods: RouteHttpMethod[] | string[] | null | undefined): string {
  if (!methods || methods.length === 0) return "";
  return methods.join(", ");
}

// ─── Plan + commit + operation ───────────────────────────────────────────────

export interface PlanResponse {
  /** Present on the v2 plan envelope. Older gateways omitted it; the SDK
   *  preserves backward compatibility and still normalizes both shapes. */
  kind?: "plan_response";
  schema_version?: "agent-deploy-observability.v1";
  /** Null only for `deploy.plan(..., { dryRun: true })`. */
  plan_id: string | null;
  /** Null only for `deploy.plan(..., { dryRun: true })`. */
  operation_id: string | null;
  base_release_id: string | null;
  manifest_digest: string;
  is_noop?: boolean;
  summary?: string;
  expected_events?: string[];
  /** Per-ref presence list. The gateway reports which content SHAs the
   *  project already has and which need to be uploaded. Items with
   *  `present: false` must be uploaded via `POST /content/v1/plans` before
   *  the deploy commit will succeed. */
  missing_content: PlanContentRef[];
  /** SDK-normalized diff convenience. New gateways return these buckets at
   *  top level; `normalizePlanResponse` folds them back into `diff` so older
   *  callers and event consumers keep working. */
  diff: DeployDiff;
  warnings: WarningEntry[];
  payment_required?: PaymentRequiredHint | null;
  migrations?: PlanMigrationDiff;
  site?: SiteDiff;
  functions?: FunctionsDiff;
  secrets?: SecretsDiff;
  subdomains?: SubdomainsDiff;
  routes?: RoutesDiff;
  static_assets?: StaticAssetsDiff;
}

export type WarningEntry = LegacyWarningEntry | DeployObservabilityWarningEntry;

export interface LegacyWarningEntry {
  code: string;
  severity: "low" | "medium" | "high";
  requires_confirmation: boolean;
  message: string;
  affected?: string[];
  details?: Record<string, unknown>;
  confidence?: "low" | "medium" | "high";
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

// ─── Release inventory + diff observability ─────────────────────────────────

export type ReleaseInventoryStatus =
  | "active"
  | "superseded"
  | "failed"
  | "staged";

export type ReleaseInventoryStateKind =
  | "current_live"
  | "effective"
  | "desired_manifest";

export interface SitePathEntry {
  path: string;
  content_sha256: string;
  content_type: string;
}

export interface ReleaseFunctionEntry {
  name: string;
  code_hash: string;
  runtime: string;
  timeout_seconds: number;
  memory_mb: number;
  schedule: string | null;
}

export interface MigrationAppliedEntry {
  migration_id: string;
  checksum_hex: string;
  applied_at: string;
}

export interface RouteEntry {
  pattern: string;
  kind: "exact" | "prefix";
  prefix: string | null;
  /** Null means all supported route HTTP methods. */
  methods: RouteHttpMethod[] | null;
  target: RouteTarget;
}

export interface MaterializedRoutes {
  manifest_sha256: string | null;
  entries: RouteEntry[];
}

export interface RouteChangeEntry {
  pattern: string;
  before: RouteEntry;
  after: RouteEntry;
  fields_changed: Array<"methods" | "target" | "kind" | "prefix">;
}

export type KnownStaticReachabilityAuthority =
  | "implicit_file_path"
  | "explicit_public_path"
  | "route_static_alias";

export type StaticReachabilityAuthority =
  LiteralUnion<KnownStaticReachabilityAuthority>;

export interface StaticPublicPathInventoryEntry {
  public_path: string;
  asset_path: string;
  reachability_authority: StaticReachabilityAuthority;
  direct: boolean;
  cache_class: StaticCacheClass;
  content_type: string;
  route_id?: string | null;
  methods?: RouteHttpMethod[] | string[] | null;
  [key: string]: unknown;
}

export interface RoutesDiff {
  manifest_sha256_old?: string | null;
  manifest_sha256_new?: string | null;
  added: RouteEntry[];
  removed: RouteEntry[];
  changed: RouteChangeEntry[];
  totals?: { added: number; removed: number; changed: number };
}

export interface ReleaseInventoryBase<
  StateKind extends ReleaseInventoryStateKind = ReleaseInventoryStateKind,
> {
  kind: "release_inventory";
  schema_version: "agent-deploy-observability.v1";
  release_id: string | null;
  project_id: string;
  parent_id: string | null;
  status: ReleaseInventoryStatus | null;
  manifest_digest: string | null;
  created_at: string | null;
  created_by: string | null;
  activated_at: string | null;
  superseded_at: string | null;
  operation_id: string | null;
  plan_id: string | null;
  events_url: string | null;
  effective: boolean;
  state_kind: StateKind;
  release_generation: number | null;
  static_manifest_sha256: string | null;
  static_manifest_metadata: StaticManifestMetadata | null;
  site: {
    paths: SitePathEntry[];
    totals?: { paths: number };
  };
  static_public_paths?: StaticPublicPathInventoryEntry[];
  functions: ReleaseFunctionEntry[];
  secrets: { keys: string[] };
  subdomains: { names: string[] };
  routes: MaterializedRoutes;
  migrations_applied: MigrationAppliedEntry[];
  warnings?: DeployObservabilityWarningEntry[];
}

/** Inventory built from the currently live project state. */
export type ActiveReleaseInventory = ReleaseInventoryBase<"current_live">;

/** Inventory for a specific release id. Superseded/active releases are
 *  materialized effective state; staged/failed releases are desired manifests. */
export type ReleaseSnapshotInventory = ReleaseInventoryBase<
  "effective" | "desired_manifest"
>;

export type ReleaseInventory = ActiveReleaseInventory | ReleaseSnapshotInventory;

export interface DeployObservabilityWarningEntry {
  code: string;
  severity: "info" | "warn" | "high";
  requires_confirmation: boolean;
  message: string;
  affected?: string[];
  details?: Record<string, unknown>;
  confidence?: "heuristic";
}

export interface PlanMigrationDiff {
  new: Array<{
    id: string;
    checksum_hex: string;
    transaction: "default" | "none";
  }>;
  noop: Array<{
    id: string;
    checksum_hex: string;
  }>;
}

export interface SiteDiff {
  added: Array<{
    path: string;
    sha256: string;
    content_type: string;
  }>;
  removed: string[];
  changed: Array<{
    path: string;
    sha256_old: string;
    sha256_new: string;
    content_type_old: string;
    content_type_new: string;
    content_type_inferred?: true;
  }>;
  totals?: { added: number; removed: number; changed: number };
}

export interface FunctionsDiff {
  added: string[];
  removed: string[];
  changed: Array<{
    name: string;
    fields_changed: Array<
      | "code_hash"
      | "runtime"
      | "timeout_seconds"
      | "memory_mb"
      | "schedule"
    >;
  }>;
}

/** Secrets have no `changed` bucket; values and value-derived signals are
 *  intentionally absent from deploy observability responses. */
export interface SecretsDiff {
  added: string[];
  removed: string[];
}

/** Subdomains have no `changed` bucket. */
export interface SubdomainsDiff {
  added: string[];
  removed: string[];
}

export interface PlanDiffEnvelope {
  is_noop: boolean;
  summary: string;
  warnings: WarningEntry[];
  migrations: PlanMigrationDiff;
  site: SiteDiff;
  functions: FunctionsDiff;
  secrets: SecretsDiff;
  subdomains: SubdomainsDiff;
  routes: RoutesDiff;
  static_assets: StaticAssetsDiff;
}

export interface ReleaseToReleaseDiff {
  kind: "release_diff";
  schema_version: "agent-deploy-observability.v1";
  from_release_id: string | null;
  to_release_id: string | null;
  is_noop: boolean;
  summary: string;
  warnings: WarningEntry[];
  migrations: {
    applied_between_releases: string[];
  };
  site: SiteDiff;
  functions: FunctionsDiff;
  secrets: SecretsDiff;
  subdomains: SubdomainsDiff;
  routes: RoutesDiff;
  static_assets: StaticAssetsDiff;
}

export type ReleaseDiffTarget = "empty" | "active" | (string & {});
export type ReleaseDiffToTarget = "active" | (string & {});

export interface ReleaseInventoryOptions {
  project: string;
  /** Maximum number of site path entries to include. Gateway default: 5,000;
   *  gateway hard maximum: 25,000. */
  siteLimit?: number;
}

export interface ReleaseInventoryByIdOptions extends ReleaseInventoryOptions {
  releaseId: string;
}

export interface ReleaseDiffOptions {
  project: string;
  from: ReleaseDiffTarget;
  to: ReleaseDiffToTarget;
  /** Maximum number of entries in each site diff bucket. Gateway default:
   *  1,000. */
  limit?: number;
}

/** Server-side summary of the diff between the base release and the new
 *  spec. v1.39+ plans may return the structured `PlanDiffEnvelope`; older
 *  gateways may still return legacy buckets. Migrations mismatch is a hard
 *  deploy error in the modern success path, but the legacy array is kept here
 *  for flag-off/backward compatibility. */
export interface DeployDiff {
  resources?: Record<string, unknown>;
  is_noop?: boolean;
  summary?: string;
  warnings?: WarningEntry[];
  migrations?:
    | PlanMigrationDiff
    | Array<{
        id: string;
        state: "new" | "noop" | "checksum_mismatch";
      }>;
  site?: SiteDiff;
  functions?: FunctionsDiff;
  secrets?: SecretsDiff;
  routes?: RoutesDiff | Array<{ kind: "added" | "removed"; path: string }>;
  static_assets?: StaticAssetsDiff;
  subdomains?:
    | SubdomainsDiff
    | Array<{ kind: "added" | "removed"; subdomain: string }>;
  [key: string]: unknown;
}

export interface DeploySummarySitePaths {
  added: number;
  changed: number;
  removed: number;
  unchanged?: number;
  total_changed: number;
}

export interface DeploySummarySiteCas {
  newly_uploaded_bytes: number;
  reused_bytes: number;
  deployment_copy_bytes_eliminated: number;
}

export interface DeploySummarySite {
  paths?: DeploySummarySitePaths;
  cas?: DeploySummarySiteCas;
}

export interface DeploySummaryFunctions {
  added: string[];
  removed: string[];
  changed: Array<{
    name: string;
    fields_changed: Array<FunctionsDiff["changed"][number]["fields_changed"][number]>;
  }>;
}

export interface DeploySummaryMigrations {
  new: string[];
  noop: string[];
}

export interface DeploySummaryResourceCounts {
  added: number;
  changed: number;
  removed: number;
}

export interface DeploySummaryKeyCounts {
  added: number;
  removed: number;
}

export interface DeploySummaryWarnings {
  count: number;
  blocking: number;
  codes: string[];
}

export interface DeploySummary {
  schema_version: "deploy-summary.v1";
  release_id: string;
  operation_id: string;
  is_noop?: boolean;
  headline: string;
  site?: DeploySummarySite;
  functions?: DeploySummaryFunctions;
  migrations?: DeploySummaryMigrations;
  routes?: DeploySummaryResourceCounts;
  secrets?: DeploySummaryKeyCounts;
  subdomains?: DeploySummaryKeyCounts;
  warnings: DeploySummaryWarnings;
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
export interface DeployListOptions {
  project: string;
  limit?: number;
  cursor?: string;
}

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
  category?: string;
  retryable?: boolean;
  safe_to_retry?: boolean;
  mutation_state?: string;
  trace_id?: string;
  details?: Record<string, unknown> | null;
  next_actions?: unknown[];
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
  routes?: ReleaseRoutesSpec;
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
  | { replace: Record<string, ContentRef>; patch?: never; public_paths?: SitePublicPathsSpec }
  | { patch: { put?: Record<string, ContentRef>; delete?: string[] }; replace?: never; public_paths?: SitePublicPathsSpec }
  | { public_paths: SitePublicPathsSpec; replace?: never; patch?: never };

// ─── Events + result ─────────────────────────────────────────────────────────

export type DeployEvent =
  | { type: "plan.started" }
  | { type: "plan.diff"; diff: DeployDiff }
  | { type: "plan.warnings"; warnings: WarningEntry[] }
  | {
      type: "payment.required";
      amount: string;
      asset: string;
      payTo: string;
      reason: string;
    }
  | { type: "payment.paid"; tx?: string }
  | {
      type: "deploy.retry";
      attempt: number;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
      code: string;
      phase: string | null;
      resource: string | null;
      operationId: string | null;
      planId: string | null;
      message: string;
    }
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
  /** Structured plan warnings that were observed before commit. */
  warnings: WarningEntry[];
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
  /** Continue past plan warnings that require confirmation. Default false:
   *  `apply()` aborts before upload/commit so agents can set missing secrets,
   *  inspect warnings, or use the low-level plan/upload/commit flow. */
  allowWarnings?: boolean;
  /** Continue past specific confirmation-required warning codes. Every
   *  blocking warning must be covered by this list or by `allowWarnings`. */
  allowWarningCodes?: string[];
  /** Automatic safe-race retries after the initial `apply()` attempt.
   *  Default: 2 retries (3 total attempts). Pass 0 to disable automatic
   *  retry and surface the first safe deploy race to the caller. */
  maxRetries?: number;
}

export interface StartOptions {
  idempotencyKey?: string;
  /** Receives progress events for plan diff, content uploads, commit phases,
   *  warnings, payment requirements, and final release activation. Callback
   *  exceptions are swallowed so UI/logging hooks cannot fail the deploy. */
  onEvent?: (event: DeployEvent) => void;
  /** By default, warnings with `requires_confirmation` stop before
   *  upload/commit. Set true only after inspecting the warnings. */
  allowWarnings?: boolean;
  /** Continue past specific confirmation-required warning codes. */
  allowWarningCodes?: string[];
}

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
