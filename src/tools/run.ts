/**
 * `run` — execute a TypeScript snippet against the SDK in a sandbox.
 *
 * Before anything runs, the snippet is type-checked against the SDK's
 * declarations (`../snippet-check.ts`). A snippet that cannot type-check makes
 * no call: it is refused with TypeScript's own diagnostics, as
 * `RUN_UNKNOWN_MEMBER` when the first is a member an SDK object does not have,
 * else `RUN_TYPE_ERROR`. A checker that cannot answer is skipped, never fatal.
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
 * honest: the value is stored by items (`../value-paging.ts`: an array's
 * elements, the rows of an object's largest array, an object's entries, or a
 * string's lines) under `value_ref`; a value that does not fit inline carries
 * its leading whole items as `value_window`, with `shown` / `total` counting
 * items; logs likewise under `logs_ref` (50 inline); `calls[]` lists every
 * SDK chain the replay ran with its outcome, including on a timeout, because
 * those side effects happened. Every result names the active wallet.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { isRun402Error } from "../../sdk/dist/index.js";
import { getActiveProfile } from "../config.js";
import { readWallet } from "../wallet.js";
import { storeResult } from "../result-store.js";
import { ChainHost, UnknownMember, type ChainCall } from "../sandbox-proxy.js";
import { prepareSnippet, runInSandbox, type SandboxError, type SandboxLogLine } from "../sandbox.js";
import { checkSnippet, type SnippetCheck, type SnippetDiagnostic } from "../snippet-check.js";
import { jsonBlock, type ToolResult } from "../structured.js";
import { fitsInline, pageableItems, pageValue, VALUE_INLINE_LINES } from "../value-paging.js";
import { getSandboxSdk } from "../sdk.js";

/** At most this many runs execute at once on one server; the next is `RUN_BUSY`. */
export const RUN_MAX_CONCURRENT = 4;
export const RUN_DEFAULT_TIMEOUT_SECONDS = 60;
export const RUN_MAX_TIMEOUT_SECONDS = 300;
/** Source size cap, in bytes. */
export const RUN_MAX_SOURCE_BYTES = 64 * 1024;
/** A value whose pretty-printed JSON fits in this many lines is inline whole; a larger one is windowed by items within the same budget. */
export const RUN_VALUE_WINDOW_LINES = VALUE_INLINE_LINES;
/** Console lines shown inline. */
export const RUN_LOG_WINDOW_LINES = 50;
/** Type-check diagnostics shown inline; all of them are stored behind `diagnostics_ref`. */
export const RUN_DIAGNOSTICS_WINDOW = 10;

export type RunErrorCode =
  | "RUN_SYNTAX_ERROR"
  | "RUN_TIMEOUT"
  | "RUN_MEMORY_EXCEEDED"
  | "RUN_VALUE_NOT_SERIALIZABLE"
  | "RUN_VALUE_TOO_LARGE"
  | "RUN_BUSY"
  | "RUN_EXCEPTION"
  | "RUN_ARGUMENT_NOT_CLONEABLE"
  | "RUN_UNKNOWN_MEMBER"
  | "RUN_TYPE_ERROR";

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
  /**
   * For a value too large to inline: the leading whole items, where they live
   * in the value (`$`, `$.<key>`, `$entries`, `$lines`), and, for `$.<key>`,
   * the object's other fields. `expand_result(value_ref)` pages the rest.
   */
  value_window?: { path: string; items: unknown[]; rest?: Record<string, unknown> };
  value_ref: string | null;
  /** Items shown: all of them when `value` is inline, else `value_window.items.length`. */
  shown: number;
  /** Items in the whole value. */
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
  /** Present only when the type check could not run: the snippet ran unchecked. */
  type_check?: { status: "skipped"; reason: string };
  error?: {
    code: string;
    message: string;
    next_actions: RunNextAction[];
    line?: number;
    column?: number;
    /** The type check's diagnostics, in the snippet's coordinates (a refused snippet): the first `RUN_DIAGNOSTICS_WINDOW`. */
    diagnostics?: SnippetDiagnostic[];
    /** When more diagnostics exist than are shown: how many in all, and the ref `expand_result` pages them from. */
    diagnostics_total?: number;
    diagnostics_ref?: string;
  };
}

/** What the stderr line says about the type check. */
type CheckOutcome = "passed" | "refused" | "skipped" | "not_run";


export const runSchema = {
  code: z
    .string()
    .min(1)
    .refine((s) => Buffer.byteLength(s, "utf8") <= RUN_MAX_SOURCE_BYTES, { message: "code is at most 64 KB" })
    .describe(
      "TypeScript or JavaScript, run as the body of an async function: top-level await works, and the value of an explicit return or of the last expression statement is the result. `r` is the Node SDK client (`@run402/sdk/node`): await any chain, e.g. `(await r.projects.list()).projects.map(p => p.id)` or `await r.project(\"prj_…\").functions.list()`. The snippet is type-checked against the SDK before anything runs, and a type error makes no call; then types are stripped: no enum, no parameter properties. No filesystem, process, fetch, timers, or imports; `console` is captured.",
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
    logRun(runId, result, "not_run");
    return render(result);
  }

  active++;
  const host = new ChainHost(getSandboxSdk());
  let checked: CheckOutcome = "not_run";
  let skipped: RunResult["type_check"];
  try {
    // A snippet that does not parse keeps its RUN_SYNTAX_ERROR path; one that
    // parses is type-checked, and a refused one makes no call.
    if (prepareSnippet(args.code).ok) {
      const check = await checkSnippet(args.code);
      checked = check.status;
      if (check.status === "skipped") {
        skipped = { status: "skipped", reason: check.reason };
        console.error(`run402-mcp type check skipped, the snippet runs unchecked: ${check.reason}`);
      }
      if (check.status === "refused") {
        const result: RunResult = { ...emptyResult(wallet, started), status: "error", error: refusal(check) };
        logRun(runId, result, checked);
        return render(result);
      }
    }

    const timeoutSeconds = Math.min(Math.max(1, Math.floor(args.timeout_seconds ?? RUN_DEFAULT_TIMEOUT_SECONDS)), RUN_MAX_TIMEOUT_SECONDS);
    const outcome = await runInSandbox({ code: args.code, timeoutMs: timeoutSeconds * 1000, extensions: [host.extension()] });

    const result: RunResult = {
      ...emptyResult(wallet, started),
      status: outcome.status,
      ...(skipped ? { type_check: skipped } : {}),
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
        if (fitsInline(parsed)) {
          const { items } = pageableItems(parsed);
          const stored = storeResult("run_value", items, { shown: items.length });
          result.value = parsed;
          result.value_ref = stored.ref;
          result.shown = stored.total;
          result.total = stored.total;
        } else {
          // Paged by items, never by text lines: the window is whole rows.
          const paged = pageValue(parsed);
          const stored = storeResult("run_value", paged.items, { shown: paged.window.length });
          result.value_window = { path: paged.path, items: paged.window, ...(paged.rest ? { rest: paged.rest } : {}) };
          result.value_ref = stored.ref;
          result.shown = stored.shown;
          result.total = stored.total;
        }
      }
    } else if (outcome.error) {
      result.error = runError(outcome.error, host);
    }

    logRun(runId, result, checked);
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
    logRun(runId, result, checked);
    return render(result);
  } finally {
    host.dispose();
    active--;
  }
}

/** What rendering needs beside the envelope: the value's inline lines and the stored log count. */
const renderExtras = new WeakMap<RunResult, { logsTotal?: number }>();
function extras(result: RunResult): { logsTotal?: number } {
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
  RUN_UNKNOWN_MEMBER: "Use one of the members named in did_you_mean, or call docs with the namespace as topic for the full list.",
  RUN_TYPE_ERROR: "Fix the snippet where diagnostics point; each message is TypeScript's own, checked against the SDK's declarations before anything ran. Call docs with the namespace as topic for its methods and result fields.",
};

/**
 * A snippet the type check refused: nothing ran. The first diagnostics are
 * inline; when there are more, all of them are stored and `diagnostics_ref`
 * pages the rest, as `logs_ref` does for logs.
 */
function refusal(check: Extract<SnippetCheck, { status: "refused" }>): NonNullable<RunResult["error"]> {
  const first = check.diagnostics[0]!;
  const all = check.diagnostics;
  let window = all;
  let more = {};
  if (all.length > RUN_DIAGNOSTICS_WINDOW) {
    const stored = storeResult("run_diagnostics", all, { shown: RUN_DIAGNOSTICS_WINDOW });
    window = stored.items;
    more = { diagnostics_total: stored.total, diagnostics_ref: stored.ref };
  }
  const shared = { line: first.line, column: first.column, diagnostics: window, ...more };
  if (check.unknownMember) {
    return {
      code: "RUN_UNKNOWN_MEMBER",
      message: `${check.unknownMember.message} Nothing ran.`,
      next_actions: [{
        type: "edit_request",
        why: LOCAL_NEXT_ACTION.RUN_UNKNOWN_MEMBER,
        path: check.unknownMember.path,
        did_you_mean: check.unknownMember.suggestions,
      }],
      ...shared,
    };
  }
  const total = all.length;
  return {
    code: "RUN_TYPE_ERROR",
    message: `The snippet does not type-check against the SDK (${total} error${total === 1 ? "" : "s"}); nothing ran. Line ${first.line}, column ${first.column}: ${first.message}`,
    next_actions: [{ type: "edit_request", why: LOCAL_NEXT_ACTION.RUN_TYPE_ERROR, line: first.line, column: first.column }],
    ...shared,
  };
}

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
  // A path the SDK does not have: name the closest members.
  if (original instanceof UnknownMember) {
    return {
      code: "RUN_UNKNOWN_MEMBER",
      message: original.message,
      next_actions: [{
        type: "edit_request",
        why: LOCAL_NEXT_ACTION.RUN_UNKNOWN_MEMBER,
        path: original.path,
        did_you_mean: original.suggestions,
      }],
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

/** One stderr line per run: id, duration, call count, outcome, type check. Never the source, arguments, or values. */
function logRun(runId: string, result: RunResult, check: CheckOutcome): void {
  const outcome = result.status === "ok" ? "ok" : result.error?.code ?? "error";
  console.error(`run402-mcp run ${runId} duration_ms=${result.duration_ms} calls=${result.calls.length} outcome=${outcome} check=${check}`);
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

  const { logsTotal } = renderExtras.get(result) ?? {};
  if (result.value_window) {
    lines.push(
      "",
      `value — items 1–${result.shown} of ${result.total} at ${result.value_window.path} are in value_window below. The whole value is stored: expand_result with ref ${result.value_ref} pages the rest by item (offset ${result.shown}).`,
    );
  }
  if (logsTotal !== undefined && result.logs.length < logsTotal) {
    lines.push("", `logs — ${result.logs.length} of ${logsTotal} lines shown below; expand_result with ref ${result.logs_ref} pages the rest (offset ${result.logs.length}).`);
  }
  const diagnostics = result.error?.diagnostics;
  if (diagnostics && result.error?.diagnostics_ref) {
    lines.push("", `diagnostics — ${diagnostics.length} of ${result.error.diagnostics_total} shown below; expand_result with ref ${result.error.diagnostics_ref} pages the rest (offset ${diagnostics.length}).`);
  }
  if (result.type_check) {
    lines.push("", `type check skipped (${result.type_check.reason}): the snippet ran unchecked.`);
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
    "status", "value", "value_kind", "value_window", "value_ref", "shown", "total", "logs", "logs_ref", "logs_dropped",
    "calls", "calls_dropped", "duration_ms", "wallet", "type_check", "error",
  ];
  const out: Record<string, unknown> = {};
  for (const key of order) if (result[key] !== undefined) out[key] = result[key];
  return out;
}
