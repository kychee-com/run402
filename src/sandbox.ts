/**
 * The `run` sandbox: a TypeScript snippet executes inside QuickJS compiled to
 * WebAssembly (the asyncify build of `quickjs-emscripten`), never inside Node.
 *
 * A QuickJS runtime can touch the host only through functions the host binds
 * into it, so `require`, `process`, `fetch`, `import()`, timers, and every Node
 * builtin are absent by construction: there is nothing to deny. What the
 * snippet does see is the global inventory below (`SANDBOX_GLOBALS`, pinned by
 * `sandbox.test.ts`): the ECMAScript builtins QuickJS ships, the web builtins
 * this module adds in plain JavaScript (`URL`, `TextEncoder`, `TextDecoder`,
 * `structuredClone`, `crypto.randomUUID`), a captured `console`, and whatever
 * an extension installs (the `r` recorder from `./sandbox-proxy.ts`).
 *
 * Each run gets its own WebAssembly module instance, runtime, and context, so
 * nothing survives from one run to the next and a run that ends badly cannot
 * poison another. Bounds: a memory limit on the runtime, a stack limit, and a
 * deadline enforced two ways — the interrupt handler stops JavaScript that is
 * running past it, and the event loop stops waiting on the host past it. An
 * async host call already in flight at the deadline is allowed to settle
 * before the run returns, because its side effect is real either way.
 *
 * The source is TypeScript or JavaScript. It is wrapped as the body of an
 * async function (so top-level `await` and `return` both work), types are
 * stripped on the host with `node:module`'s `stripTypeScriptTypes` (strip-only:
 * `enum` and parameter properties are syntax errors, as in Node), the result is
 * parsed, and when the body ends in an expression statement that statement is
 * rewritten into a `return` from the parse tree, never by string search.
 */

import { randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { parse as parseJs, type Node as AcornNode } from "acorn";
import {
  newQuickJSAsyncWASMModule,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from "quickjs-emscripten";

/** 64 MB: the runtime's allocation ceiling. */
export const SANDBOX_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** The interpreter's own stack ceiling, well inside the WebAssembly stack. */
export const SANDBOX_STACK_LIMIT_BYTES = 256 * 1024;
/** The serialized (compact JSON) value a run may return. */
export const SANDBOX_MAX_VALUE_BYTES = 4 * 1024 * 1024;
/** Console lines retained per run. */
export const SANDBOX_MAX_LOG_LINES = 500;
/** Characters retained per console line. */
export const SANDBOX_MAX_LOG_LINE_CHARS = 2048;

/** The file name QuickJS reports in stack traces. */
const SNIPPET_FILE = "snippet.ts";
/** The wrapper's head sits on line 1, so line numbers match the source and only line 1's columns shift. */
const WRAP_HEAD = "(async function () {";
const WRAP_TAIL = "\n})";

/**
 * The snippet's global inventory, sorted. `r` is present when the chain proxy
 * is installed (always, in the `run` tool). A new global is a deliberate diff
 * of this list and of the snapshot test.
 */
export const SANDBOX_GLOBALS = [
  "AggregateError", "Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean",
  "DataView", "Date", "Error", "EvalError", "FinalizationRegistry", "Float16Array", "Float32Array",
  "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array", "Int8Array", "InternalError",
  "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError",
  "ReferenceError", "Reflect", "RegExp", "Set", "SharedArrayBuffer", "String", "Symbol", "SyntaxError",
  "TextDecoder", "TextEncoder", "TypeError", "URIError", "URL", "Uint16Array", "Uint32Array", "Uint8Array",
  "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "console", "crypto", "decodeURI",
  "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "eval", "globalThis", "isFinite",
  "isNaN", "parseFloat", "parseInt", "r", "structuredClone", "undefined", "unescape",
] as const;

export type SandboxErrorCode =
  | "RUN_SYNTAX_ERROR"
  | "RUN_TIMEOUT"
  | "RUN_MEMORY_EXCEEDED"
  | "RUN_VALUE_NOT_SERIALIZABLE"
  | "RUN_VALUE_TOO_LARGE"
  | "RUN_EXCEPTION";

export interface SandboxLogLine {
  level: "log" | "info" | "warn" | "error";
  line: string;
}

/** What the snippet threw, as far as the sandbox can describe it without trusting it. */
export interface SandboxThrown {
  name: string;
  message: string;
  /** A string `code` property on the thrown value, when it had one. */
  code?: string;
  /** A string `error_ref` property on the thrown value (set by the chain proxy on host errors). */
  error_ref?: string;
}

export interface SandboxError {
  code: SandboxErrorCode;
  message: string;
  line?: number;
  column?: number;
  thrown?: SandboxThrown;
}

export interface SandboxOutcome {
  status: "ok" | "error";
  /** Compact JSON of the value, when `status` is `ok` and the value was not `undefined`. */
  value_json?: string;
  /** `"undefined"` when the snippet produced `undefined` (reported as `null` data). */
  value_kind?: "undefined";
  error?: SandboxError;
  logs: SandboxLogLine[];
  /** Console lines past {@link SANDBOX_MAX_LOG_LINES} that were not retained. */
  logs_dropped: number;
  /** True when the deadline passed (the run was stopped or stopped waiting). */
  timed_out: boolean;
  duration_ms: number;
}

/**
 * Something the host installs into the sandbox before the snippet runs.
 * `install` is the source of a function expression `(host) => { … }` evaluated
 * inside the sandbox and called once with an object carrying the bound host
 * functions; it may define globals and keeps the host functions in its closure,
 * so no host function is ever a global.
 */
export interface SandboxExtension {
  install: string;
  /** Synchronous host functions: string (or undefined) arguments, string (or undefined) result. */
  sync?: Record<string, (...args: Array<string | undefined>) => string | undefined>;
  /**
   * Asynchronous host functions: string arguments, resolve to a string. They
   * should not reject; encode failures in the string. A rejection becomes a
   * plain `Error` inside the sandbox.
   */
  async?: Record<string, (...args: Array<string | undefined>) => Promise<string>>;
}

export interface SandboxRunOptions {
  code: string;
  timeoutMs: number;
  memoryLimitBytes?: number;
  maxValueBytes?: number;
  extensions?: SandboxExtension[];
}

// ─── source preparation ──────────────────────────────────────────────────────

export type PreparedSnippet =
  | { ok: true; source: string }
  | { ok: false; error: SandboxError };

/**
 * Wrap, strip types, parse, and rewrite the final expression statement into a
 * `return`. The result is the source of one async function expression.
 */
export function prepareSnippet(code: string): PreparedSnippet {
  const wrapped = `${WRAP_HEAD}${code}${WRAP_TAIL}`;
  let stripped: string;
  try {
    stripped = stripTypeScriptTypes(wrapped, { mode: "strip" });
  } catch (err) {
    return { ok: false, error: syntaxErrorFromStrip(err) };
  }

  let program: AcornProgram;
  try {
    program = parseJs(stripped, { ecmaVersion: "latest", sourceType: "script", locations: true }) as unknown as AcornProgram;
  } catch (err) {
    return { ok: false, error: syntaxErrorFromAcorn(err) };
  }

  // The whole source must be exactly the wrapper expression: a snippet that
  // closes the wrapper's brace early is a syntax error, not a second program.
  const only = program.body.length === 1 ? program.body[0] : null;
  const fn = only?.type === "ExpressionStatement" ? only.expression : null;
  if (!fn || fn.type !== "FunctionExpression" || !fn.async || fn.start !== 1) {
    return {
      ok: false,
      error: { code: "RUN_SYNTAX_ERROR", message: "Unbalanced braces: the snippet closes a block it did not open.", line: 1, column: 1 },
    };
  }

  const statements = fn.body.body;
  const last = statements.length > 0 ? statements[statements.length - 1] : null;
  if (!last || last.type !== "ExpressionStatement" || !last.expression || last.directive !== undefined) {
    return { ok: true, source: stripped };
  }
  const expr = last.expression;
  const source =
    stripped.slice(0, last.start) +
    "return (" + stripped.slice(expr.start, expr.end) + ");" +
    stripped.slice(last.end);
  return { ok: true, source };
}

/** The slice of acorn's ESTree shapes this module reads. */
interface AcornStatement extends AcornNode {
  expression?: AcornNode;
  directive?: string;
}
interface AcornProgram {
  body: Array<AcornNode & {
    expression?: AcornNode & { async?: boolean; body: { body: AcornStatement[] } };
  }>;
}

function shiftColumn(line: number, column: number): number {
  return line === 1 ? Math.max(1, column - WRAP_HEAD.length) : column;
}

function syntaxErrorFromStrip(err: unknown): SandboxError {
  const e = err as { message?: unknown; stack?: unknown };
  const message = typeof e?.message === "string" ? e.message : String(err);
  const stack = typeof e?.stack === "string" ? e.stack.split("\n") : [];
  // Node's type-stripping error stack is `:<line>`, the source line(s), then a caret line.
  const lineMatch = /^[^\n]*:(\d+)$/.exec(stack[0] ?? "");
  const line = lineMatch ? Number(lineMatch[1]) : 1;
  const caret = stack.slice(1, 6).find((l) => /^\s*\^+\s*$/.test(l));
  const column = caret ? caret.indexOf("^") + 1 : 1;
  return { code: "RUN_SYNTAX_ERROR", message, line, column: shiftColumn(line, column) };
}

function syntaxErrorFromAcorn(err: unknown): SandboxError {
  const e = err as { message?: unknown; loc?: { line?: number; column?: number } };
  const raw = typeof e?.message === "string" ? e.message : String(err);
  const line = typeof e?.loc?.line === "number" ? e.loc.line : 1;
  const column = typeof e?.loc?.column === "number" ? e.loc.column + 1 : 1;
  const message = raw.replace(/\s*\(\d+:\d+\)$/, "");
  return { code: "RUN_SYNTAX_ERROR", message, line, column: shiftColumn(line, column) };
}

/** The first `snippet.ts:<line>:<column>` frame of a QuickJS stack, mapped back to the source. */
function locationFromStack(stack: unknown): { line?: number; column?: number } {
  if (typeof stack !== "string") return {};
  const m = new RegExp(`${SNIPPET_FILE.replace(".", "\\.")}:(\\d+)(?::(\\d+))?`).exec(stack);
  if (!m) return {};
  const line = Number(m[1]);
  return m[2] ? { line, column: shiftColumn(line, Number(m[2])) } : { line };
}

// ─── the in-sandbox base: console, web builtins, the driver ──────────────────

/**
 * Evaluated inside the sandbox and called with the base host object
 * `{ log, settle, uuid, url }`. Defines `console`, `crypto`, `URL`,
 * `TextEncoder`, `TextDecoder`, `structuredClone`, and returns the driver that
 * runs the snippet function and reports how it settled.
 */
const BASE_INSTALL = String.raw`(function (host) {
  "use strict";
  const g = globalThis;
  const stringify = JSON.stringify;
  const define = (name, value) =>
    Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });

  const format = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return (v.name || "Error") + ": " + v.message;
    if ((typeof v === "object" && v !== null) || typeof v === "function") {
      try { const s = stringify(v); if (s !== undefined) return s; } catch (e) { /* fall through */ }
    }
    try { return String(v); } catch (e) { return Object.prototype.toString.call(v); }
  };
  const makeLevel = (level) => (...args) => { host.log(level, args.map(format).join(" ")); };
  define("console", { log: makeLevel("log"), info: makeLevel("info"), warn: makeLevel("warn"), error: makeLevel("error") });

  define("crypto", { randomUUID: () => host.uuid() });

  const parseUrl = (input, base) => {
    const raw = base === undefined ? host.url(String(input)) : host.url(String(input), String(base));
    return raw ? JSON.parse(raw) : null;
  };
  class URL {
    #p;
    constructor(input, base) {
      const p = parseUrl(input, base);
      if (!p) throw new TypeError("Invalid URL: " + String(input));
      this.#p = p;
    }
    static canParse(input, base) { return parseUrl(input, base) !== null; }
    get href() { return this.#p.href; }
    get origin() { return this.#p.origin; }
    get protocol() { return this.#p.protocol; }
    get username() { return this.#p.username; }
    get password() { return this.#p.password; }
    get host() { return this.#p.host; }
    get hostname() { return this.#p.hostname; }
    get port() { return this.#p.port; }
    get pathname() { return this.#p.pathname; }
    get search() { return this.#p.search; }
    get hash() { return this.#p.hash; }
    toString() { return this.#p.href; }
    toJSON() { return this.#p.href; }
  }
  define("URL", URL);

  class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(input = "") {
      const s = String(input);
      const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
          const d = s.charCodeAt(i + 1);
          if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else c = 0xfffd;
        } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  }
  define("TextEncoder", TextEncoder);

  class TextDecoder {
    constructor(label = "utf-8") {
      const l = String(label).trim().toLowerCase();
      if (l !== "utf-8" && l !== "utf8" && l !== "unicode-1-1-utf-8") throw new RangeError('The "' + label + '" encoding is not supported');
    }
    get encoding() { return "utf-8"; }
    decode(input) {
      if (input === undefined) return "";
      const b = input instanceof Uint8Array ? input
        : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      const cont = (k) => k < b.length && (b[k] & 0xc0) === 0x80;
      let out = "";
      let chunk = [];
      for (let i = 0; i < b.length;) {
        const x = b[i];
        let cp = 0xfffd, n = 1;
        if (x < 0x80) cp = x;
        else if (x >= 0xc2 && x < 0xe0 && cont(i + 1)) { cp = ((x & 31) << 6) | (b[i + 1] & 63); n = 2; }
        else if (x >= 0xe0 && x < 0xf0 && cont(i + 1) && cont(i + 2)) {
          const v = ((x & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63);
          if (v >= 0x800 && (v < 0xd800 || v > 0xdfff)) { cp = v; n = 3; }
        } else if (x >= 0xf0 && x < 0xf5 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
          const v = ((x & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63);
          if (v >= 0x10000 && v <= 0x10ffff) { cp = v; n = 4; }
        }
        if (!(i === 0 && cp === 0xfeff)) chunk.push(cp);
        i += n;
        if (chunk.length >= 4096) { out += String.fromCodePoint(...chunk); chunk = []; }
      }
      return out + String.fromCodePoint(...chunk);
    }
  }
  define("TextDecoder", TextDecoder);

  const cloneError = (what) => {
    const e = new Error(what + " could not be cloned.");
    e.name = "DataCloneError";
    return e;
  };
  define("structuredClone", function structuredClone(value) {
    const seen = new Map();
    const walk = (v) => {
      if (typeof v === "symbol") throw cloneError("Symbol()");
      if (typeof v === "function") throw cloneError("A function");
      if (v === null || typeof v !== "object") return v;
      if (seen.has(v)) return seen.get(v);
      let out;
      if (Array.isArray(v)) {
        out = [];
        seen.set(v, out);
        for (let i = 0; i < v.length; i++) out[i] = walk(v[i]);
        return out;
      }
      if (v instanceof Date) { out = new Date(v.getTime()); seen.set(v, out); return out; }
      if (v instanceof RegExp) { out = new RegExp(v.source, v.flags); seen.set(v, out); return out; }
      if (v instanceof Map) { out = new Map(); seen.set(v, out); for (const [k, x] of v) out.set(walk(k), walk(x)); return out; }
      if (v instanceof Set) { out = new Set(); seen.set(v, out); for (const x of v) out.add(walk(x)); return out; }
      if (v instanceof ArrayBuffer) { out = v.slice(0); seen.set(v, out); return out; }
      if (ArrayBuffer.isView(v)) {
        const buffer = walk(v.buffer);
        out = v instanceof DataView ? new DataView(buffer, v.byteOffset, v.byteLength) : new v.constructor(buffer, v.byteOffset, v.length);
        seen.set(v, out);
        return out;
      }
      if (v instanceof Error) {
        out = new Error(String(v.message));
        out.name = String(v.name);
        seen.set(v, out);
        return out;
      }
      out = {};
      seen.set(v, out);
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    };
    return walk(value);
  });

  const describe = (e) => {
    if (e !== null && (typeof e === "object" || typeof e === "function")) {
      const d = { name: "Error", message: "", stack: "" };
      try { d.name = String(e.name === undefined ? "Error" : e.name); } catch (x) { /* keep default */ }
      try { d.message = String(e.message === undefined ? "" : e.message); } catch (x) { /* keep default */ }
      try { if (typeof e.stack === "string") d.stack = e.stack; } catch (x) { /* keep default */ }
      try { if (typeof e.code === "string") d.code = e.code; } catch (x) { /* keep default */ }
      try { if (typeof e.error_ref === "string") d.error_ref = e.error_ref; } catch (x) { /* keep default */ }
      return d;
    }
    let message;
    try { message = String(e); } catch (x) { message = typeof e; }
    return { name: "Error", message, stack: "" };
  };

  return function start(fn) {
    let p;
    try { p = fn(); } catch (e) { p = Promise.reject(e); }
    p.then(
      (v) => {
        if (v === undefined) { host.settle("undefined", ""); return; }
        let json;
        try { json = stringify(v); } catch (e) { host.settle("not_serializable", String(e && e.message ? e.message : e)); return; }
        if (json === undefined) {
          host.settle("not_serializable", "The value is " + (typeof v === "function" ? "a function or an r handle" : "a " + typeof v) + ", which is not JSON.");
          return;
        }
        host.settle("ok", json);
      },
      (e) => {
        let d;
        try { d = stringify(describe(e)); } catch (x) { d = stringify({ name: "Error", message: "The snippet threw a value that could not be described.", stack: "" }); }
        host.settle("error", d);
      },
    );
  };
})`;

// ─── running ─────────────────────────────────────────────────────────────────

interface ThrownDescription {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  error_ref?: string;
}

type Settled =
  | { kind: "ok"; json: string }
  | { kind: "undefined" }
  | { kind: "not_serializable"; message: string }
  | { kind: "error"; thrown: ThrownDescription };

/** Run one snippet to completion (or to its bound) and describe how it ended. */
export async function runInSandbox(opts: SandboxRunOptions): Promise<SandboxOutcome> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const maxValueBytes = opts.maxValueBytes ?? SANDBOX_MAX_VALUE_BYTES;
  const logs: SandboxLogLine[] = [];
  let logsDropped = 0;
  let interrupted = false;
  let settled: Settled | null = null;

  const finish = (fields: Partial<SandboxOutcome> & { status: "ok" | "error" }): SandboxOutcome => ({
    logs,
    logs_dropped: logsDropped,
    timed_out: interrupted,
    duration_ms: Date.now() - started,
    ...fields,
  });

  const prepared = prepareSnippet(opts.code);
  if (!prepared.ok) return finish({ status: "error", error: prepared.error });

  const module = await newQuickJSAsyncWASMModule();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(opts.memoryLimitBytes ?? SANDBOX_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(SANDBOX_STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) interrupted = true;
    return interrupted;
  });
  const ctx = runtime.newContext();

  // Async host calls in flight; the loop waits on them and never past them.
  const inflight = new Set<Promise<void>>();
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  let alive = true;

  const baseHost = {
    sync: {
      log: (level?: string, line?: string) => {
        if (logs.length >= SANDBOX_MAX_LOG_LINES) {
          logsDropped++;
          return undefined;
        }
        const text = line ?? "";
        logs.push({
          level: (level === "info" || level === "warn" || level === "error" ? level : "log"),
          line: text.length > SANDBOX_MAX_LOG_LINE_CHARS ? `${text.slice(0, SANDBOX_MAX_LOG_LINE_CHARS)}…` : text,
        });
        return undefined;
      },
      settle: (kind?: string, payload?: string) => {
        if (settled) return undefined;
        if (kind === "ok") settled = { kind: "ok", json: payload ?? "null" };
        else if (kind === "undefined") settled = { kind: "undefined" };
        else if (kind === "not_serializable") settled = { kind: "not_serializable", message: payload ?? "" };
        else {
          let thrown: ThrownDescription;
          try {
            thrown = JSON.parse(payload ?? "{}");
          } catch {
            thrown = { name: "Error", message: "The snippet threw a value that could not be described." };
          }
          settled = { kind: "error", thrown };
        }
        return undefined;
      },
      uuid: () => randomUUID(),
      url: (input?: string, base?: string) => {
        try {
          const u = base === undefined ? new URL(input ?? "") : new URL(input ?? "", base);
          return JSON.stringify({
            href: u.href, origin: u.origin, protocol: u.protocol, username: u.username, password: u.password,
            host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
          });
        } catch {
          return "";
        }
      },
    } as Record<string, (...args: Array<string | undefined>) => string | undefined>,
  };

  const hostObject = (ext: Pick<SandboxExtension, "sync" | "async">): QuickJSHandle => {
    const obj = ctx.newObject();
    for (const [name, impl] of Object.entries(ext.sync ?? {})) {
      const fn = ctx.newFunction(name, (...args) => {
        const out = impl(...args.map((h) => readString(ctx, h)));
        return out === undefined ? undefined : ctx.newString(out);
      });
      ctx.setProp(obj, name, fn);
      fn.dispose();
    }
    for (const [name, impl] of Object.entries(ext.async ?? {})) {
      const fn = ctx.newFunction(name, (...args) => {
        const strings = args.map((h) => readString(ctx, h));
        const deferred = ctx.newPromise();
        const call = Promise.resolve()
          .then(() => impl(...strings))
          .then(
            (value) => {
              if (!alive) return;
              const h = ctx.newString(value);
              deferred.resolve(h);
              h.dispose();
            },
            (err) => {
              if (!alive) return;
              const h = ctx.newError(err instanceof Error ? err.message : String(err));
              deferred.reject(h);
              h.dispose();
            },
          )
          .finally(() => {
            deferred.dispose();
            inflight.delete(call);
            notify();
          });
        inflight.add(call);
        return deferred.handle;
      });
      ctx.setProp(obj, name, fn);
      fn.dispose();
    }
    return obj;
  };

  /** Evaluate an install function and call it with its host object. Returns the call's result handle. */
  const install = (source: string, ext: Pick<SandboxExtension, "sync" | "async">): QuickJSHandle => {
    const fnHandle = ctx.unwrapResult(ctx.evalCode(source, "run402-sandbox-install.js"));
    const hostHandle = hostObject(ext);
    try {
      return ctx.unwrapResult(ctx.callFunction(fnHandle, ctx.undefined, hostHandle));
    } finally {
      hostHandle.dispose();
      fnHandle.dispose();
    }
  };

  let outcome: SandboxOutcome;
  // A host-level failure inside the WebAssembly module (its native stack
  // overflowing under deep async recursion, say) leaves the module unusable;
  // it is private to this run, so it is dropped rather than disposed.
  let poisoned = false;
  try {
    const start = install(BASE_INSTALL, baseHost);
    for (const ext of opts.extensions ?? []) install(ext.install, ext).dispose();

    const compiled = ctx.evalCode(prepared.source, SNIPPET_FILE);
    if (compiled.error) {
      const dumped = dumpError(ctx, compiled.error);
      compiled.error.dispose();
      start.dispose();
      outcome = finish({
        status: "error",
        error: classify(dumped, { interrupted, phase: "compile" }),
      });
    } else {
      const called = ctx.callFunction(start, ctx.undefined, compiled.value);
      compiled.value.dispose();
      start.dispose();
      let loopError: SandboxError | null = null;
      if (called.error) {
        loopError = classify(dumpError(ctx, called.error), { interrupted, phase: "run" });
        called.error.dispose();
      } else {
        called.value.dispose();
      }

      // The event loop: run jobs, then wait for the next host call to settle.
      while (!loopError && !settled) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          loopError = classify(dumpError(ctx, jobs.error), { interrupted, phase: "run" });
          jobs.error.dispose();
          break;
        }
        if (settled || interrupted) break;
        if (Date.now() > deadline) {
          interrupted = true;
          break;
        }
        if (runtime.hasPendingJob()) continue;
        if (inflight.size === 0) {
          loopError = {
            code: "RUN_EXCEPTION",
            message:
              "The snippet is waiting on a promise that nothing can settle: the sandbox has no timers or I/O of its own, only awaited r calls settle.",
          };
          break;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()) + 1);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }

      // A host call in flight at the deadline completes or fails on its own;
      // its side effect is real, so the run reports only after it settles.
      if (interrupted) await Promise.allSettled([...inflight]);

      outcome = settle(settled, loopError, interrupted, maxValueBytes, finish);
    }
  } catch (err) {
    poisoned = true;
    if (interrupted) await Promise.allSettled([...inflight]);
    const overflow = err instanceof RangeError && /call stack/i.test(err.message);
    outcome = settle(
      null,
      {
        code: "RUN_EXCEPTION",
        message: overflow
          ? "InternalError: stack overflow (the recursion is too deep for the sandbox)."
          : `The sandbox stopped: ${err instanceof Error ? err.message : String(err)}`,
      },
      interrupted,
      maxValueBytes,
      finish,
    );
  } finally {
    alive = false;
    if (!poisoned) {
      try {
        ctx.dispose();
        runtime.dispose();
      } catch {
        // The module instance is private to this run and is dropped either way.
      }
    }
  }
  return outcome;
}

function settle(
  settled: Settled | null,
  loopError: SandboxError | null,
  interrupted: boolean,
  maxValueBytes: number,
  finish: (fields: Partial<SandboxOutcome> & { status: "ok" | "error" }) => SandboxOutcome,
): SandboxOutcome {
  if (interrupted) {
    return finish({
      status: "error",
      error: { code: "RUN_TIMEOUT", message: "The run passed its deadline. Calls that completed before it are listed in calls[]; their side effects happened." },
    });
  }
  if (loopError) return finish({ status: "error", error: loopError });
  if (!settled) {
    return finish({ status: "error", error: { code: "RUN_EXCEPTION", message: "The snippet ended without settling." } });
  }
  switch (settled.kind) {
    case "undefined":
      return finish({ status: "ok", value_kind: "undefined" });
    case "not_serializable":
      return finish({ status: "error", error: { code: "RUN_VALUE_NOT_SERIALIZABLE", message: `The result is not JSON: ${settled.message}` } });
    case "ok": {
      const bytes = Buffer.byteLength(settled.json, "utf8");
      if (bytes > maxValueBytes) {
        return finish({
          status: "error",
          error: {
            code: "RUN_VALUE_TOO_LARGE",
            message: `The result serializes to ${bytes} bytes, over the ${maxValueBytes}-byte cap. Narrow the selection in the snippet (filter, map to the fields you need, or slice).`,
          },
        });
      }
      return finish({ status: "ok", value_json: settled.json });
    }
    case "error":
      return finish({ status: "error", error: classify(settled.thrown, { interrupted, phase: "run" }) });
  }
}

function classify(e: ThrownDescription, ctx: { interrupted: boolean; phase: "compile" | "run" }): SandboxError {
  const location = locationFromStack(e.stack);
  if (ctx.interrupted) {
    return { code: "RUN_TIMEOUT", message: "The run passed its deadline." };
  }
  if (/out of memory/i.test(e.message)) {
    return { code: "RUN_MEMORY_EXCEEDED", message: `The sandbox reached its ${SANDBOX_MEMORY_LIMIT_BYTES / (1024 * 1024)} MB memory limit.` };
  }
  if (ctx.phase === "compile" && e.name === "SyntaxError") {
    return { code: "RUN_SYNTAX_ERROR", message: e.message, line: location.line ?? 1, column: location.column ?? 1 };
  }
  const thrown: SandboxThrown = { name: e.name, message: e.message };
  if (e.code) thrown.code = e.code;
  if (e.error_ref) thrown.error_ref = e.error_ref;
  return {
    code: "RUN_EXCEPTION",
    message: e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message,
    ...location,
    thrown,
  };
}

function dumpError(ctx: QuickJSAsyncContext, handle: QuickJSHandle): ThrownDescription {
  let dumped: unknown;
  try {
    dumped = ctx.dump(handle);
  } catch {
    dumped = null;
  }
  if (dumped && typeof dumped === "object") {
    const d = dumped as Record<string, unknown>;
    return {
      name: typeof d.name === "string" ? d.name : "Error",
      message: typeof d.message === "string" ? d.message : String(d.message ?? ""),
      ...(typeof d.stack === "string" ? { stack: d.stack } : {}),
      ...(typeof d.code === "string" ? { code: d.code } : {}),
      ...(typeof d.error_ref === "string" ? { error_ref: d.error_ref } : {}),
    };
  }
  return { name: "Error", message: dumped === null || dumped === undefined ? "out of memory" : String(dumped) };
}

function readString(ctx: QuickJSAsyncContext, h: QuickJSHandle): string | undefined {
  return ctx.typeof(h) === "undefined" ? undefined : ctx.getString(h);
}
