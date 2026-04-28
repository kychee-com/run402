import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Mock config before importing db
mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
      ANON_KEY: "anon_test",
      JWT_SECRET: "secret",
    },
  },
});

const { db, adminDb } = await import("./db.js");

function makeRequest(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request("https://fn.localhost/", { method: "POST", headers });
}

describe("adminDb().from() — BYPASSRLS via /admin/v1/rest", () => {
  let lastFetchUrl: string;
  let lastFetchOpts: RequestInit;

  beforeEach(() => {
    lastFetchUrl = "";
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("posts to /admin/v1/rest/<table> with service_key in both apikey and Authorization", async () => {
    await adminDb().from("users").select();
    assert.equal(lastFetchUrl, "https://test.run402.com/admin/v1/rest/users?select=*");
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.apikey, "sk_test");
    assert.equal(headers.Authorization, "Bearer sk_test");
  });

  it("supports insert/update/delete", async () => {
    await adminDb().from("users").insert({ name: "Alice" });
    assert.equal(lastFetchOpts.method, "POST");
    assert.equal(lastFetchOpts.body, JSON.stringify([{ name: "Alice" }]));

    await adminDb().from("users").update({ name: "Bob" }).eq("id", 1);
    assert.equal(lastFetchOpts.method, "PATCH");

    await adminDb().from("users").delete().eq("id", 1);
    assert.equal(lastFetchOpts.method, "DELETE");
  });

  it("rejects on non-ok response", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("nope", { status: 404 }),
    );
    await assert.rejects(
      async () => { await adminDb().from("users").select(); },
      (err: Error) => err.message.includes("PostgREST error (404)"),
    );
  });
});

describe("adminDb().sql() — SQL bypass", () => {
  it("posts to /projects/v1/admin/:id/sql with Bearer service_key", async () => {
    let capturedUrl = "";
    let capturedOpts: RequestInit = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOpts = opts;
      return new Response(JSON.stringify([{ count: 5 }]), { status: 200 });
    });

    await adminDb().sql("SELECT * FROM users WHERE id = $1", ["abc"]);
    assert.equal(capturedUrl, "https://test.run402.com/projects/v1/admin/prj_test/sql");
    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(
      capturedOpts.body,
      JSON.stringify({ sql: "SELECT * FROM users WHERE id = $1", params: ["abc"] }),
    );
  });

  it("sends SQL without params as text/plain", async () => {
    let capturedOpts: RequestInit = {};
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      capturedOpts = opts;
      return new Response(JSON.stringify([]), { status: 200 });
    });

    await adminDb().sql("SELECT count(*) FROM users");
    const headers = capturedOpts.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "text/plain");
    assert.equal(capturedOpts.body, "SELECT count(*) FROM users");
  });
});

describe("db(req).from() — caller-context on /rest/v1", () => {
  let lastFetchUrl: string;
  let lastFetchOpts: RequestInit;

  beforeEach(() => {
    lastFetchUrl = "";
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("forwards the caller's Authorization header to PostgREST", async () => {
    const req = makeRequest("Bearer alice_jwt");
    await db(req).from("workouts").select();
    assert.equal(lastFetchUrl, "https://test.run402.com/rest/v1/workouts?select=*");
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.apikey, "anon_test", "apikey is anon, NOT service_key");
    assert.equal(headers.Authorization, "Bearer alice_jwt", "Authorization is caller's, NOT service_key");
  });

  it("routes to /rest/v1 (NOT /admin/v1/rest)", async () => {
    const req = makeRequest("Bearer alice_jwt");
    await db(req).from("workouts").select();
    assert.ok(lastFetchUrl.startsWith("https://test.run402.com/rest/v1/"));
    assert.ok(!lastFetchUrl.includes("/admin/v1/rest"));
  });

  it("uses anon apikey without Authorization when caller was unauthenticated — PostgREST returns 401 for tables requiring auth", async () => {
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      lastFetchOpts = opts;
      return new Response("no policy", { status: 401 });
    });
    const req = makeRequest(); // no Authorization header
    await assert.rejects(
      async () => { await db(req).from("workouts").select(); },
      (err: Error) => err.message.includes("PostgREST error (401)"),
    );
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.apikey, "anon_test");
    assert.equal(headers.Authorization, undefined, "Authorization must NOT be set when caller had none");
  });

  it("handles mixed-case Authorization header name from incoming Request", async () => {
    // Node's Request normalizes header names to lowercase, but we assert
    // robustness to either spelling since user code might forward a
    // hand-built Request with capitalized header names.
    const req = new Request("https://fn.localhost/", {
      method: "POST",
      headers: { Authorization: "Bearer bob_jwt" },
    });
    await db(req).from("workouts").select();
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer bob_jwt");
  });
});

describe("legacy db.from / db.sql shim — REMOVED", () => {
  it("db.from is no longer attached to the db function (object access errors)", () => {
    // Guard against accidental reintroduction of the legacy admin shim.
    // db is a function, not an object — `db.from` and `db.sql` must NOT exist.
    const dbAny = db as unknown as Record<string, unknown>;
    assert.equal(typeof dbAny.from, "undefined", "db.from must not exist (use db(req).from or adminDb().from)");
    assert.equal(typeof dbAny.sql, "undefined", "db.sql must not exist (use adminDb().sql)");
  });
});
