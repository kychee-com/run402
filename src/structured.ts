/**
 * Structured tool results: the `structuredContent` channel and each tool's
 * `outputSchema`.
 *
 * Every tool returns one object under `structuredContent`, success and error
 * alike, with `status: "ok" | "error"`. The object is built from the value the
 * tool computed, never parsed back from text, and the text block's fenced JSON
 * is that same object serialized, so the two channels cannot diverge.
 *
 * Every schema object is open (`.passthrough()`): the schema names the fields a
 * host branches on, and anything else the SDK or gateway adds passes through.
 * The MCP SDK validates `structuredContent` against the schema on success and
 * skips validation on `isError`; the tests validate error results too.
 */

import { z } from "zod";
import {
  NetworkError,
  ProjectCredentialNotFound,
  ProjectNotFound,
  Run402DeployError,
  Run402Error,
} from "../sdk/dist/index.js";

/** Standard return shape for all MCP tool handlers. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// The error object
// ---------------------------------------------------------------------------

/** Local codes for failures that are not a `Run402Error` carrying its own code. */
export type LocalToolErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_CREDENTIAL_NOT_FOUND"
  | "NETWORK_ERROR"
  | "RESULT_REF_NOT_FOUND"
  | "DOCS_TOPIC_NOT_FOUND"
  | "WALLET_NOT_FOUND"
  | "INTERNAL_ERROR";

export interface ToolError {
  code: string;
  message: string;
  next_actions: Array<Record<string, unknown>>;
  category?: string;
  retryable?: boolean;
  safe_to_retry?: boolean;
  http_status?: number;
  mutation_state?: string;
  trace_id?: string;
  details?: unknown;
  line?: number;
  column?: number;
  phase?: string;
  resource?: string;
  operation_id?: string;
  plan_id?: string;
  fix?: unknown;
  logs?: string[];
}

const nextActionSchema = z.object({ type: z.string().optional() }).passthrough();

export const toolErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    next_actions: z.array(nextActionSchema),
    category: z.string().optional(),
    retryable: z.boolean().optional(),
    safe_to_retry: z.boolean().optional(),
    http_status: z.number().int().optional(),
    mutation_state: z.string().optional(),
    trace_id: z.string().optional(),
    details: z.unknown().optional(),
    line: z.number().int().optional(),
    column: z.number().int().optional(),
    phase: z.string().optional(),
    resource: z.string().optional(),
    operation_id: z.string().optional(),
    plan_id: z.string().optional(),
    fix: z.unknown().optional(),
    logs: z.array(z.string()).optional(),
  })
  .passthrough();

/** At most this many deploy log lines ride in an error, as the text shows. */
export const DEPLOY_ERROR_LOG_LINES = 50;

function actionsOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object" && !Array.isArray(a));
}

function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[key] : undefined;
}

/**
 * Normalize anything a handler caught into the one error object. A
 * `Run402Error` supplies its own code and fields unchanged; anything else gets
 * a local code. `context` is the verb phrase the prose uses ("reading status").
 */
export function toolErrorFrom(err: unknown, context?: string): ToolError {
  const prefix = context ? `Error ${context}: ` : "";
  if (err instanceof ProjectCredentialNotFound) {
    return withRun402Fields(
      { code: "PROJECT_CREDENTIAL_NOT_FOUND", message: `No local project credentials cached for ${err.projectId}.`, next_actions: [] },
      err,
    );
  }
  if (err instanceof ProjectNotFound) {
    return {
      code: "PROJECT_NOT_FOUND",
      message: `Project ${err.projectId} not found in key store.`,
      next_actions: err.nextActions?.length
        ? actionsOf(err.nextActions)
        : [{ type: "create_project", why: "Create a project first with `up` (or `run402 projects provision`)." }],
    };
  }
  if (err instanceof Run402Error) {
    const fallback = err instanceof NetworkError ? "NETWORK_ERROR" : "INTERNAL_ERROR";
    const bodyMessage = bodyField(err.body, "message");
    const out = withRun402Fields(
      {
        code: err.code ?? (typeof bodyField(err.body, "code") === "string" ? (bodyField(err.body, "code") as string) : fallback),
        message: typeof bodyMessage === "string" && bodyMessage ? bodyMessage : err.message,
        next_actions: [],
      },
      err,
    );
    if (err instanceof Run402DeployError) {
      if (err.phase) out.phase = err.phase;
      if (err.resource) out.resource = err.resource;
      if (err.operationId) out.operation_id = err.operationId;
      if (err.planId) out.plan_id = err.planId;
      if (err.fix) out.fix = err.fix;
      if (err.logs && err.logs.length > 0) out.logs = err.logs.slice(0, DEPLOY_ERROR_LOG_LINES);
    }
    return out;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "INTERNAL_ERROR", message: `${prefix}${message}`, next_actions: [] };
}

function withRun402Fields(base: ToolError, err: Run402Error): ToolError {
  const out: ToolError = { ...base };
  const actions = err.nextActions?.length ? err.nextActions : bodyField(err.body, "next_actions");
  out.next_actions = actionsOf(actions);
  if (err.category) out.category = err.category;
  if (err.retryable !== undefined) out.retryable = err.retryable;
  if (err.safeToRetry !== undefined) out.safe_to_retry = err.safeToRetry;
  if (err.status !== null) out.http_status = err.status;
  if (err.mutationState) out.mutation_state = err.mutationState;
  if (err.traceId) out.trace_id = err.traceId;
  if (err.details !== undefined && err.details !== null) out.details = err.details;
  return out;
}

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

/** The fenced JSON block the text channel carries: the structured object itself. */
export function jsonBlock(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

/** `{ status: "ok", result }` for the fixed tools that return one SDK object. */
export function okResult(result: unknown): { status: "ok"; result: unknown } {
  return { status: "ok", result };
}

/** An error result: `isError`, the prose the model reads, the object a host reads. */
export function errorResult(text: string, error: ToolError, extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { status: "error", ...extra, error },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const status = z.enum(["ok", "error"]);
const open = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

/** The fields every envelope shares; each tool adds its payload. */
function envelope<T extends z.ZodRawShape>(shape: T) {
  return open({ status, error: toolErrorSchema.optional(), ...shape });
}

const runCallSchema = open({
  path: z.string(),
  duration_ms: z.number(),
  ok: z.boolean(),
  code: z.string().optional(),
  payment_attempt_id: z.string().optional(),
});
const runLogSchema = open({ level: z.enum(["log", "info", "warn", "error"]), line: z.string() });

export const runOutputSchema = envelope({
  value: z.unknown().optional(),
  value_kind: z.literal("undefined").optional(),
  value_ref: z.string().nullable().optional(),
  shown: z.number().int().optional(),
  total: z.number().int().optional(),
  logs: z.array(runLogSchema).optional(),
  logs_ref: z.string().nullable().optional(),
  logs_dropped: z.number().int().optional(),
  calls: z.array(runCallSchema).optional(),
  calls_dropped: z.number().int().optional(),
  duration_ms: z.number().optional(),
  wallet: open({ local_label: z.string(), address: z.string().nullable() }).optional(),
});

export const upOutputSchema = envelope({
  result: open({
    action: z.string().optional(),
    mode: z.string().optional(),
    dry_run: z.boolean().optional(),
    steps: z.array(open({})).optional(),
    result: z.unknown().optional(),
  }).optional(),
});

const deployEventSchema = open({ type: z.string().optional() });
const warningSchema = open({ code: z.string().optional() });

export const deployOutputSchema = envelope({
  result: open({
    release_id: z.string(),
    operation_id: z.string(),
    // Values are URLs today; the schema does not reject a null or a future shape.
    urls: z.record(z.unknown()),
    warnings: z.array(warningSchema).optional(),
    next_actions: z.array(nextActionSchema).optional(),
  }).optional(),
  events: z.array(deployEventSchema).optional(),
  warnings: z.array(warningSchema).optional(),
});

export const statusOutputSchema = envelope({
  result: open({
    wallet: open({ local_label: z.string(), server_label: z.string().nullable().optional(), address: z.string() }).nullable(),
    projects: z.array(open({ project_id: z.string() })),
    active_project: z.string().nullable(),
    tier: open({ name: z.string(), status: z.string(), expires: z.string().nullable() }).nullable().optional(),
  }).optional(),
});

export const whoamiOutputSchema = envelope({
  result: open({
    principal: open({ id: z.string(), type: z.string().optional() }),
    memberships: z.array(open({ org_id: z.string(), role: z.string().optional() })),
    session: open({ grade: z.string().optional() }).nullable().optional(),
  }).optional(),
});

export const doctorOutputSchema = envelope({
  result: open({
    ok: z.boolean(),
    blocking: z.array(open({})),
    warnings: z.array(open({})),
    checks: z.array(open({ name: z.string(), status: z.string() })),
  }).optional(),
});

export const expandResultOutputSchema = envelope({
  ref: z.string().optional(),
  kind: z.string().optional(),
  offset: z.number().int().optional(),
  shown: z.number().int().optional(),
  total: z.number().int().optional(),
  items: z.array(z.unknown()).optional(),
});

export const docsOutputSchema = envelope({
  kind: z.string().optional(),
  ref: z.string().nullable().optional(),
  shown: z.number().int().optional(),
  total: z.number().int().optional(),
  lines: z.array(z.string()).optional(),
});

/** Tool name → output schema. `src/index.ts` registers each tool with its entry. */
export const OUTPUT_SCHEMAS = {
  up: upOutputSchema,
  deploy: deployOutputSchema,
  status: statusOutputSchema,
  whoami: whoamiOutputSchema,
  doctor: doctorOutputSchema,
  docs: docsOutputSchema,
  run: runOutputSchema,
  expand_result: expandResultOutputSchema,
} as const;
