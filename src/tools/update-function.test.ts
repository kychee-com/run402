import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleUpdateFunction } from "./update-function.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-update-fn-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
        tier: "prototype",
        lease_expires_at: "2030-01-01T00:00:00Z",
      },
    },
  };
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("update_function tool", () => {
  it("updates schedule and returns formatted result", async () => {
    let capturedMethod = "";
    let capturedBody = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedMethod = init.method || "";
      capturedBody = init.body as string;
      return new Response(
        JSON.stringify({
          name: "my-func",
          runtime: "node22",
          timeout: 10,
          memory: 128,
          schedule: "*/15 * * * *",
          schedule_meta: { run_count: 0 },
          updated_at: "2026-03-30T12:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleUpdateFunction({
      project_id: "proj-001",
      name: "my-func",
      schedule: "*/15 * * * *",
    });

    assert.equal(capturedMethod, "PATCH");
    const body = JSON.parse(capturedBody);
    assert.equal(body.schedule, "*/15 * * * *");
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Function Updated"));
    assert.ok(result.content[0]!.text.includes("`*/15 * * * *`"));
  });

  it("removes schedule by passing null", async () => {
    let capturedBody = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response(
        JSON.stringify({
          name: "my-func",
          runtime: "node22",
          timeout: 10,
          memory: 128,
          schedule: null,
          schedule_meta: null,
          updated_at: "2026-03-30T12:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleUpdateFunction({
      project_id: "proj-001",
      name: "my-func",
      schedule: null,
    });

    const body = JSON.parse(capturedBody);
    assert.equal(body.schedule, null);
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("—")); // no schedule
  });

  it("updates config (timeout and memory)", async () => {
    let capturedBody = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response(
        JSON.stringify({
          name: "my-func",
          runtime: "node22",
          timeout: 15,
          memory: 256,
          schedule: null,
          schedule_meta: null,
          updated_at: "2026-03-30T12:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleUpdateFunction({
      project_id: "proj-001",
      name: "my-func",
      timeout: 15,
      memory: 256,
    });

    const body = JSON.parse(capturedBody);
    assert.deepEqual(body.config, { timeout: 15, memory: 256 });
    assert.equal(body.schedule, undefined);
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("15s"));
    assert.ok(result.content[0]!.text.includes("256MB"));
  });

  it("returns isError on 403 (tier limit)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Scheduled function limit reached (1 for your prototype tier)." }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleUpdateFunction({
      project_id: "proj-001",
      name: "my-func",
      schedule: "*/5 * * * *",
    });

    assert.equal(result.isError, true);
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleUpdateFunction({
      project_id: "nonexistent",
      name: "my-func",
      schedule: "*/15 * * * *",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
