/**
 * Unit tests for the `functions` namespace. Covers deploy, invoke, logs,
 * list, delete, update — including schedule handling and the `since`
 * ISO→epoch conversion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { ApiError, LocalError, ProjectCredentialNotFound } from "../errors.js";
import { FunctionRunTerminalError } from "./functions.js";
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

/**
 * A `mockFetch` handler that drives the unified-apply engine to terminal
 * success for a single `functions.patch.set` deploy: `missing_content: []`
 * (so the CAS upload dance is skipped) + a terminal `"ready"` commit (so the
 * operation poll is skipped). `/tiers/v1/status` returns an empty tier so the
 * function tier preflight bails (no extra endpoints to mock). The `functions`
 * deploy re-point rides this path instead of the deleted legacy admin route.
 */
function applyOkFetch(opts: { planId: string; warnings?: unknown[] }) {
  const { planId, warnings = [] } = opts;
  return mockFetch((call) => {
    if (call.url.endsWith("/tiers/v1/status")) return json({ tier: "" });
    if (call.url.endsWith("/apply/v1/plans")) {
      return json({
        plan_id: planId,
        operation_id: "op_fn",
        base_release_id: null,
        manifest_digest: "digest",
        missing_content: [],
        diff: { resources: {} },
        warnings,
      });
    }
    if (call.url.endsWith(`/apply/v1/plans/${planId}/commit`)) {
      return json({ operation_id: "op_fn", status: "ready", release_id: "rel_fn", urls: {} });
    }
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  });
}

describe("functions.deploy", () => {
  it("deploys via a functions.patch.set apply plan, not the deleted legacy route", async () => {
    const { fetch, calls } = applyOkFetch({
      planId: "plan_fn",
      warnings: [
        { code: "BUNDLE_SIZE", severity: "low", requires_confirmation: false, message: "bundle is large" },
      ],
    });
    const sdk = makeSdk(fetch);
    const result = await sdk.functions.deploy("prj_known", {
      name: "hello",
      code: "export default async () => new Response('ok')",
      deps: ["lodash"],
    });

    // Routed through unified apply — never the deleted admin route, never a
    // service-key bearer (auth shifts to the project.deploy apply credential).
    const planCall = calls.find((c) => c.url.endsWith("/apply/v1/plans"));
    assert(planCall, "posted an /apply/v1/plans plan");
    assert.equal(planCall!.method, "POST");
    assert(
      !calls.some((c) => c.url.includes("/projects/v1/admin/")),
      "must not POST the deleted /projects/v1/admin/:id/functions route",
    );
    assert.notEqual(planCall!.headers["Authorization"], "Bearer svc_k");

    // The function rides under functions.patch.set.<name>, code as a content
    // ref, deps preserved (capability apply-v1-function-deps).
    const spec = (JSON.parse(planCall!.body as string) as { spec: Record<string, any> }).spec;
    assert.equal(spec.project_id, "prj_known");
    const fn = spec.functions.patch.set.hello;
    assert(fn, "functions.patch.set.hello present");
    assert.equal(typeof fn.source?.sha256, "string");
    assert.deepEqual(fn.deps, ["lodash"]);

    // Mapped back to the stable FunctionDeployResult contract — apply does not
    // carry per-function build metadata, so these are null.
    assert.equal(result.name, "hello");
    assert.equal(result.status, "deployed");
    assert.equal(result.url, "https://api.example.test/functions/v1/hello");
    assert.equal(result.runtime_version, null);
    assert.equal(result.deps_resolved, null);
    assert.deepEqual(result.warnings, ["bundle is large"]);
  });

  it("maps legacy config { timeout, memory } to the apply FunctionSpec shape", async () => {
    const { fetch, calls } = applyOkFetch({ planId: "plan_cfg" });
    const sdk = makeSdk(fetch);
    await sdk.functions.deploy("prj_known", {
      name: "cfg",
      code: "export default async () => new Response('ok')",
      config: { timeout: 20, memory: 256 },
    });
    const planCall = calls.find((c) => c.url.endsWith("/apply/v1/plans"))!;
    const fn = (JSON.parse(planCall.body as string) as { spec: Record<string, any> }).spec.functions.patch.set.cfg;
    assert.deepEqual(fn.config, { timeout_seconds: 20, memory_mb: 256 });
  });

  it("forwards schedule: null into the spec and omits config/deps when not provided", async () => {
    const { fetch, calls } = applyOkFetch({ planId: "plan_sch" });
    const sdk = makeSdk(fetch);
    const result = await sdk.functions.deploy("prj_known", {
      name: "sch",
      code: "export default async () => new Response('ok')",
      schedule: null,
    });
    const planCall = calls.find((c) => c.url.endsWith("/apply/v1/plans"))!;
    const fn = (JSON.parse(planCall.body as string) as { spec: Record<string, any> }).spec.functions.patch.set.sch;
    assert.equal(Object.prototype.hasOwnProperty.call(fn, "schedule"), true);
    assert.equal(fn.schedule, null);
    assert.equal(fn.config, undefined);
    assert.equal(fn.deps, undefined);
    assert.equal(result.schedule, null);
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

  it("rejects invalid name values before calling the gateway", async () => {
    const invalidValues = ["", "  ", "-bad", "bad/name", "bad name", "Bad"];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for ${JSON.stringify(value)}`);
      });
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.deploy("prj_known", { name: value, code: "..." }),
        (err: unknown) => err instanceof LocalError && /name/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });

  it("rejects invalid code values before calling the gateway", async () => {
    const invalidValues = ["", "  ", 42];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for ${JSON.stringify(value)}`);
      });
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.deploy("prj_known", { name: "x", code: value as never }),
        (err: unknown) => err instanceof LocalError && /code/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });

  it("rejects invalid deps before calling the gateway", async () => {
    const invalidValues = [
      [""],
      ["  "],
      ["@run402/functions"],
      ["run402-functions"],
      ["sharp"],
      [42],
    ];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for ${JSON.stringify(value)}`);
      });
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.deploy("prj_known", { name: "x", code: "...", deps: value as never }),
        (err: unknown) => err instanceof LocalError && /deps/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });

  it("rejects invalid schedule values before calling the gateway", async () => {
    const invalidValues = ["", "  ", "* * * *", "* * * * * *", 42];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for ${JSON.stringify(value)}`);
      });
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.deploy("prj_known", { name: "x", code: "...", schedule: value as never }),
        (err: unknown) => err instanceof LocalError && /schedule/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });

  it("throws ProjectCredentialNotFound without any fetch when local credentials are missing", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.functions.deploy("prj_missing", { name: "x", code: "..." }),
      ProjectCredentialNotFound,
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

  it("accepts function run ids as log correlation handles", async () => {
    const { fetch, calls } = mockFetch(() => json({ logs: [] }));
    const sdk = makeSdk(fetch);

    await sdk.functions.logs("prj_known", "worker", { requestId: "fnrun_abc123" });

    const u = new URL(calls[0]!.url);
    assert.equal(u.searchParams.get("request_id"), "fnrun_abc123");
  });

  it("throws LocalError for invalid since dates before fetching", async () => {
    const { fetch, calls } = mockFetch(() => json({ logs: [] }));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.functions.logs("prj_known", "x", { since: "June 19, 2026 12:00:00 UTC" }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });

  it("throws LocalError for invalid tail values before fetching", async () => {
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001, "10"];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => json({ logs: [] }));
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.logs("prj_known", "x", { tail: value as never }),
        (err: unknown) => err instanceof LocalError && /tail/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });

  it("throws LocalError for invalid request ids before fetching", async () => {
    const invalidValues = ["", "req_", "trace_abc123", "req_bad space", 42];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => json({ logs: [] }));
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.logs("prj_known", "x", { requestId: value as never }),
        (err: unknown) => err instanceof LocalError && /requestId/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });

  it("allows the maximum tail value", async () => {
    const { fetch, calls } = mockFetch(() => json({ logs: [] }));
    const sdk = makeSdk(fetch);
    await sdk.functions.logs("prj_known", "x", { tail: 1000 });
    const u = new URL(calls[0]!.url);
    assert.equal(u.searchParams.get("tail"), "1000");
  });

  it("URL-encodes function names with special characters", async () => {
    const { fetch, calls } = mockFetch(() => json({ logs: [] }));
    const sdk = makeSdk(fetch);
    await sdk.functions.logs("prj_known", "my fn");
    assert.ok(calls[0]!.url.includes("/functions/my%20fn/logs"));
  });
});

const queuedRun = {
  run_id: "fnrun_abc123",
  function_name: "worker",
  event_type: "kysigned.forward.process",
  status: "queued",
  terminal: false,
  generation: 1,
  run_at: "2026-07-01T12:00:00.000Z",
  source: { type: "api" },
  attempts: { current: 0, max: 5, total: 0 },
  created_at: "2026-07-01T12:00:00.000Z",
  updated_at: "2026-07-01T12:00:00.000Z",
  next_actions: [],
};

describe("functions.runs", () => {
  it("creates delayed function runs with local normalization and service-key auth", async () => {
    const { fetch, calls } = mockFetch(() => json({ ...queuedRun, status: "scheduled" }, 202));
    const sdk = makeSdk(fetch);

    const run = await sdk.functions.runs.create("prj_known", "worker", {
      eventType: "kysigned.forward.process",
      payload: { message_id: "msg_123" },
      delay: "10m",
      expiresAfter: "1d",
      idempotencyKey: sdk.idempotency.fromParts("reply", "msg_123"),
      retry: sdk.functions.retry.standard({ maxAttempts: 3 }),
    });

    assert.equal(run.run_id, "fnrun_abc123");
    assert.equal(calls[0]!.url, "https://api.example.test/functions/v1/worker/runs");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.Authorization, "Bearer svc_k");
    assert.equal(calls[0]!.headers["Idempotency-Key"], "reply:msg_123");
    const body = JSON.parse(calls[0]!.body as string);
    assert.deepEqual(body, {
      event_type: "kysigned.forward.process",
      payload: { message_id: "msg_123" },
      delay_seconds: 600,
      expires_at: body.expires_at,
      idempotency_key: "reply:msg_123",
      retry: { preset: "standard", max_attempts: 3 },
    });
    assert.match(body.expires_at, /^20\d\d-/);
  });

  it("rejects missing idempotency and ambiguous scheduling before fetch", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.functions.runs.create("prj_known", "worker", { eventType: "x" }),
      LocalError,
    );
    await assert.rejects(
      sdk.functions.runs.create("prj_known", "worker", {
        eventType: "x",
        idempotencyKey: "x",
        delay: "10m",
        runAt: "2026-07-01T12:00:00.000Z",
      }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });

  it("lists, gets, logs, cancels, and redrives runs", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.includes("/logs")) return json({ logs: [] });
      if (call.url.endsWith("/cancel")) return json({ ...queuedRun, status: "cancelled", terminal: true });
      if (call.url.endsWith("/redrive")) return json({ ...queuedRun, generation: 2 });
      if (call.url.includes("/worker/runs?")) return json({ runs: [queuedRun], next_cursor: "c2" });
      return json(queuedRun);
    });
    const sdk = makeSdk(fetch);

    const listed = await sdk.functions.runs.list("prj_known", "worker", {
      status: "failed",
      eventType: "kysigned.forward.process",
      limit: 25,
      cursor: "c1",
    });
    await sdk.functions.runs.get("prj_known", "fnrun_abc123");
    await sdk.functions.runs.logs("prj_known", "fnrun_abc123", { tail: 10, since: "2026-07-01T12:00:00.000Z" });
    await sdk.functions.runs.cancel("prj_known", "fnrun_abc123");
    await sdk.functions.runs.redrive("prj_known", "fnrun_abc123", { retry: { preset: "standard", maxAttempts: 2 } });

    assert.equal(listed.next_cursor, "c2");
    assert.equal(new URL(calls[0]!.url).pathname, "/functions/v1/worker/runs");
    assert.equal(new URL(calls[0]!.url).searchParams.get("event_type"), "kysigned.forward.process");
    assert.equal(new URL(calls[2]!.url).pathname, "/functions/v1/runs/fnrun_abc123/logs");
    assert.equal(calls[3]!.method, "POST");
    assert.equal(calls[4]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[4]!.body as string), {
      retry: { preset: "standard", max_attempts: 2 },
    });
  });

  it("waits for terminal success and throws typed terminal failures", async () => {
    let reads = 0;
    const { fetch } = mockFetch(() => {
      reads++;
      if (reads === 1) return json(queuedRun);
      if (reads === 2) return json({ ...queuedRun, status: "succeeded", terminal: true });
      return json({
        ...queuedRun,
        status: "failed",
        terminal: true,
        last_error: { code: "BOOM", message: "nope", retryable: false },
      });
    });
    const sdk = makeSdk(fetch);

    const final = await sdk.functions.runs.wait("prj_known", "fnrun_abc123", {
      intervalMs: 0,
      timeoutMs: 1000,
    });
    assert.equal(final.status, "succeeded");

    await assert.rejects(
      sdk.functions.runs.wait("prj_known", "fnrun_abc123", {
        intervalMs: 0,
        timeoutMs: 1000,
      }),
      (err: unknown) => err instanceof FunctionRunTerminalError &&
        err.run.status === "failed" &&
        err.code === "BOOM",
    );
  });

  it("is exposed on the scoped project client", async () => {
    const { fetch, calls } = mockFetch(() => json(queuedRun, 202));
    const sdk = makeSdk(fetch);
    const project = await sdk.project("prj_known");

    await project.functions.runs.create("worker", {
      eventType: "x",
      idempotencyKey: "x",
    });

    assert.equal(calls[0]!.url, "https://api.example.test/functions/v1/worker/runs");
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

  it("rejects empty updates before calling the gateway", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for empty update");
    });
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.functions.update("prj_known", "x", {}),
      (err: unknown) => err instanceof LocalError && /at least one/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("rejects invalid schedule updates before calling the gateway", async () => {
    const invalidValues = ["", "  ", "* * * *", "* * * * * *", 42];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for ${JSON.stringify(value)}`);
      });
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.update("prj_known", "x", { schedule: value as never }),
        (err: unknown) => err instanceof LocalError && /schedule/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });
});

describe("functions.rebuild", () => {
  it("POSTs the single-function rebuild path with wallet auth (no service key)", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        name: "hello",
        rebuilt: true,
        old_fingerprint: "old",
        new_fingerprint: "new",
        runtime_version_before: "1.59.0",
        runtime_version_after: "1.60.0",
        code_hash: "sha256:unchanged",
      }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.functions.rebuild("prj_known", "hello");
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/prj_known/functions/hello/rebuild");
    assert.equal(calls[0]!.method, "POST");
    // Wallet/allowance auth (walletAuth on the gateway) — not the service key.
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    assert.equal(result.rebuilt, true);
    assert.equal(result.code_hash, "sha256:unchanged");
  });

  it("does not require the project in the keystore (wallet-derived ownership)", async () => {
    // Unlike service-key methods, rebuild is wallet-authed: the gateway derives
    // the service key from the wallet-owned project, so the SDK must not do a
    // local keystore lookup (which would wrongly throw ProjectNotFound).
    const { fetch, calls } = mockFetch(() =>
      json({
        name: "hello",
        rebuilt: true,
        old_fingerprint: null,
        new_fingerprint: "new",
        runtime_version_before: null,
        runtime_version_after: "1.60.0",
        code_hash: "sha256:unchanged",
      }),
    );
    const sdk = makeSdk(fetch);
    await sdk.functions.rebuild("prj_not_in_keystore", "hello");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/prj_not_in_keystore/functions/hello/rebuild");
  });

  it("rejects invalid names before calling the gateway", async () => {
    const invalidValues = ["", "  ", "-bad", "bad/name", "bad name", "Bad"];
    for (const value of invalidValues) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for ${JSON.stringify(value)}`);
      });
      const sdk = makeSdk(fetch);
      await assert.rejects(
        sdk.functions.rebuild("prj_known", value),
        (err: unknown) => err instanceof LocalError && /name/.test(err.message),
      );
      assert.equal(calls.length, 0);
    }
  });

  it("surfaces CANNOT_REBUILD_UNLOCKED_DEPS as a 409 ApiError preserving the code", async () => {
    const { fetch } = mockFetch(() =>
      json(
        {
          error: "Function 'legacy' was deployed before dependency locking; redeploy from source to refresh its runtime.",
          code: "CANNOT_REBUILD_UNLOCKED_DEPS",
        },
        409,
      ),
    );
    const sdk = makeSdk(fetch);
    await assert.rejects(
      sdk.functions.rebuild("prj_known", "legacy"),
      (err: unknown) =>
        err instanceof ApiError &&
        err.status === 409 &&
        (err.body as { code?: string }).code === "CANNOT_REBUILD_UNLOCKED_DEPS",
    );
  });
});

describe("functions.rebuildAll", () => {
  it("POSTs the project-wide rebuild path and returns the batch envelope", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        rebuilt_count: 1,
        total: 2,
        results: [
          {
            name: "ok-fn",
            rebuilt: true,
            old_fingerprint: "old",
            new_fingerprint: "new",
            runtime_version_before: "1.59.0",
            runtime_version_after: "1.60.0",
            code_hash: "sha256:unchanged",
          },
          { name: "legacy-fn", rebuilt: false, code: "CANNOT_REBUILD_UNLOCKED_DEPS", error: "deployed before dependency locking" },
        ],
      }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.functions.rebuildAll("prj_known");
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/prj_known/functions/rebuild");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    assert.equal(result.rebuilt_count, 1);
    assert.equal(result.total, 2);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[1]!.rebuilt, false);
  });
});
