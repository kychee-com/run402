/**
 * Kernel unit tests — verify HTTP status → Run402Error mapping, auth
 * injection, body serialization, and that `process.exit` is never touched.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildClient, clientMetadataHeaders, request, requestWithResponse, type KernelConfig } from "./kernel.js";
import {
  ApiError,
  NetworkError,
  NotAuthorizedError,
  PaymentRequired,
  StepUpRequiredError,
  Unauthorized,
} from "./errors.js";
import type { CredentialsProvider } from "./credentials.js";

function makeCreds(
  overrides: Partial<CredentialsProvider> = {},
): CredentialsProvider {
  return {
    async getAuth() {
      return { "X-Test-Auth": "yes" };
    },
    async getProject() {
      return null;
    },
    ...overrides,
  };
}

function makeRes(body: unknown, init: { status?: number; contentType?: string } = {}): Response {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? (typeof body === "string" ? "text/plain" : "application/json");
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": contentType } });
}

function makeKernel(
  fetchImpl: typeof globalThis.fetch,
  creds: CredentialsProvider = makeCreds(),
): KernelConfig {
  return {
    apiBase: "https://api.example.test",
    fetch: fetchImpl,
    credentials: creds,
  };
}

describe("kernel request", () => {
  let exitSpy: { called: boolean; restore: () => void };

  beforeEach(() => {
    const original = process.exit;
    let called = false;
    // Any call to process.exit during these tests is a bug in the SDK.
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      called = true;
      throw new Error(`process.exit(${code}) called during SDK test`);
    }) as typeof process.exit;
    exitSpy = {
      get called() {
        return called;
      },
      restore() {
        process.exit = original;
      },
    };
  });

  it("parses 2xx JSON response", async () => {
    const kernel = makeKernel(async () => makeRes({ ok: true, id: "prj_1" }));
    const body = await request<{ ok: boolean; id: string }>(kernel, "/projects/v1", {
      context: "listing projects",
    });
    assert.deepEqual(body, { ok: true, id: "prj_1" });
    assert.equal(exitSpy.called, false);
    exitSpy.restore();
  });

  it("parses 2xx text/plain response", async () => {
    const kernel = makeKernel(async () =>
      makeRes("plain text body", { contentType: "text/plain" }),
    );
    const body = await request<string>(kernel, "/ping", { context: "pinging" });
    assert.equal(body, "plain text body");
    exitSpy.restore();
  });

  it("attaches bounded unprefixed client metadata when provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    const kernel: KernelConfig = {
      ...makeKernel(async (_input, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return makeRes({ ok: true });
      }),
      clientMetadata: {
        surface: "cli",
        version: "3.7.14",
        sdkVersion: "3.7.14",
      },
    };
    await request(kernel, "/projects/v1", { context: "listing projects" });
    assert.equal(
      capturedHeaders["Run402-Client"],
      'surface="cli", version="3.7.14", sdk="3.7.14"',
    );
    assert.equal(Object.keys(capturedHeaders).some((name) => name.startsWith("X-Run402-Client")), false);
    assert.doesNotMatch(capturedHeaders["Run402-Client"], /cwd|wallet|project|package_manager|secret/i);
    exitSpy.restore();
  });

  it("does not override caller-provided metadata headers and omits invalid values", async () => {
    let capturedHeaders: Record<string, string> = {};
    const kernel: KernelConfig = {
      ...makeKernel(async (_input, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return makeRes({ ok: true });
      }),
      clientMetadata: {
        surface: "sdk",
        version: "3.7.14",
        sdkVersion: "3.7.14",
      },
    };
    await request(kernel, "/projects/v1", {
      context: "listing projects",
      headers: { "run402-client": 'surface="custom", version="1.0.0"' },
    });
    assert.equal(capturedHeaders["run402-client"], 'surface="custom", version="1.0.0"');
    assert.equal(capturedHeaders["Run402-Client"], undefined);

    assert.deepEqual(clientMetadataHeaders({
      surface: "../cli",
      version: "x".repeat(100),
      sdkVersion: "3.7.14 with spaces",
    }), {});
    exitSpy.restore();
  });

  it("throws PaymentRequired on 402 with body preserved", async () => {
    const body402 = { message: "Project past_due", renew_url: "https://..." };
    const kernel = makeKernel(async () => makeRes(body402, { status: 402 }));
    await assert.rejects(
      request(kernel, "/projects/v1", { method: "POST", body: {}, context: "provisioning" }),
      (err: unknown) => {
        assert.ok(err instanceof PaymentRequired);
        assert.equal((err as PaymentRequired).status, 402);
        assert.deepEqual((err as PaymentRequired).body, body402);
        assert.equal((err as PaymentRequired).context, "provisioning");
        return true;
      },
    );
    exitSpy.restore();
  });

  it("projects canonical envelope fields onto SDK errors without rewriting body", async () => {
    const canonical = {
      status: "degraded",
      error: "frozen",
      message: "Project is frozen.",
      code: "PROJECT_FROZEN",
      category: "lifecycle",
      retryable: false,
      safe_to_retry: true,
      mutation_state: "none",
      trace_id: "trc_123",
      details: { project_id: "prj_1" },
      next_actions: [{ type: "renew_tier" }],
    };
    const kernel = makeKernel(async () => makeRes(canonical, { status: 403 }));
    await assert.rejects(
      request(kernel, "/projects/v1/prj_1", { context: "updating project" }),
      (err: unknown) => {
        assert.ok(err instanceof Unauthorized);
        const e = err as Unauthorized;
        assert.equal(e.status, 403);
        assert.deepEqual(e.body, canonical);
        assert.equal((e.body as typeof canonical).status, "degraded");
        assert.equal(e.message, "Project is frozen. while updating project (HTTP 403)");
        assert.equal(e.code, "PROJECT_FROZEN");
        assert.equal(e.category, "lifecycle");
        assert.equal(e.retryable, false);
        assert.equal(e.safeToRetry, true);
        assert.equal(e.mutationState, "none");
        assert.equal(e.traceId, "trc_123");
        assert.deepEqual(e.details, { project_id: "prj_1" });
        assert.deepEqual(e.nextActions, [{ type: "renew_tier" }]);
        return true;
      },
    );
    exitSpy.restore();
  });

  it("falls back to subclass defaults for canonical projections on legacy-only bodies", async () => {
    const body = { error: "internal" };
    const kernel = makeKernel(async () => makeRes(body, { status: 500 }));
    await assert.rejects(
      request(kernel, "/x", { context: "calling x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        const e = err as ApiError;
        assert.deepEqual(e.body, body);
        assert.equal(e.message, "internal while calling x (HTTP 500)");
        assert.equal(e.code, "API_ERROR");
        assert.equal(e.category, "api");
        assert.equal(e.retryable, false);
        assert.equal(e.safeToRetry, undefined);
        assert.equal(e.mutationState, undefined);
        assert.equal(e.traceId, undefined);
        assert.equal(e.nextActions, undefined);
        return true;
      },
    );
    exitSpy.restore();
  });

  it("keeps passthrough and non-envelope bodies useful across error subclasses", async () => {
    const paymentKernel = makeKernel(async () =>
      makeRes("Payment Required", { status: 402, contentType: "text/plain" }),
    );
    await assert.rejects(
      request(paymentKernel, "/projects/v1", { context: "provisioning" }),
      (err: unknown) => {
        assert.ok(err instanceof PaymentRequired);
        const e = err as PaymentRequired;
        assert.equal(e.status, 402);
        assert.equal(e.body, "Payment Required");
        assert.equal(e.message, "Payment required while provisioning");
        return true;
      },
    );

    const unauthorizedBody = { message: "relation does not exist", code: "42P01" };
    const unauthorizedKernel = makeKernel(async () => makeRes(unauthorizedBody, { status: 403 }));
    await assert.rejects(
      request(unauthorizedKernel, "/rest/v1/todos", { context: "querying REST" }),
      (err: unknown) => {
        assert.ok(err instanceof Unauthorized);
        const e = err as Unauthorized;
        assert.equal(e.status, 403);
        assert.deepEqual(e.body, unauthorizedBody);
        assert.equal(e.message, "relation does not exist while querying REST (HTTP 403)");
        assert.equal(e.category, "auth");
        assert.equal(e.mutationState, undefined);
        return true;
      },
    );

    const apiKernel = makeKernel(async () =>
      makeRes("<html>Bad Gateway</html>", { status: 502, contentType: "text/html" }),
    );
    await assert.rejects(
      request(apiKernel, "/x", { context: "calling x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        const e = err as ApiError;
        assert.equal(e.status, 502);
        assert.equal(e.body, "<html>Bad Gateway</html>");
        assert.equal(e.message, "API error while calling x (HTTP 502)");
        return true;
      },
    );
    exitSpy.restore();
  });

  it("throws Unauthorized on 401", async () => {
    const kernel = makeKernel(async () => makeRes({ error: "bad auth" }, { status: 401 }));
    await assert.rejects(
      request(kernel, "/whoami", { context: "fetching whoami" }),
      (err: unknown) => err instanceof Unauthorized && (err as Unauthorized).status === 401,
    );
    exitSpy.restore();
  });

  it("throws Unauthorized on 403", async () => {
    const kernel = makeKernel(async () => makeRes({ error: "forbidden" }, { status: 403 }));
    await assert.rejects(
      request(kernel, "/admin/thing", { context: "admin op" }),
      (err: unknown) => err instanceof Unauthorized && (err as Unauthorized).status === 403,
    );
    exitSpy.restore();
  });

  it("throws NotAuthorizedError on 403 NOT_AUTHORIZED, lifting role/capability/reason", async () => {
    const body = {
      code: "NOT_AUTHORIZED",
      category: "auth",
      message: "Not authorized for this project action",
      details: {
        action: "project.delete",
        required_role: "owner",
        required_capability: null,
        reason: "forbidden",
      },
    };
    const kernel = makeKernel(async () => makeRes(body, { status: 403 }));
    await assert.rejects(
      request(kernel, "/projects/v1/prj_1", { method: "DELETE", context: "deleting project" }),
      (err: unknown) => {
        assert.ok(err instanceof NotAuthorizedError);
        const e = err as NotAuthorizedError;
        assert.equal(e.kind, "not_authorized");
        assert.ok(!(err instanceof Unauthorized), "NOT_AUTHORIZED must not be a generic Unauthorized");
        assert.equal(e.status, 403);
        assert.equal(e.code, "NOT_AUTHORIZED");
        assert.equal(e.category, "auth");
        assert.equal(e.action, "project.delete");
        assert.equal(e.requiredRole, "owner");
        assert.equal(e.requiredCapability, null);
        assert.equal(e.reason, "forbidden");
        assert.equal(e.message, "Not authorized for this project action while deleting project (HTTP 403)");
        assert.deepEqual(e.body, body);
        // toJSON surfaces the structured fields for agent triage.
        const json = e.toJSON();
        assert.equal(json.requiredRole, "owner");
        assert.equal(json.reason, "forbidden");
        return true;
      },
    );
    exitSpy.restore();
  });

  it("throws StepUpRequiredError on 403 with code STEP_UP_REQUIRED", async () => {
    const body = {
      error: "step up required",
      code: "STEP_UP_REQUIRED",
      details: {
        required_amr: ["passkey"],
        max_age_seconds: 300,
        challenge_url: "https://run402.com/step-up",
        reason: "device_flow_forbidden",
      },
    };
    const kernel = makeKernel(async () => makeRes(body, { status: 403 }));
    await assert.rejects(
      request(kernel, "/projects/v1/prj_1/transfers", { method: "POST", context: "transferring a project" }),
      (err: unknown) => {
        assert.ok(err instanceof StepUpRequiredError);
        const e = err as StepUpRequiredError;
        assert.equal(e.kind, "step_up_required");
        assert.equal(e.status, 403);
        assert.deepEqual(e.requiredAmr, ["passkey"]);
        assert.equal(e.maxAgeSeconds, 300);
        assert.equal(e.challengeUrl, "https://run402.com/step-up");
        assert.equal(e.reason, "device_flow_forbidden");
        return true;
      },
    );
    exitSpy.restore();
  });

  it("keeps non-NOT_AUTHORIZED 403s as generic Unauthorized", async () => {
    // A 403 carrying a different canonical code (e.g. admin-only) must NOT
    // become NotAuthorizedError — only the org control-plane code diverts.
    const kernel = makeKernel(async () =>
      makeRes({ code: "ADMIN_REQUIRED", error: "admin only" }, { status: 403 }),
    );
    await assert.rejects(
      request(kernel, "/admin/thing", { context: "admin op" }),
      (err: unknown) => {
        assert.ok(err instanceof Unauthorized);
        assert.ok(!(err instanceof NotAuthorizedError));
        return true;
      },
    );
    exitSpy.restore();
  });

  it("throws ApiError on 404 with body", async () => {
    const kernel = makeKernel(async () => makeRes({ error: "not found" }, { status: 404 }));
    await assert.rejects(
      request(kernel, "/x", { context: "fetching x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 404);
        assert.deepEqual((err as ApiError).body, { error: "not found" });
        return true;
      },
    );
    exitSpy.restore();
  });

  it("throws ApiError on 500", async () => {
    const kernel = makeKernel(async () => makeRes("oops", { status: 500, contentType: "text/plain" }));
    await assert.rejects(
      request(kernel, "/x", { context: "calling x" }),
      (err: unknown) => err instanceof ApiError && (err as ApiError).status === 500,
    );
    exitSpy.restore();
  });

  it("throws NetworkError when fetch rejects", async () => {
    const kernel = makeKernel(async () => {
      throw new Error("ECONNREFUSED");
    });
    await assert.rejects(
      request(kernel, "/x", { context: "doing x" }),
      (err: unknown) => {
        assert.ok(err instanceof NetworkError);
        assert.equal((err as NetworkError).status, null);
        assert.match((err as NetworkError).message, /ECONNREFUSED/);
        return true;
      },
    );
    exitSpy.restore();
  });

  // Regression: the kernel's `fetch` is injectable and the paid clients inject
  // an x402 payment fetch, which throws DOMAIN errors (notably a confirmed
  // `X402_INSUFFICIENT_FUNDS` balance miss) through the same seam as a dead
  // socket. Blanket-wrapping those as NetworkError told a buyer with a drained
  // wallet `NETWORK_ERROR` / `retryable: true` and offered no remedy, so a
  // retrying agent looped forever on a condition only funding can clear.
  it("passes a structured Run402Error through instead of wrapping it as NetworkError", async () => {
    const payment = new PaymentRequired("insufficient funds", 402, { code: "X402_INSUFFICIENT_FUNDS" }, "paying");
    const kernel = makeKernel(async () => {
      throw payment;
    });
    await assert.rejects(
      request(kernel, "/x", { context: "doing x" }),
      (err: unknown) => {
        assert.equal(err, payment, "the original error object must survive unwrapped");
        assert.ok(!(err instanceof NetworkError));
        return true;
      },
    );
    exitSpy.restore();
  });

  // The guard is brand-based, not instanceof-based, so an error thrown by a
  // DUPLICATE SDK copy (different class identity, same brand) survives too.
  it("passes a cross-realm branded Run402Error through by brand, not class identity", async () => {
    const foreign = Object.assign(new Error("insufficient funds"), {
      isRun402Error: true as const,
      kind: "local_error",
      code: "X402_INSUFFICIENT_FUNDS",
    });
    const kernel = makeKernel(async () => {
      throw foreign;
    });
    await assert.rejects(
      request(kernel, "/x", { context: "doing x" }),
      (err: unknown) => {
        assert.equal(err, foreign);
        assert.ok(!(err instanceof NetworkError));
        return true;
      },
    );
    exitSpy.restore();
  });

  it("injects auth headers from credentials.getAuth", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return makeRes({ ok: true });
    };
    const kernel = makeKernel(fetchImpl);
    await request(kernel, "/projects/v1", { context: "listing" });
    assert.equal(capturedHeaders["X-Test-Auth"], "yes");
    exitSpy.restore();
  });

  it("skips auth headers when withAuth is false", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return makeRes({ ok: true });
    };
    const kernel = makeKernel(fetchImpl);
    await request(kernel, "/service/status", {
      context: "status",
      withAuth: false,
    });
    assert.equal(capturedHeaders["X-Test-Auth"], undefined);
    exitSpy.restore();
  });

  it("serializes body as JSON with application/json content-type by default", async () => {
    let capturedBody: unknown;
    let capturedCT: string | undefined;
    const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
      capturedBody = init?.body;
      const h = (init?.headers ?? {}) as Record<string, string>;
      capturedCT = h["Content-Type"] ?? h["content-type"];
      return makeRes({ ok: true });
    };
    const kernel = makeKernel(fetchImpl);
    await request(kernel, "/x", { method: "POST", body: { a: 1 }, context: "posting" });
    assert.equal(capturedBody, JSON.stringify({ a: 1 }));
    assert.equal(capturedCT, "application/json");
    exitSpy.restore();
  });

  it("passes rawBody through untouched and does not set Content-Type", async () => {
    let capturedBody: unknown;
    let capturedCT: string | undefined;
    const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
      capturedBody = init?.body;
      const h = (init?.headers ?? {}) as Record<string, string>;
      capturedCT = h["Content-Type"] ?? h["content-type"];
      return makeRes({ ok: true });
    };
    const kernel = makeKernel(fetchImpl);
    await request(kernel, "/sql", {
      method: "POST",
      rawBody: "select 1",
      headers: { "Content-Type": "text/plain" },
      context: "running sql",
    });
    assert.equal(capturedBody, "select 1");
    assert.equal(capturedCT, "text/plain");
    exitSpy.restore();
  });

  it("prepends apiBase to the path", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return makeRes({ ok: true });
    };
    const kernel = makeKernel(fetchImpl);
    await request(kernel, "/projects/v1/admin/abc", { context: "x" });
    assert.equal(capturedUrl, "https://api.example.test/projects/v1/admin/abc");
    exitSpy.restore();
  });
});

describe("kernel observability (RUN402_TRACE + per-client stats)", () => {
  let exitSpy: { restore: () => void };
  let originalTrace: string | undefined;
  let stderrLines: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    const original = process.exit;
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      throw new Error(`process.exit(${code}) called during SDK test`);
    }) as typeof process.exit;
    exitSpy = { restore: () => { process.exit = original; } };
    originalTrace = process.env.RUN402_TRACE;
    stderrLines = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    };
  });

  function restoreEnv() {
    if (originalTrace === undefined) delete process.env.RUN402_TRACE;
    else process.env.RUN402_TRACE = originalTrace;
    process.stderr.write = originalWrite;
    exitSpy.restore();
  }

  it("RUN402_TRACE unset: no trace line is written", async () => {
    delete process.env.RUN402_TRACE;
    const kernel = makeKernel(async () => makeRes({ ok: true }));
    await request(kernel, "/projects/v1?secret=shh", { context: "listing" });
    assert.equal(stderrLines.length, 0);
    restoreEnv();
  });

  it("RUN402_TRACE set: writes one line per request, path without query string, status, ms, attempt", async () => {
    process.env.RUN402_TRACE = "1";
    const kernel = makeKernel(async () => makeRes({ ok: true }));
    await request(kernel, "/projects/v1?secret=shh", { method: "POST", context: "listing" });
    assert.equal(stderrLines.length, 1);
    assert.match(stderrLines[0]!, /^r402 POST \/projects\/v1 -> 200 \d+ms attempt=1\n$/);
    assert.doesNotMatch(stderrLines[0]!, /secret/, "the query string must never appear in the trace line");
    restoreEnv();
  });

  it("RUN402_TRACE: a non-2xx status still traces, with the real status code", async () => {
    process.env.RUN402_TRACE = "1";
    const kernel = makeKernel(async () => makeRes({ error: "nope" }, { status: 404 }));
    await assert.rejects(request(kernel, "/x", { context: "x" }));
    assert.equal(stderrLines.length, 1);
    assert.match(stderrLines[0]!, /^r402 GET \/x -> 404 \d+ms attempt=1\n$/);
    restoreEnv();
  });

  it("RUN402_TRACE: a network failure traces with status ERR instead of throwing during tracing", async () => {
    process.env.RUN402_TRACE = "1";
    const kernel = makeKernel(async () => { throw new Error("ECONNREFUSED"); });
    await assert.rejects(request(kernel, "/x", { context: "x" }));
    assert.equal(stderrLines.length, 1);
    assert.match(stderrLines[0]!, /^r402 GET \/x -> ERR \d+ms attempt=1\n$/);
    restoreEnv();
  });

  it("RUN402_TRACE: attempt is threaded from RequestOptions.attempt, default 1", async () => {
    process.env.RUN402_TRACE = "1";
    const kernel = makeKernel(async () => makeRes({ ok: true }));
    await request(kernel, "/x", { context: "x", attempt: 3 });
    assert.match(stderrLines[0]!, /attempt=3$/m);
    restoreEnv();
  });

  it("buildClient(kernel).stats() accumulates round_trips/wire_ms/bytes across multiple requests on one client", async () => {
    delete process.env.RUN402_TRACE;
    const kernel = makeKernel(async () => makeRes({ hello: "world" }));
    const client = buildClient(kernel);
    assert.deepEqual(client.stats(), { round_trips: 0, wire_ms: 0, bytes_up: 0, bytes_down: 0 });
    await client.request("/a", { context: "a" });
    await client.request("/b", { method: "POST", body: { x: 1 }, context: "b" });
    const stats = client.stats();
    assert.equal(stats.round_trips, 2);
    assert.ok(stats.wire_ms >= 0);
    assert.ok(stats.bytes_up > 0, "the POST body's bytes must be counted");
    assert.ok(stats.bytes_down > 0, "the JSON response bytes must be counted");
    restoreEnv();
  });

  it("two separate buildClient() instances never share stats", async () => {
    delete process.env.RUN402_TRACE;
    const kernelA = makeKernel(async () => makeRes({ ok: true }));
    const kernelB = makeKernel(async () => makeRes({ ok: true }));
    const clientA = buildClient(kernelA);
    const clientB = buildClient(kernelB);
    await clientA.request("/a", { context: "a" });
    assert.equal(clientA.stats().round_trips, 1);
    assert.equal(clientB.stats().round_trips, 0);
    restoreEnv();
  });

  it("requestWithResponse called directly (bypassing buildClient) still traces but has no stats sink to mutate", async () => {
    process.env.RUN402_TRACE = "1";
    const kernel = makeKernel(async () => makeRes({ ok: true }));
    await requestWithResponse(kernel, "/x", { context: "x" });
    assert.equal(stderrLines.length, 1, "tracing works even without a stats accumulator");
    restoreEnv();
  });
});
