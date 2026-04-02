import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryBuilder } from "./db.js";

// Mock config before importing db
mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
      JWT_SECRET: "secret",
    },
  },
});

const { db } = await import("./db.js");

describe("QueryBuilder", () => {
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

  it("builds a simple select URL", async () => {
    await db.from("users").select();
    assert.equal(lastFetchUrl, "https://test.run402.com/rest/v1/users?select=*");
    assert.equal(lastFetchOpts.method, "GET");
  });

  it("builds select with specific columns", async () => {
    await db.from("users").select("id, name");
    assert.equal(lastFetchUrl, "https://test.run402.com/rest/v1/users?select=id%2C+name");
  });

  it("applies eq filter", async () => {
    await db.from("users").select().eq("role", "admin");
    assert.ok(lastFetchUrl.includes("role=eq.admin"));
  });

  it("applies neq filter", async () => {
    await db.from("users").select().neq("status", "banned");
    assert.ok(lastFetchUrl.includes("status=neq.banned"));
  });

  it("applies gt/lt/gte/lte filters", async () => {
    await db.from("users").select().gt("age", 18);
    assert.ok(lastFetchUrl.includes("age=gt.18"));

    await db.from("users").select().lt("age", 65);
    assert.ok(lastFetchUrl.includes("age=lt.65"));

    await db.from("users").select().gte("score", 100);
    assert.ok(lastFetchUrl.includes("score=gte.100"));

    await db.from("users").select().lte("score", 999);
    assert.ok(lastFetchUrl.includes("score=lte.999"));
  });

  it("applies like and ilike filters", async () => {
    await db.from("users").select().like("name", "%john%");
    assert.ok(lastFetchUrl.includes("name=like.%25john%25"));

    await db.from("users").select().ilike("name", "%JOHN%");
    assert.ok(lastFetchUrl.includes("name=ilike.%25JOHN%25"));
  });

  it("applies in filter", async () => {
    await db.from("users").select().in("id", [1, 2, 3]);
    assert.ok(lastFetchUrl.includes("id=in.%281%2C2%2C3%29"));
  });

  it("applies order", async () => {
    await db.from("users").select().order("name");
    assert.ok(lastFetchUrl.includes("order=name.asc"));

    await db.from("users").select().order("name", { ascending: false });
    assert.ok(lastFetchUrl.includes("order=name.desc"));
  });

  it("applies limit and offset", async () => {
    await db.from("users").select().limit(10).offset(20);
    assert.ok(lastFetchUrl.includes("limit=10"));
    assert.ok(lastFetchUrl.includes("offset=20"));
  });

  it("uses POST for insert", async () => {
    await db.from("users").insert({ name: "Alice" });
    assert.equal(lastFetchOpts.method, "POST");
    assert.equal(lastFetchOpts.body, JSON.stringify([{ name: "Alice" }]));
  });

  it("wraps single insert in array", async () => {
    await db.from("users").insert({ name: "Bob" });
    const body = JSON.parse(lastFetchOpts.body as string);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 1);
  });

  it("passes array insert directly", async () => {
    await db.from("users").insert([{ name: "A" }, { name: "B" }]);
    const body = JSON.parse(lastFetchOpts.body as string);
    assert.equal(body.length, 2);
  });

  it("uses PATCH for update", async () => {
    await db.from("users").update({ name: "New" }).eq("id", 1);
    assert.equal(lastFetchOpts.method, "PATCH");
    assert.equal(lastFetchOpts.body, JSON.stringify({ name: "New" }));
  });

  it("uses DELETE for delete", async () => {
    await db.from("users").delete().eq("id", 1);
    assert.equal(lastFetchOpts.method, "DELETE");
  });

  it("sends auth headers", async () => {
    await db.from("users").select();
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.apikey, "sk_test");
    assert.equal(headers.Authorization, "Bearer sk_test");
  });

  it("rejects on non-ok response", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response("Not found", { status: 404 });
    });
    await assert.rejects(
      async () => { await db.from("users").select(); },
      (err: Error) => err.message.includes("PostgREST error (404)"),
    );
  });

  it("is thenable (works with await)", async () => {
    const result = await db.from("users").select();
    assert.deepEqual(result, [{ id: 1 }]);
  });
});

describe("db.sql", () => {
  it("sends SQL with params as JSON", async () => {
    let capturedUrl = "";
    let capturedOpts: RequestInit = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOpts = opts;
      return new Response(JSON.stringify([{ count: 5 }]), { status: 200 });
    });

    await db.sql("SELECT * FROM users WHERE id = $1", ["abc"]);
    assert.equal(capturedUrl, "https://test.run402.com/projects/v1/admin/prj_test/sql");
    assert.equal((capturedOpts.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.equal(capturedOpts.body, JSON.stringify({ sql: "SELECT * FROM users WHERE id = $1", params: ["abc"] }));
  });

  it("sends SQL without params as text/plain", async () => {
    let capturedOpts: RequestInit = {};
    mock.method(globalThis, "fetch", async (_url: string, opts: RequestInit) => {
      capturedOpts = opts;
      return new Response(JSON.stringify([]), { status: 200 });
    });

    await db.sql("SELECT count(*) FROM users");
    assert.equal((capturedOpts.headers as Record<string, string>)["Content-Type"], "text/plain");
    assert.equal(capturedOpts.body, "SELECT count(*) FROM users");
  });

  it("throws on error response", async () => {
    mock.method(globalThis, "fetch", async () => {
      return new Response("syntax error", { status: 400 });
    });

    await assert.rejects(
      () => db.sql("INVALID SQL"),
      (err: Error) => err.message.includes("SQL error (400)"),
    );
  });
});
