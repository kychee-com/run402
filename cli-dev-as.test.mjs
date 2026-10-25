/**
 * cli-dev-as.test.mjs — `run402 dev --as <label>` mints a test session with
 * the keys the dev server runs on and hands the @run402/astro dev-session
 * middleware only what it needs.
 *
 * Run:  node --test cli-dev-as.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-dev-as-"));
const saved = { config: process.env.RUN402_CONFIG_DIR, api: process.env.RUN402_API_BASE, fetch: globalThis.fetch };
process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = "https://api.example.test";

const { devBanner, mintDevTestSession, restartRunningDevServer, runningAstroDevServer } = await import("./cli/lib/dev.mjs");

const BUNDLE = {
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    label: "alice",
    email: "alice@prj_family.test.invalid",
    is_test: true,
    is_admin: false,
    created: false,
    created_at: "2026-10-25T09:00:00.000Z",
    email_verified_at: "2026-10-25T09:00:00.000Z",
  },
  session: {
    cookie_name: "__Host-Http-r402_session",
    cookie_value: "v1.s.secret",
    session_id: "sess_1",
    amr: ["test_session"],
    auth_time: "2026-10-25T09:30:00.000Z",
    expires_at: "2026-10-25T11:30:00.000Z",
    hard_expires_at: "2026-10-25T11:30:00.000Z",
  },
  access_token: "header.payload.sig",
  token_type: "bearer",
  expires_in: 3600,
  app_origins: ["https://family.run402.app"],
  examples: { ssr: "", rest: "" },
  test_mode: {},
};

describe("mintDevTestSession", () => {
  const calls = [];
  before(() => {
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method, headers: { ...(init?.headers ?? {}) }, body: init?.body });
      return new Response(JSON.stringify(BUNDLE), { status: 201, headers: { "content-type": "application/json" } });
    };
  });
  after(() => {
    globalThis.fetch = saved.fetch;
    if (saved.config === undefined) delete process.env.RUN402_CONFIG_DIR;
    else process.env.RUN402_CONFIG_DIR = saved.config;
    if (saved.api === undefined) delete process.env.RUN402_API_BASE;
    else process.env.RUN402_API_BASE = saved.api;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("mints with the env keys (no wallet, no keystore) and keeps only what the dev server needs", async () => {
    const session = await mintDevTestSession({
      projectId: "prj_family",
      label: "alice",
      keys: { anon_key: "anon_env", service_key: "service_env" },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.test/auth/v1/test-sessions");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.Authorization, "Bearer service_env");
    assert.equal(calls[0].headers.apikey, "anon_env");
    assert.equal(calls[0].headers["SIGN-IN-WITH-X"], undefined);
    assert.deepEqual(JSON.parse(calls[0].body), { label: "alice" });

    assert.deepEqual(Object.keys(session).sort(), ["access_token", "expires_at", "project_id", "session", "user"]);
    assert.equal(session.project_id, "prj_family");
    assert.deepEqual(session.user, { id: BUNDLE.user.id, label: "alice", email: BUNDLE.user.email, email_verified: true });
    assert.deepEqual(session.session, { session_id: "sess_1", amr: ["test_session"], auth_time: BUNDLE.session.auth_time });
    assert.equal(session.access_token, "header.payload.sig");
    assert.equal(JSON.stringify(session).includes("v1.s.secret"), false, "the cookie value is not handed over");
    assert.ok(Date.parse(session.expires_at) <= Date.parse(BUNDLE.session.hard_expires_at));
  });

  it("refuses an email as the label before any request", async () => {
    const before = calls.length;
    await assert.rejects(
      mintDevTestSession({ projectId: "prj_family", label: "alice@example.com", keys: { anon_key: "a", service_key: "s" } }),
      /label must match/,
    );
    assert.equal(calls.length, before);
  });
});

describe("the dev banner", () => {
  const base = { host: "localhost", port: "4321", projectId: "prj_family", apiBase: "https://api.example.test", envLoaded: true };

  it("prints the test user's id and a role-row hint naming it", () => {
    const lines = devBanner({
      ...base,
      signedInAs: { user: { id: BUNDLE.user.id, email: BUNDLE.user.email }, expires_at: "2026-10-25T10:30:00.000Z" },
    });
    assert.ok(lines.includes(`  signed in as: ${BUNDLE.user.email} (test user, until 2026-10-25T10:30:00.000Z)`));
    assert.ok(lines.includes(`  user id:  ${BUNDLE.user.id}`));
    const hint = lines.find((l) => l.startsWith("  give it a role: "));
    assert.ok(hint?.includes(`VALUES ('${BUNDLE.user.id}', '<role>')`), hint);
  });

  it("prints no identity lines without --as", () => {
    const lines = devBanner({ ...base, signedInAs: null });
    assert.equal(lines.length, 4);
    assert.ok(!lines.some((l) => l.includes("user id")));
  });
});

describe("a dev server Astro already runs is restarted, so the new identity applies", () => {
  function projectWithLock(lock) {
    const dir = mkdtempSync(join(tmpdir(), "run402-dev-lock-"));
    if (lock !== undefined) {
      mkdirSync(join(dir, ".astro"));
      writeFileSync(join(dir, ".astro", "dev.json"), JSON.stringify(lock));
    }
    return dir;
  }

  it("reads a live server from Astro's lock file", () => {
    const dir = projectWithLock({ pid: process.pid, url: "http://localhost:4321/", background: true });
    assert.deepEqual(runningAstroDevServer(dir), { pid: process.pid, url: "http://localhost:4321/", background: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores a missing lock file, a dead pid and a malformed lock", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    for (const lock of [undefined, { pid: dead }, { pid: "nope" }]) {
      const dir = projectWithLock(lock);
      assert.equal(runningAstroDevServer(dir), null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops the running server with astro dev stop and reports it", () => {
    const dir = projectWithLock({ pid: process.pid, background: true });
    const ran = [];
    const stopped = restartRunningDevServer(dir, {
      run: (cmd, args) => {
        ran.push([cmd, ...args].join(" "));
        rmSync(join(dir, ".astro", "dev.json"));
      },
    });
    assert.deepEqual(ran, ["npx astro dev stop"]);
    assert.equal(stopped.pid, process.pid);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when no server is running", () => {
    const dir = projectWithLock(undefined);
    let called = false;
    assert.equal(restartRunningDevServer(dir, { run: () => { called = true; } }), null);
    assert.equal(called, false);
    rmSync(dir, { recursive: true, force: true });
  });
});
