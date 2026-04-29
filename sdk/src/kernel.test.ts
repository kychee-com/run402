/**
 * Kernel unit tests — verify HTTP status → Run402Error mapping, auth
 * injection, body serialization, and that `process.exit` is never touched.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { request, type KernelConfig } from "./kernel.js";
import {
  ApiError,
  NetworkError,
  PaymentRequired,
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
      next_actions: [{ action: "renew_tier" }],
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
        assert.deepEqual(e.nextActions, [{ action: "renew_tier" }]);
        return true;
      },
    );
    exitSpy.restore();
  });

  it("leaves canonical projections undefined for legacy-only bodies", async () => {
    const body = { error: "internal" };
    const kernel = makeKernel(async () => makeRes(body, { status: 500 }));
    await assert.rejects(
      request(kernel, "/x", { context: "calling x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        const e = err as ApiError;
        assert.deepEqual(e.body, body);
        assert.equal(e.message, "internal while calling x (HTTP 500)");
        assert.equal(e.code, undefined);
        assert.equal(e.category, undefined);
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
        assert.equal(e.category, undefined);
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
