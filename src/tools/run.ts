/**
 * `run` — execute a TypeScript snippet against the SDK in a sandbox.
 *
 * The snippet sees one binding, `r` (the Node SDK client, reached through the
 * chain proxy in `../sandbox-proxy.ts`), plus `console` and the ECMAScript
 * builtins. It has no filesystem, no `process`, no module loader, no timers,
 * and no network of its own (`../sandbox.ts`). Its chains replay on the host
 * against a client built with `surface: "sandbox"`, which refuses every
 * secret-returning or secret-consuming SDK method with `SECRET_REQUIRES_CLI`
 * before any request, so nothing secret can reach the result store.
 *
 * The result is the value, the logs, and the calls, all bounded and all
 * honest: the value is stored line-wise (pretty-printed JSON) under
 * `value_ref` and shown as a window of at most 200 lines with `shown` /
 * `total`; logs likewise under `logs_ref` (50 inline); `calls[]` lists every
 * SDK chain the replay ran with its outcome, including on a timeout, because
 * those side effects happened. Every result names the active wallet.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { isRun402Error } from "../../sdk/dist/index.js";
import { getActiveProfile } from "../config.js";
import { readWallet } from "../wallet.js";
import { storeResult } from "../result-store.js";
import { ChainHost, type ChainCall } from "../sandbox-proxy.js";
import { runInSandbox, type SandboxError, type SandboxLogLine } from "../sandbox.js";
import { jsonBlock, type ToolResult } from "../structured.js";
import { getSandboxSdk } from "../sdk.js";

/** At most this many runs execute at once on one server; the next is `RUN_BUSY`. */
export const RUN_MAX_CONCURRENT = 4;
export const RUN_DEFAULT_TIMEOUT_SECONDS = 60;
export const RUN_MAX_TIMEOUT_SECONDS = 300;
/** Source size cap, in bytes. */
export const RUN_MAX_SOURCE_BYTES = 64 * 1024;
/** Pretty-printed value lines shown inline. */
export const RUN_VALUE_WINDOW_LINES = 200;
/** Console lines shown inline. */
export const RUN_LOG_WINDOW_LINES = 50;

export type RunErrorCode =
  | "RUN_SYNTAX_ERROR"
  | "RUN_TIMEOUT"
  | "RUN_MEMORY_EXCEEDED"
  | "RUN_VALUE_NOT_SERIALIZABLE"
  | "RUN_VALUE_TOO_LARGE"
  | "RUN_BUSY"
  | "RUN_EXCEPTION"
  | "RUN_ARGUMENT_NOT_CLONEABLE";

export interface RunNextAction {
  type: string;
  why?: string;
  command?: string;
  [key: string]: unknown;
}

export interface RunResult {
  status: "ok" | "error";
  /** The value, when the whole of it fits the inline window (`shown === total`). */
  value?: unknown;
  value_kind?: "undefined";
  value_ref: string | null;
  /** Pretty-printed value lines shown inline. */
  shown: number;
  /** Pretty-printed value lines in the whole value. */
  total: number;
  logs: SandboxLogLine[];
  logs_ref: string | null;
  /** Console lines past the stored cap that were not retained. */
  logs_dropped?: number;
  calls: ChainCall[];
  /** `calls[]` entries past the cap that were not retained. */
  calls_dropped?: number;
  duration_ms: number;
  wallet: { local_label: string; address: string | null };
  error?: {
    code: string;
    message: string;
    next_actions: RunNextAction[];
    line?: number;
    column?: number;
  };
}


export const runSchema = {
  code: z
    .string()
    .min(1)
    .refine((s) => Buffer.byteLength(s, "utf8") <= RUN_MAX_SOURCE_BYTES, { message: "code is at most 64 KB" })
    .describe(
      "TypeScript or JavaScript, run as the body of an async function: top-level await works, and the value of an explicit return or of the last expression statement is the result. `r` is the Node SDK client (`@run402/sdk/node`): await any chain, e.g. `(await r.projects.list()).map(p => p.project_id)` or `await r.project(\"prj_…\").functions.list()`. Types are stripped, not compiled: no enum, no parameter properties. No filesystem, process, fetch, timers, or imports; `console` is captured.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(RUN_MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(`Deadline for the whole run, ${RUN_DEFAULT_TIMEOUT_SECONDS} s by default and at most ${RUN_MAX_TIMEOUT_SECONDS}. An SDK call in flight at the deadline completes on its own; the result lists every call that completed.`),
};

let active = 0;

export async function handleRun(args: { code: string; timeout_seconds?: number }): Promise<ToolResult> {
  const runId = `run_${randomBytes(6).toString("hex")}`;
  const started = Date.now();
  const wallet = activeWallet();

  if (active >= RUN_MAX_CONCURRENT) {
    const result: RunResult = {
      ...emptyResult(wallet, started),
      status: "error",
      error: {
        code: "RUN_BUSY",
        message: `${RUN_MAX_CONCURRENT} runs are already in flight on this server.`,
        next_actions: [{ type: "retry", why: "Retry when one of the runs in flight finishes." }],
      },
    };
    logRun(runId, result);
    return render(result);
  }

  active++;
  const host = new ChainHost(getSandboxSdk());
  try {
    const timeoutSeconds = Math.min(Math.max(1, Math.floor(args.timeout_seconds ?? RUN_DEFAULT_TIMEOUT_SECONDS)), RUN_MAX_TIMEOUT_SECONDS);
    const outcome = await runInSandbox({ code: args.code, timeoutMs: timeoutSeconds * 1000, extensions: [host.extension()] });

    const result: RunResult = {
      ...emptyResult(wallet, started),
      status: outcome.status,
      calls: [...host.calls],
      ...(host.callsDropped > 0 ? { calls_dropped: host.callsDropped } : {}),
      duration_ms: Date.now() - started,
    };

    if (outcome.logs.length > 0) {
      const stored = storeResult("run_logs", outcome.logs, { shown: RUN_LOG_WINDOW_LINES });
      result.logs = stored.items;
      result.logs_ref = stored.ref;
      extras(result).logsTotal = stored.total;
    }
    if (outcome.logs_dropped > 0) result.logs_dropped = outcome.logs_dropped;

    if (outcome.status === "ok") {
      if (outcome.value_kind === "undefined" || outcome.value_json === undefined) {
        result.value = null;
        result.value_kind = "undefined";
      } else {
        const parsed: unknown = JSON.parse(outcome.value_json);
        const lines = JSON.stringify(parsed, null, 2).split("\n");
        const stored = storeResult("run_value", lines, { shown: RUN_VALUE_WINDOW_LINES });
        result.value_ref = stored.ref;
        result.shown = stored.shown;
        result.total = stored.total;
        if (stored.shown === stored.total) result.value = parsed;
        extras(result).valueWindow = stored.items;
      }
    } else if (outcome.error) {
      result.error = runError(outcome.error, host);
    }

    logRun(runId, result);
    return render(result);
  } catch (err) {
    const result: RunResult = {
      ...emptyResult(wallet, started),
      status: "error",
      calls: [...host.calls],
      error: {
        code: "RUN_EXCEPTION",
        message: `The run could not complete: ${err instanceof Error ? err.message : String(err)}`,
        next_actions: [{ type: "edit_request", why: "Retry the snippet; if it fails the same way, simplify it." }],
      },
    };
    logRun(runId, result);
    return render(result);
  } finally {
    host.dispose();
    active--;
  }
}

/** What rendering needs beside the envelope: the value's inline lines and the stored log count. */
const renderExtras = new WeakMap<RunResult, { valueWindow?: string[]; logsTotal?: number }>();
function extras(result: RunResult): { valueWindow?: string[]; logsTotal?: number } {
  let e = renderExtras.get(result);
  if (!e) {
    e = {};
    renderExtras.set(result, e);
  }
  return e;
}

function emptyResult(wallet: RunResult["wallet"], started: number): RunResult {
  return {
    status: "ok",
    value_ref: null,
    shown: 0,
    total: 0,
    logs: [],
    logs_ref: null,
    calls: [],
    duration_ms: Date.now() - started,
    wallet,
  };
}

/** The active wallet's local label and short address, read locally (no network). */
function activeWallet(): RunResult["wallet"] {
  let local_label = "default";
  try {
    local_label = getActiveProfile();
  } catch {
    // An invalid wallet name in the environment; the SDK's own calls report it.
  }
  let address: string | null = null;
  try {
    const w = readWallet();
    if (w?.address) address = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
  } catch {
    // A malformed wallet file; the SDK's own calls report it.
  }
  return { local_label, address };
}

const LOCAL_NEXT_ACTION: Record<Exclude<RunErrorCode, "RUN_BUSY">, string> = {
  RUN_SYNTAX_ERROR: "Fix the syntax at the line and column named. Types are stripped, not compiled: no enum, no parameter properties, no namespaces.",
  RUN_TIMEOUT: `Narrow the snippet or raise timeout_seconds (at most ${RUN_MAX_TIMEOUT_SECONDS}). The calls listed completed; their side effects happened, so do not repeat them blindly.`,
  RUN_MEMORY_EXCEEDED: "Process less at once: page through the SDK's lists, or keep only the fields you need.",
  RUN_VALUE_NOT_SERIALIZABLE: "Return JSON data: map handles and class instances to plain fields; a function, a BigInt, or a cycle is not JSON.",
  RUN_VALUE_TOO_LARGE: "Narrow the selection in the snippet (filter, map to the fields you need, slice) and return less.",
  RUN_EXCEPTION: "Fix the snippet; the message names the error and, when known, its line.",
  RUN_ARGUMENT_NOT_CLONEABLE: "Pass data to r, not functions, class instances, or un-awaited r calls; await the call first and pass its result.",
};

function runError(error: SandboxError, host: ChainHost): NonNullable<RunResult["error"]> {
  const thrown = error.thrown;
  // An SDK error thrown during a replay: report it exactly as the SDK shaped it.
  const original = host.errorFor(thrown?.error_ref);
  if (original && isRun402Error(original)) {
    const e = original as unknown as { code?: string; message: string; nextActions?: RunNextAction[] };
    return {
      code: e.code ?? "RUN402_ERROR",
      message: e.message,
      next_actions: Array.isArray(e.nextActions) ? e.nextActions : [],
    };
  }
  let code: Exclude<RunErrorCode, "RUN_BUSY"> = error.code;
  if (thrown?.code === "RUN_ARGUMENT_NOT_CLONEABLE" || thrown?.code === "RUN_VALUE_TOO_LARGE") code = thrown.code;
  const message = code === error.code ? error.message : thrown?.message ?? error.message;
  const next: RunNextAction = { type: "edit_request", why: LOCAL_NEXT_ACTION[code] };
  if (error.line !== undefined) next.line = error.line;
  if (error.column !== undefined) next.column = error.column;
  return {
    code,
    message,
    next_actions: [next],
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.column !== undefined ? { column: error.column } : {}),
  };
}

/** One stderr line per run: id, duration, call count, outcome. Never the source, arguments, or values. */
function logRun(runId: string, result: RunResult): void {
  const outcome = result.status === "ok" ? "ok" : result.error?.code ?? "error";
  console.error(`run402-mcp run ${runId} duration_ms=${result.duration_ms} calls=${result.calls.length} outcome=${outcome}`);
}

function render(result: RunResult): ToolResult {
  const lines: string[] = [];
  const wallet = `${result.wallet.local_label}${result.wallet.address ? ` (${result.wallet.address})` : ""}`;
  const calls = `${result.calls.length} call${result.calls.length === 1 ? "" : "s"}`;
  if (result.status === "ok") {
    lines.push(`## run: ok — ${calls}, ${result.duration_ms} ms, wallet ${wallet}`);
  } else {
    lines.push(`## run: ${result.error?.code ?? "error"} — ${calls}, ${result.duration_ms} ms, wallet ${wallet}`);
    lines.push("", result.error?.message ?? "");
  }

  const { valueWindow: window, logsTotal } = renderExtras.get(result) ?? {};
  if (window && result.shown < result.total) {
    lines.push(
      "",
      `value — lines 1–${result.shown} of ${result.total}. The whole value is stored: expand_result with ref ${result.value_ref} pages the rest (offset ${result.shown}).`,
      "```json",
      ...window,
      "```",
    );
  }
  if (logsTotal !== undefined && result.logs.length < logsTotal) {
    lines.push("", `logs — ${result.logs.length} of ${logsTotal} lines shown below; expand_result with ref ${result.logs_ref} pages the rest (offset ${result.logs.length}).`);
  }

  // The fenced JSON is the structured object itself: one value, two views.
  const structured = inContractOrder(result);
  lines.push("", jsonBlock(structured));
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: structured,
    ...(result.status === "error" ? { isError: true } : {}),
  };
}

/** The envelope's fields in the Frozen Contract's order, absent ones left out. */
function inContractOrder(result: RunResult): Record<string, unknown> {
  const order: Array<keyof RunResult> = [
    "status", "value", "value_kind", "value_ref", "shown", "total", "logs", "logs_ref", "logs_dropped",
    "calls", "calls_dropped", "duration_ms", "wallet", "error",
  ];
  const out: Record<string, unknown> = {};
  for (const key of order) if (result[key] !== undefined) out[key] = result[key];
  return out;
}
