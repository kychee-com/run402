import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRunSql } from "./run-sql.js";
import { saveProject } from "../keystore.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  _resetSdk();
  tempDir = mkdtempSync(join(tmpdir(), "run402-sql-test-"));
  storePath = join(tempDir, "projects.json");
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  _resetSdk();
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("run_sql tool", () => {
  it("sends service_key as Bearer and SQL as text/plain", async () => {
    saveProject("proj-1", {
      anon_key: "ak",
      service_key: "sk-the-key",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ status: "ok", schema: "p0001", rows: [{ "?column?": 1 }], rowCount: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleRunSql({ project_id: "proj-1", sql: "SELECT 1" });
    assert.equal(capturedHeaders["Authorization"], "Bearer sk-the-key");
    assert.equal(capturedHeaders["Content-Type"], "text/plain");
    assert.equal(capturedBody, "SELECT 1");
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleRunSql({
      project_id: "no-such-proj",
      sql: "SELECT 1",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });

  it("formats rows as markdown table", async () => {
    saveProject("proj-2", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          schema: "p0001",
          rows: [
            { id: 1, name: "Alice" },
            { id: 2, name: "Bob" },
          ],
          rowCount: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleRunSql({ project_id: "proj-2", sql: "SELECT * FROM users" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("2 rows returned"));
    assert.ok(text.includes("| id | name |"));
    assert.ok(text.includes("| 1 | Alice |"));
    assert.ok(text.includes("| 2 | Bob |"));
  });

  it("shows 0 rows for DDL", async () => {
    saveProject("proj-3", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "ok", schema: "p0001", rows: [], rowCount: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleRunSql({
      project_id: "proj-3",
      sql: "CREATE TABLE test (id INT)",
    });
    assert.ok(result.content[0]!.text.includes("0 rows returned"));
  });

  it("sends JSON body with params when params provided", async () => {
    saveProject("proj-params", {
      anon_key: "ak",
      service_key: "sk-p",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ status: "ok", schema: "p0001", rows: [{ id: 42 }], rowCount: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleRunSql({ project_id: "proj-params", sql: "SELECT * FROM t WHERE id = $1", params: [42] });
    assert.equal(capturedHeaders["Content-Type"], "application/json");
    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.sql, "SELECT * FROM t WHERE id = $1");
    assert.deepEqual(parsed.params, [42]);
  });

  it("sends plain text when params is empty array", async () => {
    saveProject("proj-empty-params", {
      anon_key: "ak",
      service_key: "sk-ep",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ status: "ok", schema: "p0001", rows: [{ "?column?": 1 }], rowCount: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleRunSql({ project_id: "proj-empty-params", sql: "SELECT 1", params: [] });
    assert.equal(capturedHeaders["Content-Type"], "text/plain");
    assert.equal(capturedBody, "SELECT 1");
  });

  it("sends plain text when params is undefined", async () => {
    saveProject("proj-no-params", {
      anon_key: "ak",
      service_key: "sk-np",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ status: "ok", schema: "p0001", rows: [{ "?column?": 1 }], rowCount: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleRunSql({ project_id: "proj-no-params", sql: "SELECT 1" });
    assert.equal(capturedHeaders["Content-Type"], "text/plain");
    assert.equal(capturedBody, "SELECT 1");
  });

  it("returns isError with hint on 403 blocked SQL", async () => {
    saveProject("proj-4", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "Blocked SQL pattern: \\bGRANT\\b",
          hint: "Permissions are managed automatically.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleRunSql({
      project_id: "proj-4",
      sql: "GRANT SELECT ON users TO anon",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("GRANT"));
    assert.ok(result.content[0]!.text.includes("Permissions are managed automatically"));
  });
});
