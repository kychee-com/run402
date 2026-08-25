// Session identity + task-from-thread-title resolution for the agent-messaging
// commands (presence-naming-ergonomics, run402-private tasks 2.2 / 3.1-3.2).
//
// Every source is best-effort and no source is load-bearing: this file pins
// that property by proving each source can be absent, wrong-shaped, or
// actively broken (a corrupt sqlite file, an unwritable cache directory)
// without the resolution ever throwing.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  resolveSessionKey,
  resolveTaskLabel,
  SESSION_KEY_OVERRIDE_ENV,
  TASK_FROM_TITLE_OPT_OUT_ENV,
} from "./cli/lib/harness-context.mjs";

let tempDir;
let cwd;
let homedirRoot;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-harnessctx-"));
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

  it("a cache file with no usable session_key field falls through to generating a fresh key", () => {
    mkdirSync(join(cwd, ".run402"), { recursive: true });
    writeFileSync(join(cwd, ".run402", "session-key.json"), JSON.stringify({ session_key: "" }));
    const out = resolveSessionKey({ env: {}, cwd });
    assert.equal(out.source, "generated");
  });

  it("an unwritable cache directory still returns a usable key for this run (best-effort persistence)", () => {
    const out = resolveSessionKey({
      env: {},
      cwd,
      mkdirSyncImpl: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    assert.equal(out.source, "generated");
    assert.match(out.key, /^[0-9a-f]{32}$/);
    assert.equal(existsSync(join(cwd, ".run402", "session-key.json")), false);
  });

  it("a readFileSync that throws on an existing cache path falls through to generating fresh rather than crashing", () => {
    mkdirSync(join(cwd, ".run402"), { recursive: true });
    writeFileSync(join(cwd, ".run402", "session-key.json"), JSON.stringify({ session_key: "cached-key" }));
    const out = resolveSessionKey({
      env: {},
      cwd,
      readFileSyncImpl: () => {
        throw new Error("EIO");
      },
    });
    assert.equal(out.source, "generated");
    assert.notEqual(out.key, "cached-key");
  });
});

// ---------------------------------------------------------------------------
// resolveTaskLabel — Claude Code thread-title source
// ---------------------------------------------------------------------------

function writeClaudeSessionFile(homedirRootDir, hostId, body) {
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
      existsSyncImpl: () => {
        throw new Error("must not be called when task is explicit");
      },
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
    assert.equal(out.task.length, 500);
    assert.equal(out.source, "claude_code_thread_title");
  });
});

// ---------------------------------------------------------------------------
// resolveTaskLabel — Codex thread-title source
// ---------------------------------------------------------------------------

function writeCodexStateDb(homedirRootDir, rows) {
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
    assert.equal(out.task.length, 500);
    assert.equal(out.source, "codex_thread_title");
  });
});
