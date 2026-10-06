import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isLocalError, isApiError } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl });
}

const BASE = "https://api.example.test/projects/v1/prj_1/snapshots";

const HANDLE = {
  operation_id: "rst_1",
  restore_id: "rst_1",
  project_id: "prj_1",
  snapshot_id: "snap_1",
  release_mode: "snapshot",
  include_auth: false,
  status: "running",
  retry_after_seconds: 5,
  next_actions: [{ type: "poll", path: "/projects/v1/prj_1/snapshots/snap_1/restores/rst_1", message: "poll" }],
};

const RESULT = {
  operation_id: "rst_1",
  restore_id: "rst_1",
  project_id: "prj_1",
  snapshot_id: "snap_1",
  pre_restore_snapshot_id: "snap_pre",
  old_schema_slot: "p0001",
  new_schema_slot: "p0002",
  migration_registry_rows: 3,
  invalidated_plan_count: 0,
  release_mode: "snapshot",
  live_release_id: "rel_old",
  message: "Restore completed",
  status: "ready",
  next_actions: [],
};

function statusRow(overrides: Record<string, unknown>) {
  return {
    operation_id: "rst_1",
    restore_id: "rst_1",
    project_id: "prj_1",
    snapshot_id: "snap_1",
    status: "running",
    release_mode: "snapshot",
    include_auth: false,
    pre_restore_snapshot_id: null,
    live_release_id: null,
    started_at: "2026-10-06T10:00:00.000Z",
    completed_at: null,
    updated_at: "2026-10-06T10:00:00.000Z",
    error: null,
    result: null,
    next_actions: [],
    ...overrides,
  };
}

describe("snapshots.create", () => {
  it("sends label and metadata", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ snapshot_id: "snap_1", label: "before engine upgrade" }, 201));
    const snap = await makeSdk(fetch).snapshots.create("prj_1", {
      label: "before engine upgrade",
      metadata: { engine_to: "1.5.0" },
    });
    assert.equal(snap.label, "before engine upgrade");
    assert.equal(calls[0].url, BASE);
    assert.deepEqual(calls[0].body, { label: "before engine upgrade", metadata: { engine_to: "1.5.0" } });
  });

  it("sends an empty body without options", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ snapshot_id: "snap_1" }, 201));
    await makeSdk(fetch).snapshots.create("prj_1");
    assert.deepEqual(calls[0].body, {});
  });

  it("is reachable through the scoped client", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ snapshot_id: "snap_1" }, 201));
    await makeSdk(fetch).project("prj_1").snapshots.create({ label: "manual" });
    assert.deepEqual(calls[0].body, { label: "manual" });
  });
});

describe("snapshots.restorePlan", () => {
  it("sends the release mode and auth option", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ restore_plan: { confirm: { token: "tok" } } }));
    await makeSdk(fetch).snapshots.restorePlan("prj_1", "snap_1", { release: "snapshot", includeAuth: true });
    assert.equal(calls[0].url, `${BASE}/snap_1/restore`);
    assert.deepEqual(calls[0].body, { include: ["auth"], release: "snapshot" });
  });
});

describe("snapshots.restore", () => {
  it("starts in the background and resolves with the stored terminal result", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.method === "POST") return jsonResponse(HANDLE, 202);
      return jsonResponse(statusRow({ status: "ready", result: RESULT, pre_restore_snapshot_id: "snap_pre" }));
    });
    const result = await makeSdk(fetch).snapshots.restore("prj_1", "snap_1", "tok", { release: "snapshot" });
    assert.deepEqual(result, RESULT);
    assert.deepEqual(calls[0].body, { release: "snapshot", confirm: "tok", wait: false });
    assert.equal(calls[1].url, `${BASE}/snap_1/restores/rst_1`);
  });

  it("returns the 202 handle with wait:false", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(HANDLE, 202));
    const handle = await makeSdk(fetch).snapshots.restore("prj_1", "snap_1", "tok", { wait: false });
    assert.equal(handle.status, "running");
    assert.equal(handle.restore_id, "rst_1");
    assert.equal(calls.length, 1);
  });

  it("accepts a synchronous result from a gateway without async restore", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(RESULT));
    const result = await makeSdk(fetch).snapshots.restore("prj_1", "snap_1", "tok");
    assert.deepEqual(result, RESULT);
    assert.equal(calls.length, 1);
  });

  it("rejects a failed restore with the gateway's code", async () => {
    const { fetch } = mockFetch((call) => {
      if (call.method === "POST") return jsonResponse(HANDLE, 202);
      return jsonResponse(statusRow({
        status: "failed",
        error: { code: "RESTORE_INTERRUPTED", message: "stopped before its flip" },
        next_actions: [{ type: "request_restore_plan", message: "re-plan" }],
      }));
    });
    await assert.rejects(
      () => makeSdk(fetch).snapshots.restore("prj_1", "snap_1", "tok"),
      (err: unknown) => {
        assert.ok(isApiError(err));
        assert.equal((err as { code?: string }).code, "RESTORE_INTERRUPTED");
        return true;
      },
    );
  });

  it("reports a restore still running when the wait runs out", async () => {
    const { fetch } = mockFetch((call) => {
      if (call.method === "POST") return jsonResponse(HANDLE, 202);
      return jsonResponse(statusRow({}));
    });
    await assert.rejects(
      () => makeSdk(fetch).snapshots.restore("prj_1", "snap_1", "tok", { timeoutMs: 1 }),
      (err: unknown) => {
        assert.ok(isLocalError(err));
        assert.equal((err as { code?: string }).code, "SNAPSHOT_RESTORE_WAIT_TIMEOUT");
        return true;
      },
    );
  });

  it("requires a confirm token", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(() => makeSdk(fetch).snapshots.restore("prj_1", "snap_1", ""), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });
});

describe("snapshots.getRestore", () => {
  it("reads the restore status route", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(statusRow({ status: "ready" })));
    const status = await makeSdk(fetch).project("prj_1").snapshots.getRestore("snap_1", "rst_1");
    assert.equal(status.status, "ready");
    assert.equal(calls[0].url, `${BASE}/snap_1/restores/rst_1`);
  });
});
