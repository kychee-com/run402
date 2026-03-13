import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Save original fetch and env
const originalFetch = globalThis.fetch;
const originalApiBase = process.env.RUN402_API_BASE;

let mockFetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  // Set a test base URL so we can verify path construction
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  // Default mock — will be overridden per test
  mockFetch = async () => new Response("", { status: 500 });
  globalThis.fetch = mockFetch as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiBase !== undefined) {
    process.env.RUN402_API_BASE = originalApiBase;
  } else {
    delete process.env.RUN402_API_BASE;
  }
});

// Dynamic import so config picks up env var set in beforeEach
async function loadClient() {
  // Bust the module cache to pick up updated env vars
  const mod = await import(`./client.js?t=${Date.now()}`);
  return mod.apiRequest as typeof import("./client.js").apiRequest;
}

describe("client.apiRequest", () => {
  it("returns parsed JSON for 200 response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "proj-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    const result = await apiRequest("/projects/v1");
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { id: "proj-1" });
  });

  it("returns is402 for 402 response", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          x402: { price: "$0.10", network: "base-sepolia" },
        }),
        {
          status: 402,
          headers: { "Content-Type": "application/json" },
        },
      )) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    const result = await apiRequest("/projects/v1");
    assert.equal(result.ok, false);
    assert.equal(result.is402, true);
    assert.equal(result.status, 402);
    assert.ok((result.body as Record<string, unknown>).x402);
  });

  it("returns ok:false for 401 response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    const result = await apiRequest("/projects/v1");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it("returns ok:false for 500 response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Internal" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    const result = await apiRequest("/health");
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  });

  it("handles network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    const result = await apiRequest("/health");
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    const body = result.body as Record<string, string>;
    assert.ok(body.error.includes("ECONNREFUSED"));
  });

  it("returns raw text for non-JSON response", async () => {
    globalThis.fetch = (async () =>
      new Response("OK", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    const result = await apiRequest("/health");
    assert.equal(result.ok, true);
    assert.equal(result.body, "OK");
  });

  it("forwards custom headers", async () => {
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    await apiRequest("/test", {
      headers: { Authorization: "Bearer token123" },
    });
    assert.equal(
      (capturedHeaders as Record<string, string>)["Authorization"],
      "Bearer token123",
    );
  });

  it("sends rawBody as-is without JSON encoding", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    await apiRequest("/projects/v1/admin/p1/sql", {
      method: "POST",
      rawBody: "SELECT 1",
      headers: { "Content-Type": "text/plain" },
    });
    assert.equal(capturedBody, "SELECT 1");
  });

  it("sends JSON body when body is provided", async () => {
    let capturedBody: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { apiRequest } = await import("./client.js");
    await apiRequest("/projects/v1", {
      method: "POST",
      body: { tier: "prototype" },
    });
    assert.equal(capturedBody, '{"tier":"prototype"}');
    assert.equal(capturedHeaders?.["Content-Type"], "application/json");
  });
});
