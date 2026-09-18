/** Shared adapter view of a workflow. Detailed SDK results remain unchanged. */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, lstatSync, unlinkSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";

const TTL_MS = 30 * 60 * 1000;
const MAX_FILES = 32;
const MAX_BYTES = 2 * 1024 * 1024;
const PRIVATE_FIELDS = /(?:secret|password|token|authorization|cookie|signature|proof|credential|private.?key|api.?key|service.?key|anon.?key|key$)|^(?:env|headers|body|sql|custom_sql|spec|manifest|value|stdout|stderr|input|message|details)$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Authored payloads and credential-bearing fields never enter the diagnostic copy. */
export function redactWorkflowDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactWorkflowDiagnostics);
  if (!object(value)) return typeof value === "string"
    ? value.replace(/https?:\/\/[^\s"\x27]+/gi, (address) => {
      try { const url = new URL(address); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return "[redacted URL]"; }
    }).replace(/Bearer\s+[^\s"\x27]+/gi, "Bearer [redacted]").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    : value;
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, PRIVATE_FIELDS.test(key) ? "[redacted]" : redactWorkflowDiagnostics(val)]));
}

function diagnosticPath(dir: string, value: unknown): string | null {
  const data = JSON.stringify(redactWorkflowDiagnostics(value), null, 2);
  if (Buffer.byteLength(data) > MAX_BYTES) return null;
  const root = join(resolve(dir), ".run402");
  const folder = join(root, "diagnostics");
  for (const path of [root, folder]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) return null;
    chmodSync(path, 0o700);
  }
  const now = Date.now();
  const files = readdirSync(folder).filter((name) => /^result-[a-f0-9]{32}\.json$/.test(name))
    .map((name) => ({ name, stat: lstatSync(join(folder, name)) }))
    .filter(({ stat }) => stat.isFile()).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  while (files.length && (files.length >= MAX_FILES || now - files[0]!.stat.mtimeMs > TTL_MS)) unlinkSync(join(folder, files.shift()!.name));
  const path = join(folder, `result-${randomBytes(16).toString("hex")}.json`);
  writeFileSync(path, data, { flag: "wx", mode: 0o600 });
  return path;
}

const pick = (value: unknown, keys: string[]): Record<string, unknown> => object(value)
  ? Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]])) : {};
const OUTCOME = ["status", "state", "code", "category", "reason", "message", "error", "mutation_state", "safe_to_retry", "retryable", "warnings", "next_actions", "cost", "costs", "network", "rail", "payment"];
function verification(value: unknown): unknown {
  if (!object(value)) return value;
  const report = object(value.report) ? value.report : value;
  const summary = pick(report, [...OUTCOME, "coherent", "checked_at", "pending_count", "path_count", "total_path_count", "vantage", "strength"]);
  if (Array.isArray(report.paths)) {
    summary.confidence_counts = report.paths.reduce<Record<string, number>>((counts, path) => {
      const key = object(path) && typeof path.observed_confidence === "string" ? path.observed_confidence : "unknown";
      counts[key] = (counts[key] ?? 0) + 1; return counts;
    }, {});
    const pending = report.paths.filter(path => !object(path) || path.state !== "coherent");
    if (pending.length) summary.paths = pending.slice(0, 10).map(path => pick(path, ["path", "state", "status", "observed_confidence"]));
    if (pending.length > 10) summary.paths_truncated = true;
  }
  return { ...summary, ...pick(value, ["attempts", "elapsedMs"]) };
}
function deployment(value: unknown): unknown {
  if (!object(value)) return value;
  const summary = pick(value, [...OUTCOME, "release_id", "operation_id", "release_generation", "urls", "rehearsal"]);
  if (object(value.urls)) summary.urls = pick(value.urls, ["site", "console", "deployment", "deployment_id"]);
  if (object(value.diff)) summary.diff = pick(value.diff, ["is_noop", "summary"]);
  return summary;
}
function repository(value: unknown): unknown {
  if (!object(value)) return value;
  const summary = pick(value, [...OUTCOME, "first_push_error", "gitvault_error", "local_git", "toplevel", "gitvault", "first_push"]);
  if (object(value.gitvault)) summary.gitvault = pick(value.gitvault, [...OUTCOME, "name", "url", "allocated", "created_repository", "already_present", "nested", "enclosing_toplevel", "excluded_in_enclosing"]);
  if (object(value.first_push)) summary.first_push = pick(value.first_push, ["generation", "form", "gitvault_commit", "snapshot", "captured_dirty"]);
  return summary;
}

/** Preserve outcome and recovery fields, and point to the same execution's redacted detail. */
export function prepareWorkflowOutput<T>(value: T, dir: string, options: { storeDetails?: (detail: unknown) => { ref: string; next_action: Record<string, unknown> } | null } = {}): T | Record<string, unknown> {
  if (!object(value) || !object(value.result)) return value;
  // A check, plan-only or read-only call must not start writing local artifacts.
  if (!options.storeDetails && (value.dry_run === true || value.read_only === true || value.mode !== "apply")) return value;
  let ref: string | null;
  let action: Record<string, unknown> | undefined;
  try {
    const stored = options.storeDetails?.(redactWorkflowDiagnostics(value));
    ref = options.storeDetails ? stored?.ref ?? null : diagnosticPath(dir, value);
    action = stored?.next_action;
  } catch { return value; } // never lose detail when local storage is unavailable
  if (!ref) return value;
  const result = { ...value.result };
  if (object(result.deploy)) result.deploy = deployment(result.deploy);
  if (object(result.repo)) result.repo = repository(result.repo);
  if (object(result.edge_coherence)) result.edge_coherence = verification(result.edge_coherence);
  delete result.app_graph;
  delete result.spec;
  delete result.manifest;
  if (object(result.app_result)) {
    const app = { ...result.app_result };
    delete app.graph;
    // This is a display projection, not the complete run402.up.result schema.
    delete app.schema_url;
    app.kind = "run402.up.summary";
    app.schema_version = "run402.up.summary.v1";
    if (object(app.release)) app.release = deployment(app.release);
    if (object(app.verification)) app.verification = verification(app.verification);
    result.app_result = app;
  }
  if (object(result.plan)) {
    const plan = { ...result.plan };
    // Keep summary, permissions, warnings, cost and next actions; omit repeated file inventories.
    for (const key of ["site", "functions", "routes", "assets", "missing_content"]) delete plan[key];
    result.plan = plan;
  }
  const steps = Array.isArray(value.steps) ? value.steps.filter(step => object(step) && (step.mutation === true || step.state === "failed")).map((step) => {
    if (!object(step)) return step;
    return pick(step, ["id", "action", "state", "mutation", "code", "reason", "next_actions"]);
  }) : value.steps;
  return {
    ...value, steps, step_count: Array.isArray(value.steps) ? value.steps.length : 0, result,
    result_ref: ref,
    truncation: { kind: "display", has_more: true, redacted: true },
    next_actions: [...(Array.isArray(value.next_actions) ? value.next_actions : []), action ?? {
      type: "inspect_file", path: ref, why: "Read this execution's redacted detail from the local diagnostic file. It is not a remote URL; retained for at most 30 minutes on subsequent writes, bounded to 32 files.",
    }],
  };
}
