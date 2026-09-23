/**
 * The chain proxy: how a `run` snippet reaches the SDK without the SDK ever
 * running inside the sandbox.
 *
 * Inside the sandbox, `r` is a recorder. A property access appends a `get`
 * segment and a call appends a `call` segment with its arguments; nothing
 * happens until the chain is awaited (its `then`, `catch`, or `finally` is
 * read), at which point the chain crosses to the host as JSON. The host
 * ({@link ChainHost}) replays it against the real client, built with
 * `surface: "sandbox"`, awaiting every intermediate that is a promise:
 *
 *     r.project("prj_1").functions.list()
 *       → get project → call ("prj_1") → get functions → get list → call ()
 *
 * The terminal value crosses back as JSON when it is JSON data. Anything else
 * (a `ScopedRun402` from `await r.project()`, a deploy operation) crosses as an
 * opaque handle that the recorder wraps again, so the snippet keeps chaining
 * from it; handles die with the run.
 *
 * Arguments cross into the host only when they are structured-cloneable data
 * (JSON values, `undefined`, `Date`, bytes, `Map`, `Set`, `BigInt`) or a handle.
 * A function, a symbol, a class instance, a cyclic structure, or an un-awaited
 * `r` chain is refused in the sandbox before anything is sent
 * (`RUN_ARGUMENT_NOT_CLONEABLE`), which is also why a filesystem source such as
 * a `LocalDirRef` cannot be expressed: `dir()` does not exist inside.
 *
 * The replay walks only the SDK's public surface. A property the SDK declares
 * `private` or `protected` (read from the SDK's own declaration files), a name
 * that starts with `_`, `constructor` / `prototype` / `__proto__`, and anything
 * that resolves on a JavaScript intrinsic (`Object.prototype`,
 * `Function.prototype`, `Array.prototype`, …) is refused, so a chain can reach
 * neither the host's `Function` constructor nor the kernel client and its
 * credential provider. Plain data returned by a call is navigable by its own
 * properties only.
 *
 * Every dispatched chain is one entry in `calls[]` with its dotted path, its
 * duration, and its outcome. An SDK error thrown during the replay crosses
 * back with its own `code`, `message`, and `next_actions`, plus an
 * `error_ref` that lets the `run` tool report the original error unchanged.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRun402Error } from "../sdk/dist/index.js";
import type { SandboxExtension } from "./sandbox.js";

/** `calls[]` entries retained per run. */
export const CHAIN_MAX_CALLS = 200;
/** The largest intermediate value one chain may carry back into the sandbox. */
export const CHAIN_MAX_TRANSFER_BYTES = 16 * 1024 * 1024;

export interface ChainCall {
  /** The dotted SDK path the chain replayed, e.g. `project.functions.list`. */
  path: string;
  duration_ms: number;
  ok: boolean;
  /** The error code when the call failed. */
  code?: string;
  /** The payment-attempt journal id, when the failure carried one. */
  payment_attempt_id?: string;
}

type Segment = { op: "get"; key: string } | { op: "call"; args: unknown[] };

interface HandleEntry {
  value: unknown;
  /** The receiver a function handle is called with. */
  receiver: unknown;
  /** The path that produced the handle, so chains from it read naturally in `calls[]`. */
  path: string;
  /** The same path as a snippet writes it, calls included, e.g. `r.project(…)`. */
  display: string;
}

/**
 * The in-sandbox half: defines `r` and keeps the host's `dispatch` in its
 * closure. Evaluated once per run by `runInSandbox`.
 */
const PROXY_INSTALL = String.raw`(function (host) {
  "use strict";
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const chains = new WeakMap();
  const TAG = "__r402";

  const label = (base, segments) => {
    let out = base.path;
    for (const s of segments) {
      if (s.op === "get") out = out ? out + "." + s.key : s.key;
      else out += "()";
    }
    return out || "r";
  };

  const notCloneable = (where, what) => {
    const e = new TypeError(
      "Argument " + where + " cannot cross into the host: " + what +
      ". Pass structured-cloneable data to r (JSON values, undefined, Date, Uint8Array, Map, Set, BigInt) or a handle.",
    );
    e.code = "RUN_ARGUMENT_NOT_CLONEABLE";
    return e;
  };

  const encode = (v, where, seen) => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : { [TAG]: { t: "number", v: String(v) } };
    if (v === undefined) return { [TAG]: { t: "undefined" } };
    if (typeof v === "bigint") return { [TAG]: { t: "bigint", v: String(v) } };
    if (typeof v === "symbol") throw notCloneable(where, "a symbol");
    if (typeof v === "function") {
      const chain = chains.get(v);
      if (!chain) throw notCloneable(where, "a function");
      if (chain.segments.length > 0) throw notCloneable(where, "an r call that was not awaited (" + label(chain.base, chain.segments) + ")");
      if (chain.base.id === "root") throw notCloneable(where, "r itself");
      return { [TAG]: { t: "handle", v: chain.base.id } };
    }
    if (seen.has(v)) throw notCloneable(where, "a cyclic structure");
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((x, i) => encode(x, where + "[" + i + "]", seen));
      if (v instanceof Date) return { [TAG]: { t: "date", v: v.getTime() } };
      if (v instanceof ArrayBuffer) return { [TAG]: { t: "bytes", v: Array.from(new Uint8Array(v)) } };
      if (ArrayBuffer.isView(v)) return { [TAG]: { t: "bytes", v: Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } };
      if (v instanceof Map) return { [TAG]: { t: "map", v: Array.from(v, ([k, x], i) => [encode(k, where + ".key" + i, seen), encode(x, where + ".get(" + i + ")", seen)]) } };
      if (v instanceof Set) return { [TAG]: { t: "set", v: Array.from(v, (x, i) => encode(x, where + ".item" + i, seen)) } };
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        const name = proto && proto.constructor && typeof proto.constructor.name === "string" ? proto.constructor.name : "an object";
        throw notCloneable(where, "an instance of " + name);
      }
      const out = {};
      for (const k of Object.keys(v)) out[k] = encode(v[k], where + "." + k, seen);
      return out;
    } finally {
      seen.delete(v);
    }
  };

  const decode = (v) => {
    if (Array.isArray(v)) return v.map(decode);
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === TAG) {
        const t = v[TAG];
        if (t.t === "bytes") return new Uint8Array(t.v);
        if (t.t === "handle") return makeChain({ id: t.v, path: t.path }, []);
        return undefined;
      }
      const out = {};
      for (const k of keys) out[k] = decode(v[k]);
      return out;
    }
    return v;
  };

  const makeError = (e) => {
    const err = new Error(String(e.message));
    err.name = String(e.name || "Error");
    for (const k of ["code", "kind", "status", "next_actions", "details", "retryable", "error_ref"]) {
      if (e[k] !== undefined && e[k] !== null) err[k] = e[k];
    }
    return err;
  };

  const send = (base, segments) =>
    host.dispatch(stringify({ base: base.id, segments })).then((raw) => {
      const res = parse(raw);
      if (res.ok) return decode(res.value);
      throw makeError(res.error);
    });

  const makeChain = (base, segments) => {
    let sent = null;
    const proxy = new Proxy(function () {}, {
      get(_target, key) {
        if (typeof key === "symbol") {
          if (key === Symbol.toPrimitive) return () => "[r " + label(base, segments) + "]";
          return undefined;
        }
        if (key === "then" || key === "catch" || key === "finally") {
          // A bare handle is a value, not a promise.
          if (segments.length === 0) return undefined;
          if (!sent) sent = send(base, segments);
          return (...a) => sent[key](...a);
        }
        if (key === "toJSON") return undefined;
        return makeChain(base, [...segments, { op: "get", key }]);
      },
      apply(_target, _receiver, args) {
        const where = label(base, segments);
        const seen = new Set();
        const encoded = args.map((a, i) => encode(a, where + " argument " + (i + 1), seen));
        return makeChain(base, [...segments, { op: "call", args: encoded }]);
      },
      set() { return false; },
      defineProperty() { return false; },
      deleteProperty() { return false; },
    });
    chains.set(proxy, { base, segments });
    return proxy;
  };

  Object.defineProperty(globalThis, "r", {
    value: makeChain({ id: "root", path: "" }, []),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})`;

// ─── what the replay may touch ───────────────────────────────────────────────

const ALWAYS_REFUSED = new Set(["constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "caller", "callee", "arguments"]);

/** JavaScript's own prototypes: a property that resolves on one of these is never reachable. */
const INTRINSIC_PROTOTYPES: ReadonlySet<object> = new Set<object>([
  Object.prototype, Function.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype,
  Symbol.prototype, BigInt.prototype, Date.prototype, RegExp.prototype, Error.prototype, Promise.prototype,
  Map.prototype, Set.prototype, WeakMap.prototype, WeakSet.prototype, ArrayBuffer.prototype,
  Object.getPrototypeOf(Uint8Array.prototype), Uint8Array.prototype, DataView.prototype,
  Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}),
  Object.getPrototypeOf(async function* () {}),
  Object.getPrototypeOf(Object.getPrototypeOf((function* () {})())),
  Object.getPrototypeOf(Object.getPrototypeOf((async function* () {})())),
  Object.getPrototypeOf((async function* () {})()),
  Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
]);

let privateMembers: Map<string, Set<string>> | null = null;

/**
 * Every `private` / `protected` member name the SDK declares, by class name,
 * read once from the SDK's declaration files (TypeScript's `private` is not
 * enforced at runtime, so the declaration is the only record of it).
 */
export function sdkPrivateMembers(): Map<string, Set<string>> {
  if (privateMembers) return privateMembers;
  const map = new Map<string, Set<string>>();
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "sdk", "dist");
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (name.endsWith(".d.ts")) {
        let current: string | null = null;
        for (const line of readFileSync(full, "utf8").split("\n")) {
          const cls = /^(?:export )?declare (?:abstract )?class (\w+)/.exec(line);
          if (cls) {
            current = cls[1];
            continue;
          }
          if (line === "}") {
            current = null;
            continue;
          }
          if (!current) continue;
          const member = /^ {4}(?:private|protected)(?: static)?(?: readonly)?(?: async)?(?: get| set)? (\w+)/.exec(line);
          if (member) {
            const set = map.get(current) ?? new Set<string>();
            set.add(member[1]);
            map.set(current, set);
          }
        }
      }
    }
  };
  visit(root);
  privateMembers = map;
  return map;
}

function isPlainData(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class RefusedProperty extends TypeError {}

/**
 * A member the SDK object does not have. Carries the closest public members,
 * so the run's error can say "did you mean" instead of "is not a function".
 */
export class UnknownMember extends TypeError {
  readonly code = "RUN_UNKNOWN_MEMBER";
  /**
   * @param path        the missing member as a snippet writes it, e.g. `r.project(…).sql`
   * @param suggestions full paths, as a snippet writes them, that do exist
   * @param members     the parent's public members
   */
  constructor(
    readonly path: string,
    readonly suggestions: string[],
    readonly members: string[],
  ) {
    super(
      suggestions.length > 0
        ? `${path} is not part of the SDK. Did you mean ${suggestions.join(" or ")}?`
        : `${path} is not part of the SDK. Its parent has: ${members.slice(0, 20).join(", ")}${members.length > 20 ? ", …" : ""}.`,
    );
    this.name = "UnknownMember";
  }
}

/** True for an SDK namespace object worth searching: an object, not plain data, not a function. */
function isNamespace(v: unknown): v is object {
  return typeof v === "object" && v !== null && !isPlainData(v);
}

function hasMember(holder: object, key: string): boolean {
  return publicMembers(holder).includes(key);
}

/**
 * Where else `key` lives, for a member the parent lacks: the parent's own
 * namespaces first (`r.project(…).projects.sql`), then the root and the root's
 * namespaces (`r.projects.sql`). Reads only public members of SDK objects.
 */
function findElsewhere(key: string, holder: object, parentDisplay: string, root: unknown): string[] {
  const found: string[] = [];
  const add = (p: string) => { if (!found.includes(p)) found.push(p); };
  for (const m of publicMembers(holder)) {
    const child = (holder as Record<string, unknown>)[m];
    if (isNamespace(child) && hasMember(child, key)) add(`${parentDisplay}.${m}.${key}`);
  }
  if (isNamespace(root) && root !== holder) {
    if (hasMember(root, key)) add(`r.${key}`);
    for (const m of publicMembers(root)) {
      const child = (root as Record<string, unknown>)[m];
      if (child !== holder && isNamespace(child) && hasMember(child, key)) add(`r.${m}.${key}`);
    }
  }
  return found.slice(0, 3);
}

/** The public members an SDK object offers: own and inherited, minus private, internal, and intrinsic ones. */
function publicMembers(holder: object): string[] {
  const out = new Set<string>();
  const privates = sdkPrivateMembers();
  for (let p: object | null = holder; p && !INTRINSIC_PROTOTYPES.has(p); p = Object.getPrototypeOf(p)) {
    const className = typeof p === "function" ? null : (p as { constructor?: { name?: unknown } }).constructor?.name;
    const hidden = typeof className === "string" ? privates.get(className) : undefined;
    for (const key of Object.getOwnPropertyNames(p)) {
      if (ALWAYS_REFUSED.has(key) || key.startsWith("_") || key.startsWith("#") || hidden?.has(key)) continue;
      if (typeof holder === "function" && (key === "length" || key === "name" || key === "arguments" || key === "caller")) continue;
      out.add(key);
    }
  }
  return [...out].sort();
}

/** Edit distance with adjacent transpositions (optimal string alignment). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** The members closest to `key`: case-insensitive match first, then small edit distance, then containment. At most three. */
export function closestMembers(key: string, members: string[]): string[] {
  const lower = key.toLowerCase();
  const scored: Array<{ m: string; score: number }> = [];
  for (const m of members) {
    const ml = m.toLowerCase();
    let score: number | null = null;
    if (ml === lower) score = 0;
    else {
      const dist = editDistance(lower, ml);
      if (dist <= Math.max(2, Math.floor(key.length / 3))) score = dist;
      else if (lower.length >= 3 && (ml.includes(lower) || lower.includes(ml))) score = 10;
    }
    if (score !== null) scored.push({ m, score });
  }
  return scored.sort((x, y) => x.score - y.score || x.m.localeCompare(y.m)).slice(0, 3).map((s) => s.m);
}

/** Read `key` from `holder` if the SDK's public surface allows it; throw otherwise. */
function readAllowed(holder: unknown, key: string, path: string, where: { display: string; root: unknown } = { display: path ? `r.${path}` : "r", root: undefined }): unknown {
  if (holder === null || holder === undefined) {
    throw new TypeError(`cannot read property '${key}' of ${String(holder)} (${path})`);
  }
  if (typeof holder !== "object" && typeof holder !== "function") {
    throw new RefusedProperty(`${path}.${key} is not part of the SDK surface (a ${typeof holder} has no SDK members)`);
  }
  if (ALWAYS_REFUSED.has(key) || key.startsWith("_") || key.startsWith("#")) {
    throw new RefusedProperty(`${path ? `${path}.` : ""}${key} is not part of the SDK surface`);
  }
  const obj = holder as Record<string, unknown>;
  // Plain data (what a call returned): its own properties only.
  if (typeof holder === "object" && isPlainData(holder)) {
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  }
  // An SDK object or function: find where the property lives.
  let owner: object | null = holder as object;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, key)) owner = Object.getPrototypeOf(owner);
  if (!owner) {
    // An SDK object has no such member: name the closest ones rather than
    // letting the next call fail as "is not a function".
    const members = publicMembers(holder as object);
    const near = closestMembers(key, members).map((m) => `${where.display}.${m}`);
    const suggestions = near.length > 0 ? near : findElsewhere(key, holder as object, where.display, where.root);
    throw new UnknownMember(`${where.display}.${key}`, suggestions, members);
  }
  if (INTRINSIC_PROTOTYPES.has(owner)) {
    throw new RefusedProperty(`${path ? `${path}.` : ""}${key} is not part of the SDK surface`);
  }
  const privates = sdkPrivateMembers();
  for (let p: object | null = typeof holder === "function" ? null : Object.getPrototypeOf(holder); p && !INTRINSIC_PROTOTYPES.has(p); p = Object.getPrototypeOf(p)) {
    const className = (p as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof className === "string" && privates.get(className)?.has(key)) {
      throw new RefusedProperty(`${path ? `${path}.` : ""}${key} is private to the SDK`);
    }
  }
  return obj[key];
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}

/** JSON data all the way down (the terminal-value test): no functions, no class instances. */
function isJsonData(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return true;
  if (v === undefined) return true;
  if (typeof v !== "object" || depth > 200) return false;
  if (Array.isArray(v)) return v.every((x) => isJsonData(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v as Record<string, unknown>).every((x) => isJsonData(x, depth + 1));
}

function describeError(err: unknown): { name: string; message: string; code?: string; kind?: string; status?: number | null; next_actions?: unknown; details?: unknown; retryable?: boolean } {
  if (isRun402Error(err)) {
    const e = err as unknown as { name: string; message: string; code?: string; kind?: string; status: number | null; nextActions?: unknown; details?: unknown; retryable?: boolean };
    return {
      name: e.name,
      message: e.message,
      ...(e.code ? { code: e.code } : {}),
      ...(e.kind ? { kind: e.kind } : {}),
      status: e.status,
      ...(e.nextActions !== undefined ? { next_actions: e.nextActions } : {}),
      ...(e.details !== undefined ? { details: e.details } : {}),
      ...(e.retryable !== undefined ? { retryable: e.retryable } : {}),
    };
  }
  if (err instanceof UnknownMember) return { name: err.name, message: err.message, code: err.code };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}

// ─── the host half ───────────────────────────────────────────────────────────

/**
 * Replays recorded chains against `root` (the real SDK client) for one run.
 * Holds that run's handles, its `calls[]` trace, and the original errors, and
 * forgets all of them at {@link dispose}.
 */
export class ChainHost {
  readonly calls: ChainCall[] = [];
  callsDropped = 0;
  readonly #root: unknown;
  readonly #handles = new Map<string, HandleEntry>();
  readonly #errors = new Map<string, unknown>();
  #nextHandle = 1;
  #nextError = 1;
  #inflight = 0;

  constructor(root: unknown) {
    this.#root = root;
  }

  /** The sandbox extension that installs `r` and routes its chains here. */
  extension(): SandboxExtension {
    return { install: PROXY_INSTALL, async: { dispatch: (raw) => this.dispatch(raw ?? "{}") } };
  }

  /** The original error behind an `error_ref` the sandbox reported, if it came from a replay. */
  errorFor(ref: string | undefined): unknown {
    return ref ? this.#errors.get(ref) : undefined;
  }

  /** How many chains are replaying right now. */
  get inflight(): number {
    return this.#inflight;
  }

  dispose(): void {
    this.#handles.clear();
    this.#errors.clear();
  }

  async dispatch(raw: string): Promise<string> {
    const started = Date.now();
    let req: { base: string; segments: Segment[] };
    try {
      req = JSON.parse(raw);
    } catch {
      return JSON.stringify({ ok: false, error: { name: "TypeError", message: "malformed chain" } });
    }
    let value: unknown;
    let receiver: unknown;
    let path: string;
    if (req.base === "root") {
      value = this.#root;
      receiver = undefined;
      path = "";
    } else {
      const handle = this.#handles.get(req.base);
      if (!handle) {
        return JSON.stringify({ ok: false, error: { name: "TypeError", message: "that handle belongs to another run" } });
      }
      value = handle.value;
      receiver = handle.receiver;
      path = handle.path;
    }
    for (const s of req.segments) if (s.op === "get") path = path ? `${path}.${s.key}` : s.key;
    const callPath = path || "r";
    let display = "r";

    this.#inflight++;
    try {
      let walked = req.base === "root" ? "" : (this.#handles.get(req.base)?.path ?? "");
      display = req.base === "root" ? "r" : (this.#handles.get(req.base)?.display ?? "r");
      for (const segment of req.segments) {
        if (segment.op === "get") {
          if (typeof segment.key !== "string") throw new RefusedProperty("only string property names cross into the host");
          const next = readAllowed(value, segment.key, walked, { display, root: this.#root });
          receiver = value;
          value = next;
          walked = walked ? `${walked}.${segment.key}` : segment.key;
          display = `${display}.${segment.key}`;
        } else {
          display = `${display}(…)`;
          if (typeof value !== "function") throw new TypeError(`${walked || "r"} is not a function`);
          const args = (segment.args ?? []).map((a) => this.#decodeArg(a));
          value = Reflect.apply(value as (...a: unknown[]) => unknown, receiver, args);
          receiver = undefined;
        }
        if (isThenable(value)) value = await value;
      }
    } catch (err) {
      const ref = `err_${this.#nextError++}`;
      this.#errors.set(ref, err);
      const described = describeError(err);
      const attempt = (err as { paymentAttemptId?: unknown })?.paymentAttemptId;
      this.#record({
        path: callPath,
        duration_ms: Date.now() - started,
        ok: false,
        code: described.code ?? described.name,
        ...(typeof attempt === "string" ? { payment_attempt_id: attempt } : {}),
      });
      return JSON.stringify({ ok: false, error: { ...described, error_ref: ref } });
    } finally {
      this.#inflight--;
    }

    this.#record({ path: callPath, duration_ms: Date.now() - started, ok: true });
    return this.#encodeResult(value, receiver, callPath, display);
  }

  #encodeResult(value: unknown, receiver: unknown, path: string, display: string): string {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      if (bytes.byteLength > CHAIN_MAX_TRANSFER_BYTES / 4) return this.#tooLarge(path, bytes.byteLength);
      return JSON.stringify({ ok: true, value: { __r402: { t: "bytes", v: Array.from(bytes) } } });
    }
    if (isJsonData(value)) {
      const json = value === undefined ? undefined : JSON.stringify(value);
      if (json !== undefined && json.length > CHAIN_MAX_TRANSFER_BYTES) return this.#tooLarge(path, json.length);
      return json === undefined ? JSON.stringify({ ok: true }) : `{"ok":true,"value":${json}}`;
    }
    const id = `h${this.#nextHandle++}`;
    this.#handles.set(id, { value, receiver, path, display });
    return JSON.stringify({ ok: true, value: { __r402: { t: "handle", v: id, path } } });
  }

  #tooLarge(path: string, bytes: number): string {
    return JSON.stringify({
      ok: false,
      error: {
        name: "RangeError",
        code: "RUN_VALUE_TOO_LARGE",
        message: `${path} returned ${bytes} bytes, over the ${CHAIN_MAX_TRANSFER_BYTES}-byte transfer cap. Ask the SDK for less (a filter, a limit, a page).`,
      },
    });
  }

  #record(call: ChainCall): void {
    if (this.calls.length >= CHAIN_MAX_CALLS) {
      this.callsDropped++;
      return;
    }
    this.calls.push(call);
  }

  #decodeArg(v: unknown): unknown {
    if (Array.isArray(v)) return v.map((x) => this.#decodeArg(x));
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === "__r402") {
        const tag = (v as { __r402: { t: string; v?: unknown } }).__r402;
        switch (tag.t) {
          case "undefined":
            return undefined;
          case "number":
            return Number(tag.v);
          case "bigint":
            return BigInt(String(tag.v));
          case "date":
            return new Date(Number(tag.v));
          case "bytes":
            return Uint8Array.from(tag.v as number[]);
          case "map":
            return new Map((tag.v as Array<[unknown, unknown]>).map(([k, x]) => [this.#decodeArg(k), this.#decodeArg(x)]));
          case "set":
            return new Set((tag.v as unknown[]).map((x) => this.#decodeArg(x)));
          case "handle": {
            const entry = this.#handles.get(String(tag.v));
            if (!entry) throw new TypeError("that handle belongs to another run");
            return entry.value;
          }
          default:
            throw new TypeError(`unknown argument tag ${String(tag.t)}`);
        }
      }
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = this.#decodeArg((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  }
}
