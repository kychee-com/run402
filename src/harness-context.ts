/**
 * Best-effort session + task identity sourced from the AI harness hosting
 * this MCP server — no network call, every source optional, the chain always
 * terminates. TypeScript port of the CLI's `cli/lib/harness-context.mjs` for
 * the same mechanism (presence-naming-ergonomics, run402-private tasks 2.2 /
 * 3.1-3.2): `cli/` is source, not shipped — `run402-mcp`'s package.json
 * `files` list is `dist` + `core/dist` + `sdk/dist` + `sdk/core-dist` +
 * `schemas`, so the CLI's copy is not importable at runtime here, same
 * reason `rooms-shared.ts` carries its own room-addressing logic instead of
 * importing the CLI's.
 *
 * The env var names and on-disk cache path (`.run402/session-key.json`,
 * relative to the SERVER's cwd — see `rooms-shared.ts`'s own note on why that
 * is the right default and its real limit) are IDENTICAL to the CLI's, on
 * purpose: a harness that sets RUN402_SESSION_KEY, or a checkout that already
 * has a generated key on disk from a prior CLI invocation, gets the same
 * resumable identity through either surface.
 *
 * Session identity is what makes a presence RESUMABLE across a lost server
 * process (an MCP server restart has no memory of what it registered last
 * time — `rooms-shared.ts`'s presence cache is in-memory, process-lifetime
 * only): the gateway resumes a presence bound to the SAME session_key no
 * matter how long its TTL has silently decayed, so a restarted server that
 * can re-derive its OWN key independently of any in-process cache needs no
 * cache at all to pick up where it left off. Two genuinely concurrent server
 * instances must NEVER derive the same key — that is the regression this
 * design exists to avoid — so every source below
 * is either a value the harness itself guarantees is unique per session, or
 * a value generated here and persisted only for THIS checkout.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const SESSION_KEY_OVERRIDE_ENV = "RUN402_SESSION_KEY";
export const TASK_FROM_TITLE_OPT_OUT_ENV = "RUN402_NO_TASK_FROM_TITLE";
const SESSION_KEY_CACHE_RELATIVE_PATH = ".run402/session-key.json";
const CLAUDE_SESSIONS_DIR_PARTS = ["Library", "Application Support", "Claude", "claude-code-sessions"];
const CODEX_STATE_DB_PARTS = [".codex", "state_5.sqlite"];
const MAX_TITLE_SEARCH_DIRS = 2000;
const TASK_MAX_LENGTH = 500; // mirrors the gateway's own validateMeta cap — never send what it would reject.

export interface SessionKeyResolution {
  key: string;
  source: "env_override" | "claude_code_session_id" | "codex_thread_id" | "generated_cached" | "generated";
}

export interface TaskLabelResolution {
  task: string | null;
  source: "explicit" | "opted_out" | "claude_code_thread_title" | "codex_thread_title" | "none";
}

function isTruthyEnvValue(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Resolve THIS server process's opaque identity as an ordered chain with no
 * network call: explicit override -> Claude Code's own session id -> Codex's
 * own thread id -> a locally generated key persisted for this checkout. No
 * source is load-bearing — a harness that sets neither env var, or a
 * filesystem that refuses the write, still yields a usable key for this run.
 *
 * NOT memoized here (see {@link getSessionKey} for the server-lifetime
 * memoization) so the function stays a pure, directly-testable resolver —
 * matching the CLI's own `resolveSessionKey` shape exactly.
 */
export function resolveSessionKey(opts: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  existsSyncImpl?: typeof existsSync;
  readFileSyncImpl?: typeof readFileSync;
  writeFileSyncImpl?: typeof writeFileSync;
  mkdirSyncImpl?: typeof mkdirSync;
  randomBytesImpl?: typeof randomBytes;
} = {}): SessionKeyResolution {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const existsSyncImpl = opts.existsSyncImpl ?? existsSync;
  const readFileSyncImpl = opts.readFileSyncImpl ?? readFileSync;
  const writeFileSyncImpl = opts.writeFileSyncImpl ?? writeFileSync;
  const mkdirSyncImpl = opts.mkdirSyncImpl ?? mkdirSync;
  const randomBytesImpl = opts.randomBytesImpl ?? randomBytes;

  const override = env[SESSION_KEY_OVERRIDE_ENV]?.trim();
  if (override) return { key: override, source: "env_override" };

  const claudeId = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claudeId) return { key: claudeId, source: "claude_code_session_id" };

  const codexId = env.CODEX_THREAD_ID?.trim();
  if (codexId) return { key: codexId, source: "codex_thread_id" };

  const keyPath = join(cwd, SESSION_KEY_CACHE_RELATIVE_PATH);
  try {
    if (existsSyncImpl(keyPath)) {
      const parsed = JSON.parse(readFileSyncImpl(keyPath, "utf8")) as { session_key?: unknown };
      if (typeof parsed?.session_key === "string" && parsed.session_key) {
        return { key: parsed.session_key, source: "generated_cached" };
      }
    }
  } catch {
    // Malformed or unreadable cache: fall through to generating a fresh one.
  }
  const generated = randomBytesImpl(16).toString("hex");
  try {
    mkdirSyncImpl(join(cwd, ".run402"), { recursive: true });
    writeFileSyncImpl(keyPath, `${JSON.stringify({ session_key: generated }, null, 2)}\n`);
  } catch {
    // Best-effort persistence: an unwritable checkout still gets a usable
    // (if not durable-across-invocations) key for this one run.
  }
  return { key: generated, source: "generated" };
}

let sessionKeyMemo: SessionKeyResolution | undefined;

/**
 * This SERVER PROCESS's session identity, resolved once (lazily, on first
 * use) and reused for its entire lifetime. An MCP server is one continuous
 * session for as long as it runs — unlike the CLI, where "once per process"
 * and "once per invocation" are the same thing, here they are not, and the
 * whole point of a stable session_key is that it stays stable across the
 * many tool calls one server instance serves, not just within one.
 */
export function getSessionKey(): SessionKeyResolution {
  if (sessionKeyMemo === undefined) sessionKeyMemo = resolveSessionKey();
  return sessionKeyMemo;
}

/** Reset the cached session key. Test-only (matches `sdk.ts`'s `_resetSdk`). */
export function _resetSessionKeyForTests(): void {
  sessionKeyMemo = undefined;
}

/**
 * Bounded-depth search for a file named `filename` under `root`. Stops at
 * the first match, or after MAX_TITLE_SEARCH_DIRS directories visited,
 * whichever comes first — this is best-effort enrichment, not a guarantee,
 * and must never become an unbounded walk of the user's home directory.
 */
function findFileByName(
  root: string,
  filename: string,
  opts: { existsSyncImpl: typeof existsSync; readdirSyncImpl: typeof readdirSync; maxDepth?: number },
): string | null {
  const maxDepth = opts.maxDepth ?? 4;
  if (!opts.existsSyncImpl(root)) return null;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < MAX_TITLE_SEARCH_DIRS) {
    const next = stack.pop()!;
    visited += 1;
    let entries: Dirent[];
    try {
      entries = opts.readdirSyncImpl(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === filename) return join(next.dir, entry.name);
      if (entry.isDirectory() && next.depth < maxDepth) {
        stack.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
      }
    }
  }
  return null;
}

/**
 * Claude Code's own per-session metadata store — one JSON file named
 * `<CLAUDE_CODE_HOST_SESSION_ID>.json`, holding (among other fields) `title`:
 * the human-meaningful, user-renamable thread title shown in the app. Its
 * exact parent directories are two harness-assigned ids this function does
 * not try to predict; it searches for the leaf filename instead, bounded and
 * best-effort.
 */
function readClaudeCodeThreadTitle(opts: {
  env: NodeJS.ProcessEnv;
  existsSyncImpl: typeof existsSync;
  readFileSyncImpl: typeof readFileSync;
  readdirSyncImpl: typeof readdirSync;
  homedirImpl: typeof homedir;
}): string | null {
  const hostId = opts.env.CLAUDE_CODE_HOST_SESSION_ID?.trim();
  if (!hostId) return null;
  const root = join(opts.homedirImpl(), ...CLAUDE_SESSIONS_DIR_PARTS);
  const found = findFileByName(root, `${hostId}.json`, opts);
  if (!found) return null;
  try {
    const parsed = JSON.parse(opts.readFileSyncImpl(found, "utf8")) as { title?: unknown };
    const title = parsed?.title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Codex's own local thread store (a SQLite file under its home directory) —
 * `threads.title` for the id `CODEX_THREAD_ID` names. Read via Node's
 * built-in `node:sqlite`; guarded by dynamic import so an older runtime that
 * lacks it — or any other read failure — degrades to "no title" rather than
 * a crash. Opened read-only: this must never create a WAL file or take a
 * write lock on a store Codex itself may be actively writing to.
 */
async function readCodexThreadTitle(opts: {
  env: NodeJS.ProcessEnv;
  existsSyncImpl: typeof existsSync;
  homedirImpl: typeof homedir;
}): Promise<string | null> {
  const threadId = opts.env.CODEX_THREAD_ID?.trim();
  if (!threadId) return null;
  const dbPath = join(opts.homedirImpl(), ...CODEX_STATE_DB_PARTS);
  if (!opts.existsSyncImpl(dbPath)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT title FROM threads WHERE id = ?").get(threadId) as
        | { title?: unknown }
        | undefined;
      const title = row?.title;
      return typeof title === "string" && title.trim() ? title.trim() : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Best-effort "what is this session working on", sourced from the harness's
 * own thread title when the caller did not pass an explicit `task`. Design
 * D1a (presence-naming-ergonomics): the thread title is the best
 * "what am I working on" string in the system — automatic, human-meaningful,
 * already maintained by the user — and the schema already has the right
 * slot for it (`task` is display-only and already refreshed on every
 * coordination call).
 *
 * Deliberately NOT memoized across calls (unlike {@link getSessionKey}): a
 * long-lived server should reflect a mid-conversation thread rename on the
 * NEXT tool call, not freeze the label at whatever it read on server start.
 *
 * Never throws and never blocks meaningfully on a slow or failing read:
 * every source here is either a fast env-var check or a single best-effort
 * file/DB read, and any failure just leaves the explicit `task` (possibly
 * absent) untouched.
 *
 * A thread title is user-authored prose this publishes into a shared org
 * room the instant it is sent — `RUN402_NO_TASK_FROM_TITLE=1` opts out
 * entirely, matching design task 3.2's "never send a title for a room the
 * session did not deliberately join".
 */
export async function resolveTaskLabel(opts: {
  explicitTask?: string;
  env?: NodeJS.ProcessEnv;
  existsSyncImpl?: typeof existsSync;
  readFileSyncImpl?: typeof readFileSync;
  readdirSyncImpl?: typeof readdirSync;
  homedirImpl?: typeof homedir;
} = {}): Promise<TaskLabelResolution> {
  const env = opts.env ?? process.env;
  const existsSyncImpl = opts.existsSyncImpl ?? existsSync;
  const readFileSyncImpl = opts.readFileSyncImpl ?? readFileSync;
  const readdirSyncImpl = opts.readdirSyncImpl ?? readdirSync;
  const homedirImpl = opts.homedirImpl ?? homedir;

  const trimmed = typeof opts.explicitTask === "string" ? opts.explicitTask.trim() : "";
  if (trimmed) return { task: trimmed, source: "explicit" };
  if (isTruthyEnvValue(env[TASK_FROM_TITLE_OPT_OUT_ENV])) return { task: null, source: "opted_out" };

  const claude = readClaudeCodeThreadTitle({ env, existsSyncImpl, readFileSyncImpl, readdirSyncImpl, homedirImpl });
  if (claude) return { task: claude.slice(0, TASK_MAX_LENGTH), source: "claude_code_thread_title" };

  const codex = await readCodexThreadTitle({ env, existsSyncImpl, homedirImpl });
  if (codex) return { task: codex.slice(0, TASK_MAX_LENGTH), source: "codex_thread_title" };

  return { task: null, source: "none" };
}
