/**
 * Unit tests for the `functions` namespace. Covers deploy, invoke, logs,
 * list, delete, update — including schedule handling and the `since`
 * ISO→epoch conversion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError, ProjectNotFound } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

function makeCreds(): CredentialsProvider {
  return {
    async getAuth() { return { "SIGN-IN-WITH-X": "test" }; },
    async getProject(id: string) {
      if (id === "prj_known") return { anon_key: "anon_k", service_key: "svc_k" };
      return null;
    },
  };
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
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
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: makeCreds(),
    fetch: fetchImpl,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("functions.deploy", () => {
  it("POSTs name/code/config/deps/schedule when present", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        name: "hello",
        url: "https://api.example.test/functions/v1/hello",
        status: "deployed",
        runtime: "node22",
        timeout: 15,
        memory: 256,
        schedule: "*/5 * * * *",
        created_at: "2026-04-23T00:00:00Z",
      }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.functions.deploy("prj_known", {
      name: "hello",
      code: "export default async () => new Response('ok')",
      config: { timeout: 15, memory: 256 },
      deps: ["axios"],
      schedule: "*/5 * * * *",
    });
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/functions");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer svc_k");
    const body = JSON.parse(calls[0]!.body as string);
    assert.equal(body.name, "hello");
    assert.deepEqual(body.config, { timeout: 15, memory: 256 });
    assert.deepEqual(body.deps, ["axios"]);
    assert.equal(body.schedule, "*/5 * * * *");
    assert.equal(result.status, "deployed");
  });

  it("omits config/deps/schedule when undefined", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ name: "x", url: "u", status: "deployed", runtime: "node22", timeout: 15, memory: 128, created_at: "2026-04-23T00:00:00Z" }),
    );
    const sdk = makeSdk(fetch);
    await sdk.functions.deploy("prj_known", { name: "x", code: "..." });
    const body = JSON.parse(calls[0]!.body as string);
    assert.equal(body.config, undefined);
    assert.equal(body.deps, undefined);
    assert.equal(body.schedule, undefined);
  });

  it("forwards schedule: null to clear an existing schedule", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ name: "x", url: "u", status: "deployed", runtime: "node22", timeout: 15, memory: 128, schedule: null, created_at: "2026-04-23T00:00:00Z" }),
    );
    const sdk = makeSdk(fetch);
    await sdk.functions.deploy("prj_known", { name: "x", code: "...", schedule: null });
    const body = JSON.parse(calls[0]!.body as string);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "schedule"), true);
    assert.equal(body.schedule, null);
  });

  it("rejects invalid config values before calling the gateway", async () => {
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "30"];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for ${String(value)}`);
      });
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.deploy("prj_known", {
          name: "x",
          code: "...",
          config: { timeout: value as never },
        }),
        (err: unknown) => err instanceof LocalError && /config\.timeout/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });

  it("throws ProjectNotFound without any fetch", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.functions.deploy("prj_missing", { name: "x", code: "..." }),
      ProjectNotFound,
    );
    assert.equal(calls.length, 0);
  });
});

describe("functions.invoke", () => {
  it("POSTs to /functions/v1/:name with apikey=service_key", async () => {
    const { fetch, calls } = mockFetch(() => json({ hello: "world" }));
    const sdk = makeSdk(fetch);
    const result = await sdk.functions.invoke("prj_known", "hello", {
      body: { in: 1 },
      headers: { "x-custom": "abc" },
    });
    assert.equal(calls[0]!.url, "https://api.example.test/functions/v1/hello");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["apikey"], "svc_k");
    assert.equal(calls[0]!.headers["x-custom"], "abc");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { in: 1 });
    assert.deepEqual(result.body, { hello: "world" });
    assert.equal(result.status, 200);
    assert.ok(typeof result.duration_ms === "number");
  });

  it("forwards a string body as-is with rawBody (no JSON wrap)", async () => {
    const { fetch, calls } = mockFetch(() => json({ ok: true }));
    const sdk = makeSdk(fetch);
    await sdk.functions.invoke("prj_known", "hello", { body: "raw-text" });
    assert.equal(calls[0]!.body, "raw-text");
  });

  it("defaults method to POST", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await sdk.functions.invoke("prj_known", "x");
    assert.equal(calls[0]!.method, "POST");
  });

  it("supports GET without body", async () => {
    const { fetch, calls } = mockFetch(() => json({ data: [] }));
    const sdk = makeSdk(fetch);
    await sdk.functions.invoke("prj_known", "x", { method: "GET" });
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.body, null);
  });
});

describe("functions.logs", () => {
  it("GETs logs path with tail, converts since to epoch ms, and passes requestId", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        logs: [
          {
            timestamp: "2026-04-01T00:00:00.000Z",
            message: "m",
            event_id: "evt-1",
            log_stream_name: "2026/04/01/[$LATEST]abc",
            ingestion_time: "2026-04-01T00:00:01.000Z",
            request_id: "req_abc123",
          },
        ],
      }),
    );
    const sdk = makeSdk(fetch);
    const iso = "2026-04-01T00:00:00.000Z";
    const epoch = new Date(iso).getTime();
    const result = await sdk.functions.logs("prj_known", "hello", {
      tail: 25,
      since: iso,
      requestId: "req_abc123",
    });
    const u = new URL(calls[0]!.url);
    assert.equal(u.pathname, "/projects/v1/admin/prj_known/functions/hello/logs");
    assert.equal(u.searchParams.get("tail"), "25");
    assert.equal(u.searchParams.get("since"), String(epoch));
    assert.equal(u.searchParams.get("request_id"), "req_abc123");
    assert.equal(result.logs[0]!.event_id, "evt-1");
    assert.equal(result.logs[0]!.log_stream_name, "2026/04/01/[$LATEST]abc");
    assert.equal(result.logs[0]!.ingestion_time, "2026-04-01T00:00:01.000Z");
    assert.equal(result.logs[0]!.request_id, "req_abc123");
  });

  it("throws LocalError for invalid since dates before fetching", async () => {
    const { fetch, calls } = mockFetch(() => json({ logs: [] }));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.functions.logs("prj_known", "x", { since: "not-a-date" }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });

  it("URL-encodes function names with special characters", async () => {
    const { fetch, calls } = mockFetch(() => json({ logs: [] }));
    const sdk = makeSdk(fetch);
    await sdk.functions.logs("prj_known", "my fn");
    assert.ok(calls[0]!.url.includes("/functions/my%20fn/logs"));
  });
});

describe("functions.list", () => {
  it("GETs /projects/v1/admin/:id/functions", async () => {
    const { fetch, calls } = mockFetch(() => json({ functions: [] }));
    const sdk = makeSdk(fetch);
    const result = await sdk.functions.list("prj_known");
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/functions");
    assert.deepEqual(result.functions, []);
  });
});

describe("functions.delete", () => {
  it("DELETEs /projects/v1/admin/:id/functions/:name", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await sdk.functions.delete("prj_known", "hello");
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/functions/hello");
    assert.equal(calls[0]!.method, "DELETE");
  });

  it("returns the gateway envelope with status and name", async () => {
    const { fetch } = mockFetch(() => json({ status: "deleted", name: "hello" }));
    const sdk = makeSdk(fetch);
    const result = await sdk.functions.delete("prj_known", "hello");
    assert.equal(result.status, "deleted");
    assert.equal(result.name, "hello");
  });
});

describe("functions.update", () => {
  it("PATCHes with schedule and collapsed config", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        name: "hello", runtime: "node22", timeout: 30, memory: 512,
        schedule: "0 * * * *", schedule_meta: null,
        updated_at: "2026-04-23T00:00:00Z",
      }),
    );
    const sdk = makeSdk(fetch);
    await sdk.functions.update("prj_known", "hello", {
      schedule: "0 * * * *",
      timeout: 30,
      memory: 512,
    });
    const body = JSON.parse(calls[0]!.body as string);
    assert.equal(body.schedule, "0 * * * *");
    assert.deepEqual(body.config, { timeout: 30, memory: 512 });
  });

  it("forwards schedule: null to remove schedule", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ name: "x", runtime: "node22", timeout: 15, memory: 128, schedule: null, schedule_meta: null, updated_at: "2026-04-23T00:00:00Z" }),
    );
    const sdk = makeSdk(fetch);
    await sdk.functions.update("prj_known", "x", { schedule: null });
    const body = JSON.parse(calls[0]!.body as string);
    assert.equal(body.schedule, null);
    assert.equal(body.config, undefined);
  });

  it("omits config when neither timeout nor memory is set", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ name: "x", runtime: "node22", timeout: 15, memory: 128, schedule: null, schedule_meta: null, updated_at: "2026-04-23T00:00:00Z" }),
    );
    const sdk = makeSdk(fetch);
    await sdk.functions.update("prj_known", "x", { schedule: "0 0 * * *" });
    const body = JSON.parse(calls[0]!.body as string);
    assert.equal(body.config, undefined);
  });

  it("rejects invalid config updates before calling the gateway", async () => {
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "256"];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for ${String(value)}`);
      });
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.update("prj_known", "x", { memory: value as never }),
        (err: unknown) => err instanceof LocalError && /memory/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });
});
