/**
 * Session identity + task-from-thread-title resolution for the MCP room
 * tools (presence-naming-ergonomics, run402-private tasks 2.2 / 3.1-3.2).
 * TypeScript port of the CLI's cli-harness-context.test.mjs — same sources,
 * same properties, plus getSessionKey's server-lifetime memoization, which
 * has no CLI analog (a CLI invocation and a process are the same thing; an
 * MCP server serves many tool calls across one long-lived process).
 *
 * Every source is best-effort and no source is load-bearing: this file pins
 * that property by proving each source can be absent, wrong-shaped, or
 * actively broken (a corrupt sqlite file, an unwritable cache directory)
 * without the resolution ever throwing.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  resolveSessionKey,
  getSessionKey,
  resolveTaskLabel,
  resolveHarnessLabels,
  _resetSessionKeyForTests,
  SESSION_KEY_OVERRIDE_ENV,
  TASK_FROM_TITLE_OPT_OUT_ENV,
  PROGRAM_OVERRIDE_ENV,
  MODEL_OVERRIDE_ENV,
} from "./harness-context.js";

let tempDir: string;
let cwd: string;
let homedirRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-mcp-harnessctx-"));
  cwd = join(tempDir, "checkout");
  homedirRoot = join(tempDir, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homedirRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveSessionKey
// ---------------------------------------------------------------------------

describe("resolveSessionKey — the ordered chain, no source load-bearing", () => {
  it("an explicit override wins over every harness id", () => {
    const out = resolveSessionKey({
      env: { [SESSION_KEY_OVERRIDE_ENV]: "  my-key  ", CLAUDE_CODE_SESSION_ID: "claude-1", CODEX_THREAD_ID: "codex-1" },
      cwd,
    });
    assert.deepEqual(out, { key: "my-key", source: "env_override" });
  });

  it("a whitespace-only override is treated as absent", () => {
    const out = resolveSessionKey({ env: { [SESSION_KEY_OVERRIDE_ENV]: "   ", CLAUDE_CODE_SESSION_ID: "claude-1" }, cwd });
    assert.equal(out.source, "claude_code_session_id");
  });

  it("Claude Code's own session id wins over Codex's and the generated fallback", () => {
    const out = resolveSessionKey({ env: { CLAUDE_CODE_SESSION_ID: "claude-1", CODEX_THREAD_ID: "codex-1" }, cwd });
    assert.deepEqual(out, { key: "claude-1", source: "claude_code_session_id" });
  });

  it("Codex's own thread id wins over the generated fallback when Claude Code's is absent", () => {
    const out = resolveSessionKey({ env: { CODEX_THREAD_ID: "codex-1" }, cwd });
    assert.deepEqual(out, { key: "codex-1", source: "codex_thread_id" });
  });

  it("with no harness id and no cache, generates a key and persists it under ./.run402/", () => {
    const out = resolveSessionKey({ env: {}, cwd });
    assert.equal(out.source, "generated");
    assert.match(out.key, /^[0-9a-f]{32}$/);
    const cachePath = join(cwd, ".run402", "session-key.json");
    assert.ok(existsSync(cachePath));
    assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), { session_key: out.key });
  });

  it("a second resolution with no harness id reuses the persisted key rather than generating a new one", () => {
    const first = resolveSessionKey({ env: {}, cwd });
    const second = resolveSessionKey({ env: {}, cwd });
    assert.equal(second.source, "generated_cached");
    assert.equal(second.key, first.key);
  });

  it("a malformed cache file falls through to generating a fresh key instead of throwing", () => {
    mkdirSync(join(cwd, ".run402"), { recursive: true });
    writeFileSync(join(cwd, ".run402", "session-key.json"), "{not json");
    const out = resolveSessionKey({ env: {}, cwd });
    assert.equal(out.source, "generated");
    assert.match(out.key, /^[0-9a-f]{32}$/);
  });

  it("an unwritable cache directory still returns a usable key for this run (best-effort persistence)", () => {
    const out = resolveSessionKey({
      env: {},
      cwd,
      mkdirSyncImpl: (() => {
        throw new Error("EACCES: permission denied");
      }) as unknown as typeof import("node:fs").mkdirSync,
    });
    assert.equal(out.source, "generated");
    assert.match(out.key, /^[0-9a-f]{32}$/);
    assert.equal(existsSync(join(cwd, ".run402", "session-key.json")), false);
  });
});

describe("getSessionKey — server-lifetime memoization (no CLI analog)", () => {
  beforeEach(() => _resetSessionKeyForTests());
  afterEach(() => _resetSessionKeyForTests());

  it("resolves once and reuses the SAME value across many calls, even if the environment changes underneath it", () => {
    const originalOverride = process.env[SESSION_KEY_OVERRIDE_ENV];
    const originalCwd = process.cwd();
    try {
      process.env[SESSION_KEY_OVERRIDE_ENV] = "server-lifetime-key";
      process.chdir(cwd);
      const first = getSessionKey();
      assert.equal(first.key, "server-lifetime-key");
      // Change the environment AFTER the first resolution — a real server
      // never does this, but it is exactly what proves memoization: a second
      // call must NOT re-read process.env.
      process.env[SESSION_KEY_OVERRIDE_ENV] = "a-different-key-entirely";
      const second = getSessionKey();
      assert.equal(second.key, "server-lifetime-key", "memoized — must not re-resolve from the now-changed env");
      assert.equal(second, first, "the exact same object, not just an equal one");
    } finally {
      process.chdir(originalCwd);
      if (originalOverride === undefined) delete process.env[SESSION_KEY_OVERRIDE_ENV];
      else process.env[SESSION_KEY_OVERRIDE_ENV] = originalOverride;
    }
  });
});

// ---------------------------------------------------------------------------
// resolveHarnessLabels (kygit-invite design D8)
// ---------------------------------------------------------------------------

describe("resolveHarnessLabels — env overrides first, then harness inference, null stays null", () => {
  it("with no env at all, both labels are null", () => {
    assert.deepEqual(resolveHarnessLabels({ env: {} }), { program: null, model: null });
  });

  it("infers claude-code from CLAUDE_CODE_SESSION_ID", () => {
    assert.deepEqual(resolveHarnessLabels({ env: { CLAUDE_CODE_SESSION_ID: "claude-1" } }), { program: "claude-code", model: null });
  });

  it("infers claude-code from CLAUDECODE alone", () => {
    assert.deepEqual(resolveHarnessLabels({ env: { CLAUDECODE: "1" } }), { program: "claude-code", model: null });
  });

  it("infers codex from CODEX_THREAD_ID", () => {
    assert.deepEqual(resolveHarnessLabels({ env: { CODEX_THREAD_ID: "codex-1" } }), { program: "codex", model: null });
  });

  it("RUN402_PROGRAM overrides the inferred harness signal", () => {
    const out = resolveHarnessLabels({ env: { [PROGRAM_OVERRIDE_ENV]: "my-harness", CLAUDE_CODE_SESSION_ID: "claude-1" } });
    assert.equal(out.program, "my-harness");
  });

  it("model is ALWAYS env-override-or-null — never inferred from the harness, even when program is", () => {
    const out = resolveHarnessLabels({ env: { CLAUDE_CODE_SESSION_ID: "claude-1" } });
    assert.equal(out.model, null);
  });

  it("RUN402_MODEL sets model independently of program", () => {
    const out = resolveHarnessLabels({ env: { [MODEL_OVERRIDE_ENV]: "fable-5" } });
    assert.deepEqual(out, { program: null, model: "fable-5" });
  });

  it("both overrides together win outright, no harness signals consulted", () => {
    const out = resolveHarnessLabels({
      env: { [PROGRAM_OVERRIDE_ENV]: "my-harness", [MODEL_OVERRIDE_ENV]: "my-model", CLAUDE_CODE_SESSION_ID: "claude-1", CODEX_THREAD_ID: "codex-1" },
    });
    assert.deepEqual(out, { program: "my-harness", model: "my-model" });
  });
});

// ---------------------------------------------------------------------------
// resolveTaskLabel — Claude Code thread-title source
// ---------------------------------------------------------------------------

function writeClaudeSessionFile(homedirRootDir: string, hostId: string, body: Record<string, unknown>): void {
  // Mirrors the real two-level nesting under
  // ~/Library/Application Support/Claude/claude-code-sessions/<a>/<b>/<hostId>.json
  // without assuming the exact prefix ids are predictable.
  const dir = join(homedirRootDir, "Library", "Application Support", "Claude", "claude-code-sessions", "wsA", "winB");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hostId}.json`), JSON.stringify(body));
}

describe("resolveTaskLabel — explicit task, opt-out, and the harness-title sources", () => {
  it("an explicit task wins outright and touches no filesystem source", async () => {
    const out = await resolveTaskLabel({
      explicitTask: "  fix login bug  ",
      env: { CLAUDE_CODE_HOST_SESSION_ID: "host-1" },
      existsSyncImpl: (() => {
        throw new Error("must not be called when task is explicit");
      }) as unknown as typeof import("node:fs").existsSync,
    });
    assert.deepEqual(out, { task: "fix login bug", source: "explicit" });
  });

  it("the opt-out env var short-circuits to no task even when a title is resolvable", async () => {
    writeClaudeSessionFile(homedirRoot, "host-1", { title: "Decide fate of orphaned GitVault vaults" });
    const out = await resolveTaskLabel({
      env: { CLAUDE_CODE_HOST_SESSION_ID: "host-1", [TASK_FROM_TITLE_OPT_OUT_ENV]: "1" },
      homedirImpl: () => homedirRoot,
    });
    assert.deepEqual(out, { task: null, source: "opted_out" });
  });

  it("sources the task from Claude Code's own thread title when no explicit task was given", async () => {
    writeClaudeSessionFile(homedirRoot, "host-1", { title: "Decide fate of orphaned GitVault vaults" });
    const out = await resolveTaskLabel({
      env: { CLAUDE_CODE_HOST_SESSION_ID: "host-1" },
      homedirImpl: () => homedirRoot,
    });
    assert.deepEqual(out, { task: "Decide fate of orphaned GitVault vaults", source: "claude_code_thread_title" });
  });

  it("no CLAUDE_CODE_HOST_SESSION_ID at all yields no task (never guesses a session)", async () => {
    const out = await resolveTaskLabel({ env: {}, homedirImpl: () => homedirRoot });
    assert.deepEqual(out, { task: null, source: "none" });
  });

  it("a host session id with no matching file falls through to no task, never throws", async () => {
    const out = await resolveTaskLabel({
      env: { CLAUDE_CODE_HOST_SESSION_ID: "no-such-session" },
      homedirImpl: () => homedirRoot,
    });
    assert.deepEqual(out, { task: null, source: "none" });
  });

  it("a matching file with a blank title falls through to no task", async () => {
    writeClaudeSessionFile(homedirRoot, "host-1", { title: "   " });
    const out = await resolveTaskLabel({
      env: { CLAUDE_CODE_HOST_SESSION_ID: "host-1" },
      homedirImpl: () => homedirRoot,
    });
    assert.deepEqual(out, { task: null, source: "none" });
  });

  it("a matching file that is not valid JSON falls through to no task instead of throwing", async () => {
    const dir = join(homedirRoot, "Library", "Application Support", "Claude", "claude-code-sessions", "wsA", "winB");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "host-1.json"), "{not json");
    const out = await resolveTaskLabel({
      env: { CLAUDE_CODE_HOST_SESSION_ID: "host-1" },
      homedirImpl: () => homedirRoot,
    });
    assert.deepEqual(out, { task: null, source: "none" });
  });

  it("truncates an oversized title to the gateway's own 500-char task limit", async () => {
    writeClaudeSessionFile(homedirRoot, "host-1", { title: "x".repeat(700) });
    const out = await resolveTaskLabel({
      env: { CLAUDE_CODE_HOST_SESSION_ID: "host-1" },
      homedirImpl: () => homedirRoot,
    });
    assert.equal(out.task?.length, 500);
    assert.equal(out.source, "claude_code_thread_title");
  });

  it("a mid-session title change is picked up on the NEXT call — deliberately not memoized like getSessionKey", async () => {
    writeClaudeSessionFile(homedirRoot, "host-1", { title: "first task" });
    const first = await resolveTaskLabel({ env: { CLAUDE_CODE_HOST_SESSION_ID: "host-1" }, homedirImpl: () => homedirRoot });
    assert.equal(first.task, "first task");
    writeClaudeSessionFile(homedirRoot, "host-1", { title: "renamed mid-thread" });
    const second = await resolveTaskLabel({ env: { CLAUDE_CODE_HOST_SESSION_ID: "host-1" }, homedirImpl: () => homedirRoot });
    assert.equal(second.task, "renamed mid-thread");
  });
});

// ---------------------------------------------------------------------------
// resolveTaskLabel — Codex's own thread-title source
// ---------------------------------------------------------------------------

function writeCodexStateDb(homedirRootDir: string, rows: Array<[string, string]>): string {
  const dir = join(homedirRootDir, ".codex");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO threads (id, title) VALUES (?, ?)");
  for (const [id, title] of rows) insert.run(id, title);
  db.close();
  return dbPath;
}

describe("resolveTaskLabel — Codex's own thread-store source", () => {
  it("sources the task from Codex's threads.title for CODEX_THREAD_ID, via real node:sqlite", async () => {
    writeCodexStateDb(homedirRoot, [["thread-abc", "diagnosing the MPP settlement deploy-gateway red"]]);
    const out = await resolveTaskLabel({
      env: { CODEX_THREAD_ID: "thread-abc" },
      homedirImpl: () => homedirRoot,
    });
    assert.deepEqual(out, { task: "diagnosing the MPP settlement deploy-gateway red", source: "codex_thread_title" });
  });

  it("Claude Code's title wins when BOTH env vars are somehow present (nested-harness edge case)", async () => {
    writeClaudeSessionFile(homedirRoot, "host-1", { title: "claude title" });
    writeCodexStateDb(homedirRoot, [["thread-abc", "codex title"]]);
    const out = await resolveTaskLabel({
      env: { CLAUDE_CODE_HOST_SESSION_ID: "host-1", CODEX_THREAD_ID: "thread-abc" },
      homedirImpl: () => homedirRoot,
    });
    assert.equal(out.task, "claude title");
    assert.equal(out.source, "claude_code_thread_title");
  });

  it("no CODEX_THREAD_ID at all yields no task", async () => {
    writeCodexStateDb(homedirRoot, [["thread-abc", "some title"]]);
    const out = await resolveTaskLabel({ env: {}, homedirImpl: () => homedirRoot });
    assert.deepEqual(out, { task: null, source: "none" });
  });

  it("a thread id with no matching row falls through to no task", async () => {
    writeCodexStateDb(homedirRoot, [["thread-other", "some title"]]);
    const out = await resolveTaskLabel({
      env: { CODEX_THREAD_ID: "thread-abc" },
      homedirImpl: () => homedirRoot,
    });
    assert.deepEqual(out, { task: null, source: "none" });
  });

  it("a missing state_5.sqlite file falls through to no task instead of throwing", async () => {
    const out = await resolveTaskLabel({
      env: { CODEX_THREAD_ID: "thread-abc" },
      homedirImpl: () => homedirRoot,
    });
    assert.deepEqual(out, { task: null, source: "none" });
  });

  it("a corrupt (non-sqlite) state_5.sqlite file falls through to no task rather than crashing", async () => {
    const dir = join(homedirRoot, ".codex");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state_5.sqlite"), "this is not a sqlite file");
    const out = await resolveTaskLabel({
      env: { CODEX_THREAD_ID: "thread-abc" },
      homedirImpl: () => homedirRoot,
    });
    assert.deepEqual(out, { task: null, source: "none" });
  });

  it("truncates an oversized Codex title to the gateway's own 500-char task limit", async () => {
    writeCodexStateDb(homedirRoot, [["thread-abc", "y".repeat(700)]]);
    const out = await resolveTaskLabel({
      env: { CODEX_THREAD_ID: "thread-abc" },
      homedirImpl: () => homedirRoot,
    });
    assert.equal(out.task?.length, 500);
    assert.equal(out.source, "codex_thread_title");
  });
});
