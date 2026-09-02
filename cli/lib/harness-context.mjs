/**
 * Best-effort session + task identity sourced from the AI harness running
 * this CLI invocation (Claude Code or Codex) — no network call, every source
 * optional, the chain always terminates. Backs coordination-room presence
 * resumption in rooms-context.mjs (run402-private's
 * presence-naming-ergonomics, tasks 2.2 / 3.1-3.2).
 *
 * Session identity is what makes a presence RESUMABLE across a lost local
 * cache (a fresh checkout, a wiped .run402/, a restarted machine): the
 * gateway resumes a presence bound to the SAME session_key no matter how
 * long its TTL has silently decayed, so a session that can re-derive its OWN
 * key independently of any local file needs no cache at all to pick up where
 * it left off. Two genuinely concurrent sessions must NEVER derive the same
 * key — that is the regression this design exists to avoid — so
 * every source below is either a value the harness itself guarantees is
 * unique per session, or a value generated here and persisted only for THIS
 * checkout.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const SESSION_KEY_OVERRIDE_ENV = "RUN402_SESSION_KEY";
export const TASK_FROM_TITLE_OPT_OUT_ENV = "RUN402_NO_TASK_FROM_TITLE";
export const PROGRAM_OVERRIDE_ENV = "RUN402_PROGRAM";
export const MODEL_OVERRIDE_ENV = "RUN402_MODEL";
const SESSION_KEY_CACHE_RELATIVE_PATH = ".run402/session-key.json";
const CLAUDE_SESSIONS_DIR_PARTS = ["Library", "Application Support", "Claude", "claude-code-sessions"];
const CODEX_STATE_DB_PARTS = [".codex", "state_5.sqlite"];
const MAX_TITLE_SEARCH_DIRS = 2000;
const TASK_MAX_LENGTH = 500; // mirrors the gateway's own validateMeta cap — never send what it would reject.

function isTruthyEnvValue(raw) {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Resolve THIS session's opaque identity as an ordered chain with no network
 * call: explicit override -> Claude Code's own session id -> Codex's own
 * thread id -> a locally generated key persisted for this checkout. No
 * source is load-bearing — a harness that sets neither env var, or a
 * filesystem that refuses the write, still yields a usable key for this run.
 */
export function resolveSessionKey({
  env = process.env,
  cwd = process.cwd(),
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  writeFileSyncImpl = writeFileSync,
  mkdirSyncImpl = mkdirSync,
  randomBytesImpl = randomBytes,
} = {}) {
  const override = env[SESSION_KEY_OVERRIDE_ENV]?.trim();
  if (override) return { key: override, source: "env_override" };

  const claudeId = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claudeId) return { key: claudeId, source: "claude_code_session_id" };

  const codexId = env.CODEX_THREAD_ID?.trim();
  if (codexId) return { key: codexId, source: "codex_thread_id" };

  const keyPath = join(cwd, SESSION_KEY_CACHE_RELATIVE_PATH);
  try {
    if (existsSyncImpl(keyPath)) {
      const parsed = JSON.parse(readFileSyncImpl(keyPath, "utf8"));
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

/**
 * Best-effort presence labels sourced from the harness this CLI invocation
 * is running under (kygit-invite design D8) — `program`/`model` on
 * `rooms join`, the implicit registration inside `messages send`, and every
 * `repos invite`/`repos join` presence registration. Precedence: explicit
 * env overrides first (`RUN402_PROGRAM`/`RUN402_MODEL`), then `program`
 * inferred from the SAME harness signals {@link resolveSessionKey} already
 * trusts (`CLAUDE_CODE_SESSION_ID` or `CLAUDECODE` -> `"claude-code"`;
 * `CODEX_THREAD_ID` -> `"codex"`). `model` has no harness-exposed signal to
 * infer from today (open question in kygit-invite design.md) — it is
 * ALWAYS env-override-or-null, never guessed from `program`. Null stays
 * null in both fields: a placeholder label would be a Faithful breach.
 */
export function resolveHarnessLabels({ env = process.env } = {}) {
  const programOverride = env[PROGRAM_OVERRIDE_ENV]?.trim();
  const modelOverride = env[MODEL_OVERRIDE_ENV]?.trim();
  let program = programOverride || null;
  if (!program) {
    if (env.CLAUDE_CODE_SESSION_ID?.trim() || env.CLAUDECODE?.trim()) {
      program = "claude-code";
    } else if (env.CODEX_THREAD_ID?.trim()) {
      program = "codex";
    }
  }
  const model = modelOverride || null;
  return { program, model };
}

/**
 * Persist a session key into ANOTHER checkout's cache. `repos join` uses it
 * so the freshly cloned checkout resolves the SAME session identity the join
 * registered its presence under (kygit-invite design D5), instead of
 * generating a stranger's key on the first `messages wait` run there. Only
 * meaningful for the generated-key path — a harness-provided id is found in
 * the environment first regardless of cwd, so callers skip this for those
 * sources. Best-effort, never throws; returns whether the write landed.
 */
export function persistSessionKey(cwd, key, { mkdirSyncImpl = mkdirSync, writeFileSyncImpl = writeFileSync } = {}) {
  if (typeof key !== "string" || !key) return false;
  try {
    mkdirSyncImpl(join(cwd, ".run402"), { recursive: true });
    writeFileSyncImpl(join(cwd, SESSION_KEY_CACHE_RELATIVE_PATH), `${JSON.stringify({ session_key: key }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded-depth search for a file named `filename` under `root`. Stops at
 * the first match, or after MAX_TITLE_SEARCH_DIRS directories visited,
 * whichever comes first — this is best-effort enrichment, not a guarantee,
 * and must never become an unbounded walk of the user's home directory.
 */
function findFileByName(root, filename, { existsSyncImpl, readdirSyncImpl, maxDepth = 4 }) {
  if (!existsSyncImpl(root)) return null;
  const stack = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < MAX_TITLE_SEARCH_DIRS) {
    const { dir, depth } = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = readdirSyncImpl(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === filename) return join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: join(dir, entry.name), depth: depth + 1 });
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
function readClaudeCodeThreadTitle({ env, existsSyncImpl, readFileSyncImpl, readdirSyncImpl, homedirImpl }) {
  const hostId = env.CLAUDE_CODE_HOST_SESSION_ID?.trim();
  if (!hostId) return null;
  const root = join(homedirImpl(), ...CLAUDE_SESSIONS_DIR_PARTS);
  const found = findFileByName(root, `${hostId}.json`, { existsSyncImpl, readdirSyncImpl });
  if (!found) return null;
  try {
    const parsed = JSON.parse(readFileSyncImpl(found, "utf8"));
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
async function readCodexThreadTitle({ env, existsSyncImpl, homedirImpl }) {
  const threadId = env.CODEX_THREAD_ID?.trim();
  if (!threadId) return null;
  const dbPath = join(homedirImpl(), ...CODEX_STATE_DB_PARTS);
  if (!existsSyncImpl(dbPath)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT title FROM threads WHERE id = ?").get(threadId);
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
export async function resolveTaskLabel({
  explicitTask,
  env = process.env,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  readdirSyncImpl = readdirSync,
  homedirImpl = homedir,
} = {}) {
  const trimmed = typeof explicitTask === "string" ? explicitTask.trim() : "";
  if (trimmed) return { task: trimmed, source: "explicit" };
  if (isTruthyEnvValue(env[TASK_FROM_TITLE_OPT_OUT_ENV])) return { task: null, source: "opted_out" };

  const claude = readClaudeCodeThreadTitle({ env, existsSyncImpl, readFileSyncImpl, readdirSyncImpl, homedirImpl });
  if (claude) return { task: claude.slice(0, TASK_MAX_LENGTH), source: "claude_code_thread_title" };

  const codex = await readCodexThreadTitle({ env, existsSyncImpl, homedirImpl });
  if (codex) return { task: codex.slice(0, TASK_MAX_LENGTH), source: "codex_thread_title" };

  return { task: null, source: "none" };
}
