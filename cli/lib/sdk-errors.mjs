/**
 * CLI-side SDK error translator.
 *
 * Maps SDK `Run402Error` subclasses into the CLI's canonical error envelope:
 * `{status: "error", code, message, retryable, safe_to_retry, ...}` on stderr,
 * `process.exit(1)`. Preserves specific behaviors:
 *   - `ProjectNotFound` → canonical envelope with `code: "PROJECT_NOT_FOUND"`
 *     and `details.source: "local_registry"` so callers can distinguish the
 *     local-registry miss from a gateway 404.
 *   - HTML / non-JSON error bodies → `body_preview` field (first 500 chars),
 *     matching GH-84 behavior.
 *   - Network errors → `{status: "error", message: "..."}`.
 *
 * For client-side validation failures (missing flags, bad JSON, no-op
 * environments), use `fail()` instead — `reportSdkError` is strictly for
 * thrown `Run402Error` instances.
 */

/**
 * Canonical client-side failure emitter.
 *
 * Writes a single JSON envelope to stderr and exits with `exit_code` (default 1).
 * The envelope shape matches the gateway's structured error contract so callers
 * branching on `code` / `retryable` / `safe_to_retry` work uniformly across
 * client-side validation errors and SDK-thrown errors.
 *
 * `code` defaults to "BAD_USAGE" so the helper is safe to call without one.
 * `retryable: false` and `safe_to_retry: true` are sane defaults for client-side
 * validation: the call wasn't sent, so retrying is safe and won't help unless
 * the user fixes input.
 */
export function fail({ message, code, hint, details, next_actions, field, retryable = false, safe_to_retry = true, exit_code = 1 } = {}) {
  const envelope = {
    status: "error",
    code: code ?? "BAD_USAGE",
    message,
    retryable,
    safe_to_retry,
  };
  if (hint !== undefined) envelope.hint = hint;
  if (details !== undefined) envelope.details = details;
  if (field !== undefined) envelope.field = field;
  envelope.next_actions = Array.isArray(next_actions) ? next_actions : [];
  envelope.trace_id = null;
  console.error(JSON.stringify(envelope));
  process.exit(exit_code);
}

/**
 * Parse a JSON-bearing CLI flag value, naming the flag in the failure envelope.
 *
 * Wraps `JSON.parse` so the failure says which flag was bad and includes a
 * truncated value preview, instead of leaking a raw V8 `JSON.parse` message
 * that doesn't tell the caller which flag failed.
 */
export function parseFlagJson(name, value) {
  try {
    return JSON.parse(value);
  } catch (e) {
    fail({
      code: "BAD_JSON_FLAG",
      message: `${name} value is not valid JSON`,
      details: { flag: name, value_preview: String(value).slice(0, 32), parse_error: e.message },
    });
  }
}

export function reportSdkError(err) {
  if (err?.name === "ProjectNotFound") {
    const id = err.projectId || "";
    const hint = id && !String(id).startsWith("prj_")
      ? `project IDs start with "prj_". Check that the argument order is <project_id> <name>.`
      : undefined;
    fail({
      code: "PROJECT_NOT_FOUND",
      message: `Project ${id} not found in local registry.`,
      hint,
      details: { project_id: id, source: "local_registry" },
    });
  }

  const payload = { status: "error" };

  if (err?.status !== undefined && err?.status !== null) {
    payload.http = err.status;
    if (err.body && typeof err.body === "object") {
      Object.assign(payload, err.body);
      preferMessage(payload);
    } else if (typeof err.body === "string") {
      payload.body_preview = err.body.slice(0, 500);
    }
    mergeStructuredErrorFields(payload, err);
  } else if (err?.body && typeof err.body === "object") {
    Object.assign(payload, err.body);
    preferMessage(payload);
    mergeStructuredErrorFields(payload, err);
  } else {
    payload.message = err?.message || String(err);
    mergeStructuredErrorFields(payload, err);
  }

  // Keep `status: "error"` as the outer envelope even if the response body
  // happened to contain its own `status` field (e.g. `{"status":"degraded"}`
  // from /health 503 responses). Downstream scripts match on this sentinel.
  payload.status = "error";

  console.error(JSON.stringify(payload));
  process.exit(1);
}

function preferMessage(payload) {
  if (typeof payload.message === "string" && payload.message.length > 0) return;
  if (typeof payload.error === "string" && payload.error.length > 0) {
    payload.message = payload.error;
  }
}

function mergeStructuredErrorFields(payload, err) {
  if (!err || typeof err !== "object") return;
  setIfAbsent(payload, "message", err.message);
  setIfAbsent(payload, "code", err.code);
  setIfAbsent(payload, "category", err.category);
  setIfAbsent(payload, "retryable", err.retryable);
  setIfAbsent(payload, "safe_to_retry", err.safeToRetry);
  setIfAbsent(payload, "mutation_state", err.mutationState);
  setIfAbsent(payload, "trace_id", err.traceId);
  setIfAbsent(payload, "details", err.details);
  setIfAbsent(payload, "next_actions", err.nextActions);
  setIfAbsent(payload, "phase", err.phase);
  setIfAbsent(payload, "resource", err.resource);
  setIfAbsent(payload, "operation_id", err.operationId);
  setIfAbsent(payload, "plan_id", err.planId);
  setIfAbsent(payload, "fix", err.fix);
  setIfAbsent(payload, "logs", err.logs);
  setIfAbsent(payload, "rolled_back", err.rolledBack);
}

function setIfAbsent(payload, key, value) {
  if (value === undefined || value === null) return;
  if (payload[key] !== undefined) return;
  payload[key] = value;
}
