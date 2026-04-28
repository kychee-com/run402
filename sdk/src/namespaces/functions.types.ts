/**
 * Request and response types for the `functions` namespace.
 * Maps to `/projects/v1/admin/:id/functions*` and `/functions/v1/:name`.
 */

export interface FunctionConfig {
  /** Timeout in seconds. Tier limits apply. */
  timeout?: number;
  /** Memory in MB. Tier limits apply. */
  memory?: number;
}

export interface FunctionDeployOptions {
  /** Function name — URL-safe slug, used in the invoke path. */
  name: string;
  /** Source code. TypeScript or JavaScript. Must `export default async (req: Request) => Response`. */
  code: string;
  config?: FunctionConfig;
  /**
   * Additional npm packages to bundle with the function. Reserved for a
   * follow-up release that will install user-supplied packages at deploy
   * time. Until then, only `@run402/functions` is available inside
   * deployed functions; this field has no effect.
   */
  deps?: string[];
  /** Cron schedule (5-field). Omit to deploy without a schedule. */
  schedule?: string | null;
}

export interface FunctionDeployResult {
  name: string;
  url: string;
  status: string;
  runtime: string;
  timeout: number;
  memory: number;
  schedule?: string | null;
  created_at: string;
  /**
   * The version of `@run402/functions` bundled into the function at deploy
   * time. Set when the function is deployed under the bundling-at-deploy
   * regime (see the companion `drop-functions-layer-and-fix-deps` change).
   * `null` (or omitted) for functions deployed before that change shipped.
   */
  runtime_version?: string | null;
  /**
   * Resolved direct user dependency versions from `--deps`. Map of dep
   * name → actually-installed concrete version (NOT the user's spec
   * string). `{}` when the function was deployed with empty `--deps` under
   * the new regime; `null` (or omitted) for legacy functions.
   *
   * Direct dependencies only — transitive deps, integrity hashes, and
   * peer-dep relationships are NOT included. This is "resolved direct
   * dependency versions," not a lockfile.
   */
  deps_resolved?: Record<string, string> | null;
}

export interface FunctionInvokeOptions {
  /** HTTP method. Default `POST`. */
  method?: string;
  /** Request body. Sent as JSON when an object, as-is when a string. */
  body?: string | Record<string, unknown>;
  /** Extra headers to forward. */
  headers?: Record<string, string>;
}

export interface FunctionInvokeResult {
  status: number;
  /** Parsed JSON body if the response was JSON, otherwise the raw text. */
  body: unknown;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
}

export interface FunctionLogEntry {
  timestamp: string;
  message: string;
}

export interface FunctionLogsOptions {
  /** Number of log lines. Server clamps to 200. Default 50. */
  tail?: number;
  /** Only return logs at or after this ISO 8601 timestamp. */
  since?: string;
}

export interface FunctionLogsResult {
  logs: FunctionLogEntry[];
}

export interface FunctionScheduleMeta {
  last_run_at?: string;
  last_status?: number;
  next_run_at?: string;
  run_count?: number;
  last_error?: string | null;
}

export interface FunctionSummary {
  name: string;
  url: string;
  runtime: string;
  timeout: number;
  memory: number;
  schedule?: string | null;
  schedule_meta?: FunctionScheduleMeta | null;
  created_at: string;
  updated_at: string;
  /**
   * The version of `@run402/functions` bundled into the function at deploy
   * time. `null` for functions deployed before the bundling-at-deploy
   * regime (see the companion `drop-functions-layer-and-fix-deps` change).
   */
  runtime_version?: string | null;
  /**
   * Resolved direct user dependency versions from `--deps`. Map of dep
   * name → actually-installed concrete version. `{}` for empty-deps
   * deploys under the new regime; `null` for legacy functions.
   * Direct deps only, not a full lockfile.
   */
  deps_resolved?: Record<string, string> | null;
}

export interface FunctionListResult {
  functions: FunctionSummary[];
}

export interface FunctionUpdateOptions {
  /** Pass `null` to remove an existing schedule. `undefined` leaves the schedule unchanged. */
  schedule?: string | null;
  timeout?: number;
  memory?: number;
}

export interface FunctionUpdateResult {
  name: string;
  runtime: string;
  timeout: number;
  memory: number;
  schedule: string | null;
  schedule_meta: Record<string, unknown> | null;
  updated_at: string;
  /** See `FunctionSummary.runtime_version`. */
  runtime_version?: string | null;
  /** See `FunctionSummary.deps_resolved`. */
  deps_resolved?: Record<string, string> | null;
}
