import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auth, getCurrentContext, runWithContext } from "@run402/functions";

import {
  createDevSessionHandler,
  DEV_TEST_SESSION_ENV,
  devRequestContext,
  parseDevTestSession,
  shouldInstallDevSession,
  type DevTestSession,
  type RunWithContext,
} from "./dev-session.js";
import { createRun402Adapter } from "./ssr-adapter.js";

const NOW = Date.parse("2026-10-25T10:00:00.000Z");

function fakeToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "ES256" })}.${part(claims)}.sig`;
}

const SESSION: DevTestSession = {
  project_id: "prj_family",
  user: { id: "11111111-1111-4111-8111-111111111111", label: "alice", email: "alice@prj_family.test.invalid", email_verified: true },
  session: { session_id: "sess_1", amr: ["test_session"], auth_time: "2026-10-25T09:30:00.000Z" },
  access_token: fakeToken({ sub: "11111111-1111-4111-8111-111111111111", authz_version: 3, is_test: true }),
  expires_at: "2026-10-25T11:30:00.000Z",
};

const realRunWithContext = runWithContext as unknown as RunWithContext;

describe("shouldInstallDevSession", () => {
  it("installs only for `astro dev` with the session variable set", () => {
    const env = { [DEV_TEST_SESSION_ENV]: JSON.stringify(SESSION) };
    assert.equal(shouldInstallDevSession("dev", env), true);
    assert.equal(shouldInstallDevSession("build", env), false);
    assert.equal(shouldInstallDevSession("preview", env), false);
    assert.equal(shouldInstallDevSession("dev", {}), false);
    assert.equal(shouldInstallDevSession("dev", { [DEV_TEST_SESSION_ENV]: "" }), false);
  });
});

describe("parseDevTestSession", () => {
  it("round-trips what run402 dev writes", () => {
    assert.deepEqual(parseDevTestSession(JSON.stringify(SESSION)), SESSION);
  });

  it("refuses non-JSON and missing fields, naming the restart", () => {
    assert.throws(() => parseDevTestSession("nope"), /run402 dev --as/);
    assert.throws(() => parseDevTestSession(JSON.stringify({ ...SESSION, access_token: undefined })), /missing fields/);
  });
});

describe("devRequestContext", () => {
  it("builds the routed_http context the deployed runtime builds from a verified envelope", () => {
    const request = new Request("http://localhost:4321/members?x=1", {
      headers: {
        cookie: "a=b",
        "x-run402-actor-context": "forged",
        "X-Run402-Actor-Token": "forged-token",
      },
    });
    const ctx = devRequestContext(SESSION, request, NOW, "dev_req_1");
    assert.ok(ctx);
    assert.equal(ctx.invocationKind, "routed_http");
    assert.equal(ctx.projectId, "prj_family");
    assert.equal(ctx.host, "localhost:4321");
    assert.deepEqual(ctx.actor, {
      id: SESSION.user.id,
      email: SESSION.user.email,
      isTest: true,
      emailVerified: true,
      authTime: Date.parse("2026-10-25T09:30:00.000Z") / 1000,
      amr: ["test_session"],
      amrTimes: { test_session: Date.parse("2026-10-25T09:30:00.000Z") / 1000 },
      authzVersion: 3,
      sessionId: "sess_1",
    });
    assert.equal(ctx.request.headers.cookie, "a=b");
    assert.equal(ctx.request.headers["x-run402-actor-token"], SESSION.access_token, "the browser's forged token is replaced");
    assert.equal(ctx.request.headers["x-run402-actor-context"], undefined, "inbound x-run402-* headers are dropped");
  });

  it("returns null once the session has expired", () => {
    const request = new Request("http://localhost:4321/");
    assert.equal(devRequestContext(SESSION, request, Date.parse(SESSION.expires_at), "r"), null);
  });
});

describe("createDevSessionHandler against the real @run402/functions runtime", () => {
  it("auth.user() inside the request resolves the test user, watermarked", async () => {
    const handle = createDevSessionHandler({ session: SESSION, runWithContext: realRunWithContext, now: () => NOW });
    let seen: unknown;
    let token: unknown;
    await handle(new Request("http://localhost:4321/members"), async () => {
      seen = await auth.user();
      token = getCurrentContext()?.request.headers["x-run402-actor-token"];
      return new Response("ok");
    });
    const user = seen as { id: string; email: string; is_test?: boolean } | null;
    assert.ok(user, "auth.user() is signed in");
    assert.equal(user.id, SESSION.user.id);
    assert.equal(user.email, SESSION.user.email);
    assert.equal(user.is_test, true);
    assert.equal(token, SESSION.access_token, "db() forwards the session bearer as the data-plane token");
  });

  it("after expiry serves anonymously and warns once", async () => {
    const warnings: string[] = [];
    const handle = createDevSessionHandler({
      session: SESSION,
      runWithContext: realRunWithContext,
      now: () => Date.parse(SESSION.expires_at) + 1,
      warn: (m) => warnings.push(m),
    });
    for (let i = 0; i < 2; i++) {
      await handle(new Request("http://localhost:4321/"), async () => {
        assert.equal(await auth.user(), null);
        return new Response("ok");
      });
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /run402 dev --as alice/);
  });
});

describe("createRun402Adapter registers the dev-session middleware", () => {
  function runConfigSetup(command: string, env: Record<string, string | undefined>) {
    const added: Array<{ entrypoint: string | URL; order: string }> = [];
    const hook = createRun402Adapter().hooks["astro:config:setup"] as (params: unknown) => void;
    const saved = process.env[DEV_TEST_SESSION_ENV];
    if (env[DEV_TEST_SESSION_ENV] === undefined) delete process.env[DEV_TEST_SESSION_ENV];
    else process.env[DEV_TEST_SESSION_ENV] = env[DEV_TEST_SESSION_ENV];
    try {
      hook({
        config: { output: "server", outDir: new URL("file:///tmp/run402-astro-test/dist/") },
        addRenderer() {},
        updateConfig() {},
        addMiddleware: (m: { entrypoint: string | URL; order: string }) => added.push(m),
        command,
        logger: { info() {}, warn() {}, error() {} },
      });
    } finally {
      if (saved === undefined) delete process.env[DEV_TEST_SESSION_ENV];
      else process.env[DEV_TEST_SESSION_ENV] = saved;
    }
    return added;
  }

  it("under `astro dev` with a session, first in the chain", () => {
    const added = runConfigSetup("dev", { [DEV_TEST_SESSION_ENV]: JSON.stringify(SESSION) });
    assert.equal(added.length, 1);
    assert.equal(added[0]!.order, "pre");
    assert.match(String(added[0]!.entrypoint), /dev-session-middleware\.js$/);
  });

  it("never for `astro build` or `astro preview`, even with the variable set", () => {
    for (const command of ["build", "preview"]) {
      assert.deepEqual(runConfigSetup(command, { [DEV_TEST_SESSION_ENV]: JSON.stringify(SESSION) }), []);
    }
  });

  it("not for `astro dev` without a session", () => {
    assert.deepEqual(runConfigSetup("dev", { [DEV_TEST_SESSION_ENV]: undefined }), []);
  });
});
