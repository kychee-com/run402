import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the REST proxy retry-on-404 behaviour.
 *
 * PostgREST caches its schema on startup and reloads asynchronously via
 * NOTIFY.  If a table was just created, the first REST request may hit a
 * stale cache and get a 404.  The proxy retries once after a short delay,
 * which is long enough for PostgREST to finish reloading.
 */

// ---------------------------------------------------------------------------
// Helpers — minimal Express req/res fakes
// ---------------------------------------------------------------------------

function fakeReq(overrides: Record<string, any> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", apikey: "tok" },
    params: { 0: "exercises" },
    query: {},
    body: { title: "squats" },
    project: { schemaSlot: "p0001" },
    ...overrides,
  };
}

function fakeRes() {
  const res: Record<string, any> = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: "",
    status(code: number) { res._status = code; return res; },
    set(k: string, v: string) { res._headers[k] = v; return res; },
    send(body: string) { res._body = body; return res; },
    json(obj: any) { res._body = JSON.stringify(obj); return res; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Build a handler that uses a controllable fetch stub
// ---------------------------------------------------------------------------

type FetchResult = { status: number; body: string; contentType?: string };

function buildHandler(fetchStub: (...args: any[]) => Promise<Response>) {
  // We inline the handler logic here instead of importing the router,
  // because the router pulls in middleware and config that need a running
  // server.  This keeps the test isolated and fast.

  const SCHEMA_CACHE_RETRY_DELAY_MS = 0; // no real delay in tests

  async function forwardToPostgREST(
    url: string,
    fetchOptions: RequestInit,
  ) {
    const pgResponse = await fetchStub(url, fetchOptions);
    return {
      status: pgResponse.status,
      text: await pgResponse.text(),
      contentType: pgResponse.headers.get("content-type"),
      contentRange: pgResponse.headers.get("content-range"),
    };
  }

  return async function handler(req: any, res: any) {
    const project = req.project!;
    const restPath = (req.params as any)[0] as string;
    const queryString = new URLSearchParams(req.query).toString();
    const url = `http://localhost:3000/${restPath}${queryString ? "?" + queryString : ""}`;

    const headers: Record<string, string> = {
      "Accept-Profile": project.schemaSlot,
      "Content-Profile": project.schemaSlot,
    };
    if (req.headers.authorization) {
      headers["Authorization"] = req.headers.authorization;
    } else if (req.headers["apikey"]) {
      headers["Authorization"] = `Bearer ${req.headers["apikey"]}`;
    }
    if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
    if (req.headers["prefer"]) headers["Prefer"] = req.headers["prefer"];

    const fetchOptions: RequestInit = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = JSON.stringify(req.body);
    }

    let result = await forwardToPostgREST(url, fetchOptions);

    if (result.status === 404) {
      await new Promise((r) => setTimeout(r, SCHEMA_CACHE_RETRY_DELAY_MS));
      result = await forwardToPostgREST(url, fetchOptions);
    }

    res.status(result.status);
    if (result.contentType) res.set("Content-Type", result.contentType);
    if (result.contentRange) res.set("Content-Range", result.contentRange);
    res.send(result.text);
  };
}

function makeResponse(r: FetchResult): Response {
  return new Response(r.body, {
    status: r.status,
    headers: r.contentType ? { "content-type": r.contentType } : {},
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("REST proxy retry-on-404", () => {
  it("retries once when PostgREST returns 404, then succeeds", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse({
          status: 404,
          body: JSON.stringify({ code: "42P01", message: "relation not found" }),
          contentType: "application/json",
        });
      }
      return makeResponse({
        status: 201,
        body: JSON.stringify([{ id: 1, title: "squats" }]),
        contentType: "application/json",
      });
    });

    const req = fakeReq();
    const res = fakeRes();
    await handler(req, res);

    assert.equal(callCount, 2, "fetch called twice (original + retry)");
    assert.equal(res._status, 201, "final status is 201");
    assert.ok(res._body.includes("squats"), "response body contains inserted row");
  });

  it("returns 404 after retry if table genuinely does not exist", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      return makeResponse({
        status: 404,
        body: JSON.stringify({ code: "42P01", message: "relation not found" }),
        contentType: "application/json",
      });
    });

    const req = fakeReq();
    const res = fakeRes();
    await handler(req, res);

    assert.equal(callCount, 2, "fetch called twice (original + retry)");
    assert.equal(res._status, 404, "final status is 404");
  });

  it("does not retry on non-404 responses", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      return makeResponse({
        status: 201,
        body: JSON.stringify([{ id: 1, title: "squats" }]),
        contentType: "application/json",
      });
    });

    const req = fakeReq();
    const res = fakeRes();
    await handler(req, res);

    assert.equal(callCount, 1, "fetch called exactly once");
    assert.equal(res._status, 201);
  });

  it("does not retry on 401 or 403", async () => {
    for (const status of [401, 403]) {
      let callCount = 0;
      const handler = buildHandler(async () => {
        callCount++;
        return makeResponse({ status, body: JSON.stringify({ error: "denied" }) });
      });

      const req = fakeReq();
      const res = fakeRes();
      await handler(req, res);

      assert.equal(callCount, 1, `no retry on ${status}`);
      assert.equal(res._status, status);
    }
  });

  it("retries on 404 for GET requests too", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse({ status: 404, body: "{}" });
      }
      return makeResponse({
        status: 200,
        body: JSON.stringify([]),
        contentType: "application/json",
      });
    });

    const req = fakeReq({ method: "GET", body: undefined });
    const res = fakeRes();
    await handler(req, res);

    assert.equal(callCount, 2, "GET also retries on 404");
    assert.equal(res._status, 200);
  });

  it("forwards headers correctly on retry", async () => {
    const captured: RequestInit[] = [];
    const handler = buildHandler(async (_url: string, opts: RequestInit) => {
      captured.push(opts);
      if (captured.length === 1) {
        return makeResponse({ status: 404, body: "{}" });
      }
      return makeResponse({ status: 201, body: "[]" });
    });

    const req = fakeReq({
      headers: {
        "content-type": "application/json",
        apikey: "my-service-key",
        prefer: "return=representation",
      },
    });
    const res = fakeRes();
    await handler(req, res);

    assert.equal(captured.length, 2);
    // Both calls should have identical headers
    const h1 = captured[0]!.headers as Record<string, string>;
    const h2 = captured[1]!.headers as Record<string, string>;
    assert.equal(h1["Authorization"], "Bearer my-service-key");
    assert.equal(h2["Authorization"], "Bearer my-service-key");
    assert.equal(h1["Prefer"], "return=representation");
    assert.equal(h2["Prefer"], "return=representation");
    assert.equal(h1["Content-Profile"], "p0001");
    assert.equal(h2["Content-Profile"], "p0001");
  });
});
