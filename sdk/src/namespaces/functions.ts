/**
 * `functions` namespace — serverless function lifecycle.
 *
 * Covers deploy/invoke/logs/list/delete/update against
 * `/projects/v1/admin/:id/functions*` and `/functions/v1/:name`.
 */

import type { Client } from "../kernel.js";
import { LocalError, ProjectNotFound } from "../errors.js";
import type {
  DeleteFunctionResult,
  FunctionDeployOptions,
  FunctionDeployResult,
  FunctionInvokeOptions,
  FunctionInvokeResult,
  FunctionListResult,
  FunctionLogsOptions,
  FunctionLogsResult,
  FunctionUpdateOptions,
  FunctionUpdateResult,
} from "./functions.types.js";

const FUNCTION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const FUNCTION_LOG_REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{4,128}$/;
const FUNCTION_LOG_TAIL_MAX = 1000;
const FUNCTION_DEP_MAX = 30;
const FUNCTION_DEP_SPEC_MAX = 200;
const DISALLOWED_FUNCTION_DEPS = new Set([
  "@run402/functions",
  "run402-functions",
  "sharp",
  "canvas",
  "bcrypt",
]);

export class Functions {
  constructor(private readonly client: Client) {}

  /**
   * Deploy a serverless function. Deployed functions can
   * `import { db, adminDb, getUser, email, ai } from "@run402/functions"` —
   * the in-function helper library is auto-bundled by the platform at the
   * version recorded in {@link FunctionDeployResult.runtime_version}.
   *
   * `opts.deps` lists additional npm packages to install and bundle. Bare
   * names resolve to the latest published version at deploy time; pinned
   * or range specs (`"lodash@4.17.21"`, `"date-fns@^3.0.0"`) are honored
   * verbatim. The actually-installed concrete versions are returned in
   * {@link FunctionDeployResult.deps_resolved}. `@run402/functions` and
   * the deprecated `run402-functions` are rejected.
   *
   * Non-fatal deploy issues (bundle size warnings, esbuild advisories)
   * surface in {@link FunctionDeployResult.warnings}.
   *
   * @throws {PaymentRequired} when the project lease has expired.
   */
  async deploy(projectId: string, opts: FunctionDeployOptions): Promise<FunctionDeployResult> {
    validateFunctionName(opts.name, "name", "deploying function");
    validateFunctionCode(opts.code, "code", "deploying function");
    validateFunctionConfig(opts.config, "config", "deploying function");
    validateFunctionDeps(opts.deps, "deps", "deploying function");
    validateFunctionSchedule(opts.schedule, "schedule", "deploying function");

    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deploying function");

    const body: Record<string, unknown> = {
      name: opts.name,
      code: opts.code,
    };
    if (opts.config !== undefined) body.config = opts.config;
    if (opts.deps !== undefined) body.deps = opts.deps;
    if (opts.schedule !== undefined) body.schedule = opts.schedule;

    return this.client.request<FunctionDeployResult>(
      `/projects/v1/admin/${projectId}/functions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body,
        context: "deploying function",
      },
    );
  }

  /**
   * Invoke a deployed function via HTTP. Uses the project's service key as
   * the API key. The returned `body` is parsed JSON when the response was
   * JSON, otherwise the raw text.
   */
  async invoke(
    projectId: string,
    name: string,
    opts: FunctionInvokeOptions = {},
  ): Promise<FunctionInvokeResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "invoking function");

    const method = opts.method ?? "POST";
    const headers: Record<string, string> = {
      apikey: project.service_key,
      ...(opts.headers ?? {}),
    };

    const requestOpts: Parameters<Client["request"]>[1] = {
      method,
      headers,
      context: "invoking function",
    };
    if (method !== "GET" && method !== "HEAD" && opts.body !== undefined) {
      if (typeof opts.body === "string") {
        requestOpts.rawBody = opts.body;
      } else {
        requestOpts.body = opts.body;
      }
    }

    const start = Date.now();
    const body = await this.client.request<unknown>(`/functions/v1/${name}`, requestOpts);
    return {
      status: 200,
      body,
      duration_ms: Date.now() - start,
    };
  }

  /**
   * Get recent logs for a function. Default tail 50; `since` accepts an ISO
   * 8601 timestamp or epoch milliseconds for incremental polling. Pass
   * `requestId` to retrieve logs correlated to a routed request failure.
   */
  async logs(
    projectId: string,
    name: string,
    opts: FunctionLogsOptions = {},
  ): Promise<FunctionLogsResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "fetching function logs");

    const tail = opts.tail ?? 50;
    validatePositiveJsonInteger(tail, "tail", "fetching function logs", { max: FUNCTION_LOG_TAIL_MAX });
    const search = new URLSearchParams({ tail: String(tail) });
    if (opts.since !== undefined) {
      search.set("since", String(parseLogSince(opts.since)));
    }
    if (opts.requestId !== undefined) {
      validateFunctionLogRequestId(opts.requestId, "requestId", "fetching function logs");
      search.set("request_id", opts.requestId);
    }
    const path = `/projects/v1/admin/${projectId}/functions/${encodeURIComponent(name)}/logs?${search.toString()}`;

    return this.client.request<FunctionLogsResult>(path, {
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "fetching function logs",
    });
  }

  /** List deployed functions for a project. */
  async list(projectId: string): Promise<FunctionListResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing functions");

    return this.client.request<FunctionListResult>(
      `/projects/v1/admin/${projectId}/functions`,
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "listing functions",
      },
    );
  }

  /** Delete a deployed function. */
  async delete(projectId: string, name: string): Promise<DeleteFunctionResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deleting function");

    return this.client.request<DeleteFunctionResult>(
      `/projects/v1/admin/${projectId}/functions/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "deleting function",
      },
    );
  }

  /**
   * Update a function's schedule / timeout / memory without re-deploying.
   * Pass `schedule: null` to remove an existing schedule; `undefined`
   * leaves it unchanged.
   */
  async update(
    projectId: string,
    name: string,
    opts: FunctionUpdateOptions,
  ): Promise<FunctionUpdateResult> {
    validatePositiveJsonInteger(opts.timeout, "timeout", "updating function");
    validatePositiveJsonInteger(opts.memory, "memory", "updating function");
    validateFunctionSchedule(opts.schedule, "schedule", "updating function");

    if (opts.schedule === undefined && opts.timeout === undefined && opts.memory === undefined) {
      throw new LocalError(
        "Provide at least one supported update field: schedule, timeout, or memory",
        "updating function",
      );
    }

    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "updating function");

    const body: Record<string, unknown> = {};
    if (opts.schedule !== undefined) body.schedule = opts.schedule;
    if (opts.timeout !== undefined || opts.memory !== undefined) {
      const config: Record<string, number> = {};
      if (opts.timeout !== undefined) config.timeout = opts.timeout;
      if (opts.memory !== undefined) config.memory = opts.memory;
      body.config = config;
    }

    return this.client.request<FunctionUpdateResult>(
      `/projects/v1/admin/${projectId}/functions/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body,
        context: "updating function",
      },
    );
  }
}

function parseLogSince(since: string): number {
  const raw = since.trim();
  const numeric = raw === "" ? Number.NaN : Number(raw);
  const ms = Number.isFinite(numeric) ? numeric : new Date(since).getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new LocalError(
      `Invalid functions.logs since timestamp: ${since}`,
      "fetching function logs",
    );
  }
  return ms;
}

function validateFunctionConfig(config: unknown, resource: string, context: string): void {
  if (config === undefined) return;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new LocalError(`${resource} must be an object`, context);
  }
  const record = config as Record<string, unknown>;
  validatePositiveJsonInteger(record.timeout, `${resource}.timeout`, context);
  validatePositiveJsonInteger(record.memory, `${resource}.memory`, context);
}

function validateFunctionName(value: unknown, resource: string, context: string): void {
  if (typeof value !== "string" || !FUNCTION_NAME_RE.test(value)) {
    throw new LocalError(
      `${resource} must be a lowercase URL-safe function name (1-128 chars, starts with a letter or digit)`,
      context,
    );
  }
}

function validateFunctionCode(value: unknown, resource: string, context: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LocalError(`${resource} must be a non-empty source string`, context);
  }
}

function validateFunctionDeps(value: unknown, resource: string, context: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new LocalError(`${resource} must be an array of npm package specs`, context);
  }
  if (value.length > FUNCTION_DEP_MAX) {
    throw new LocalError(`${resource} must contain at most ${FUNCTION_DEP_MAX} entries`, context);
  }
  for (const [index, dep] of value.entries()) {
    const entry = `${resource}[${index}]`;
    if (typeof dep !== "string" || dep.trim() === "") {
      throw new LocalError(`${entry} must be a non-empty npm package spec`, context);
    }
    if (dep !== dep.trim()) {
      throw new LocalError(`${entry} must not contain leading or trailing whitespace`, context);
    }
    if (dep.length > FUNCTION_DEP_SPEC_MAX) {
      throw new LocalError(`${entry} must be ${FUNCTION_DEP_SPEC_MAX} characters or fewer`, context);
    }
    if (/\s/.test(dep)) {
      throw new LocalError(`${entry} must not contain whitespace`, context);
    }
    const packageName = depPackageName(dep);
    if (DISALLOWED_FUNCTION_DEPS.has(packageName)) {
      throw new LocalError(`${entry} references unsupported dependency ${packageName}`, context);
    }
  }
}

function depPackageName(spec: string): string {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash === -1) return spec;
    const versionAt = spec.indexOf("@", slash);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.indexOf("@");
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

function validateFunctionSchedule(value: unknown, resource: string, context: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new LocalError(`${resource} must be a 5-field cron string, null, or undefined`, context);
  }
  const parts = value.trim().split(/\s+/);
  if (value.trim() === "" || parts.length !== 5 || parts.some((part) => part === "")) {
    throw new LocalError(`${resource} must be a 5-field cron string`, context);
  }
}

function validateFunctionLogRequestId(value: unknown, resource: string, context: string): void {
  if (typeof value !== "string" || !FUNCTION_LOG_REQUEST_ID_RE.test(value)) {
    throw new LocalError(`${resource} must match req_<4-128 url-safe chars>`, context);
  }
}

function validatePositiveJsonInteger(
  value: unknown,
  resource: string,
  context: string,
  opts: { max?: number } = {},
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new LocalError(`${resource} must be a positive safe JSON integer`, context);
  }
  if (opts.max !== undefined && (value as number) > opts.max) {
    throw new LocalError(`${resource} must be <= ${opts.max}`, context);
  }
}
