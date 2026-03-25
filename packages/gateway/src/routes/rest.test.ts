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

function isSchemaCacheError(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status === 400) {
    try {
      const parsed = JSON.parse(body);
      return parsed.code === "PGRST204";
    } catch { return false; }
  }
  return false;
}

function buildHandler(fetchStub: (...args: any[]) => Promise<Response>, maxRetries = 3) {
  // We inline the handler logic here instead of importing the router,
  // because the router pulls in middleware and config that need a running
  // server.  This keeps the test isolated and fast.

  const SCHEMA_CACHE_RETRY_DELAY_MS = 0; // no real delay in tests
  const SCHEMA_CACHE_MAX_RETRIES = maxRetries;

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
    const splatParam = (req.params as any)["splat"] ?? (req.params as any)[0];
    const restPath = Array.isArray(splatParam) ? splatParam.join("/") : splatParam as string;
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

    let retries = 0;
    while (isSchemaCacheError(result.status, result.text) && retries < SCHEMA_CACHE_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, SCHEMA_CACHE_RETRY_DELAY_MS));
      result = await forwardToPostgREST(url, fetchOptions);
      retries++;
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
  it("retries on 404 then succeeds when cache reloads", async () => {
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

    assert.equal(callCount, 2, "fetch called twice (original + 1 retry)");
    assert.equal(res._status, 201, "final status is 201");
    assert.ok(res._body.includes("squats"), "response body contains inserted row");
  });

  it("returns 404 after all retries if table genuinely does not exist", async () => {
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

    assert.equal(callCount, 4, "fetch called 4 times (original + 3 retries)");
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
      if (callCount <= 2) {
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

    assert.equal(callCount, 3, "GET retries until success (2 x 404 + 1 x 200)");
    assert.equal(res._status, 200);
  });

  it("forwards headers correctly on every retry", async () => {
    const captured: RequestInit[] = [];
    const handler = buildHandler(async (_url: string, opts: RequestInit) => {
      captured.push(opts);
      if (captured.length <= 2) {
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

    assert.equal(captured.length, 3, "original + 2 retries before success");
    // All calls should have identical headers
    for (let i = 0; i < captured.length; i++) {
      const h = captured[i]!.headers as Record<string, string>;
      assert.equal(h["Authorization"], "Bearer my-service-key", `call ${i}: Authorization`);
      assert.equal(h["Prefer"], "return=representation", `call ${i}: Prefer`);
      assert.equal(h["Content-Profile"], "p0001", `call ${i}: Content-Profile`);
    }
  });
});

// ---------------------------------------------------------------------------
// Race condition tests — rapid concurrent POSTs after table creation
// ---------------------------------------------------------------------------

describe("REST proxy race conditions (concurrent inserts after DDL)", () => {
  /**
   * Scenario: 5 rapid concurrent POST /recipes requests right after CREATE TABLE.
   * PostgREST's schema cache reloads asynchronously — some requests hit the stale
   * cache (404) and get retried, while others arrive after reload (201 immediately).
   *
   * This simulates the reported bug where "first two inserts returned id: undefined".
   */
  it("concurrent POSTs: all get 201 with valid body when cache reloads mid-flight", async () => {
    // Simulate PostgREST reloading after the 3rd fetch call (mix of 404s and 201s)
    let fetchCall = 0;
    const handler = buildHandler(async () => {
      fetchCall++;
      const call = fetchCall;
      // Calls 1-2: stale cache (404). Calls 3+: cache reloaded (201).
      if (call <= 2) {
        return makeResponse({
          status: 404,
          body: JSON.stringify({ code: "42P01", message: "relation not found" }),
          contentType: "application/json",
        });
      }
      // After reload: PostgREST returns proper 201 with array body
      const id = call - 2; // IDs start at 1
      return makeResponse({
        status: 201,
        body: JSON.stringify([{ id, title: `Recipe ${id}` }]),
        contentType: "application/json",
      });
    });

    // Fire 5 concurrent requests
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => {
        const req = fakeReq({ body: { title: `Recipe ${i + 1}` } });
        const res = fakeRes();
        return handler(req, res).then(() => ({
          status: res._status,
          body: res._body,
          parsed: (() => { try { return JSON.parse(res._body); } catch { return null; } })(),
        }));
      }),
    );

    // Every request must have returned 201 with a parseable array containing an id
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      assert.equal(r.status, 201, `request ${i}: status should be 201 (got ${r.status})`);
      assert.ok(r.parsed !== null, `request ${i}: body should be valid JSON`);
      assert.ok(Array.isArray(r.parsed), `request ${i}: body should be an array (got ${typeof r.parsed})`);
      assert.ok(r.parsed.length > 0, `request ${i}: array should not be empty`);
      assert.ok(r.parsed[0].id !== undefined, `request ${i}: id should not be undefined`);
    }
  });

  /**
   * Scenario: PostgREST returns 201 but with an EMPTY body on the retry path.
   * This can happen if the NOTIFY-triggered schema reload completes between the
   * 404 and the retry, but PostgREST's response for the retried INSERT omits the
   * representation (e.g., it returns 201 with no body despite Prefer header).
   *
   * The proxy forwards raw text — the client would then parse "" as JSON and fail.
   */
  it("retry returns 201 with empty body — client gets empty string, not array", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse({ status: 404, body: "{}", contentType: "application/json" });
      }
      // Retry: PostgREST returns 201 with EMPTY body (Prefer header ignored/lost)
      return makeResponse({ status: 201, body: "", contentType: "application/json" });
    });

    const req = fakeReq({
      headers: {
        "content-type": "application/json",
        apikey: "tok",
        prefer: "return=representation",
      },
    });
    const res = fakeRes();
    await handler(req, res);

    // The proxy faithfully returns the empty body — this is the bug surface!
    assert.equal(res._status, 201, "status is 201");
    assert.equal(res._body, "", "body is empty string — client JSON.parse will throw");
    // Client code doing `const data = await res.json()` would throw SyntaxError.
    // Client code doing `body[0]?.id` after successful parse of `""` → crash.
    assert.throws(() => JSON.parse(res._body), "JSON.parse on empty body throws");
  });

  /**
   * Scenario: PostgREST returns 201 with bare object `{}` instead of `[{...}]`.
   * This should NOT happen with standard PostgREST, but if PostgREST's
   * representation logic has a race with schema reload, it might return a
   * minimal acknowledgment instead of the full row.
   *
   * Client code doing `body[0]?.id` gets undefined because `{}[0]` is undefined.
   */
  it("201 with bare object instead of array — body[0]?.id is undefined", async () => {
    const handler = buildHandler(async () => {
      // PostgREST returns a bare object instead of an array (hypothetical race)
      return makeResponse({
        status: 201,
        body: JSON.stringify({}),
        contentType: "application/json",
      });
    });

    const req = fakeReq();
    const res = fakeRes();
    await handler(req, res);

    const parsed = JSON.parse(res._body);
    assert.equal(res._status, 201, "status is 201 — looks successful");
    assert.equal(Array.isArray(parsed), false, "body is NOT an array");
    // This is the exact bug: status 201 suggests success, but extraction fails
    assert.equal(parsed[0]?.id, undefined, "body[0]?.id is undefined — the reported bug");
  });

  /**
   * Scenario: Concurrent requests share the same fetchOptions object.
   * Since buildHandler constructs fetchOptions once per request handler call,
   * this is safe. But let's verify that concurrent handlers don't cross-talk
   * via shared mutable state.
   */
  it("concurrent handlers do not share mutable state", async () => {
    const bodies: string[] = [];
    const handler = buildHandler(async (_url: string, opts: RequestInit) => {
      // Capture the body sent to PostgREST
      bodies.push(opts.body as string);
      const parsed = JSON.parse(opts.body as string);
      return makeResponse({
        status: 201,
        body: JSON.stringify([{ id: parsed.title === "A" ? 1 : 2, title: parsed.title }]),
        contentType: "application/json",
      });
    });

    const reqA = fakeReq({ body: { title: "A" } });
    const resA = fakeRes();
    const reqB = fakeReq({ body: { title: "B" } });
    const resB = fakeRes();

    await Promise.all([handler(reqA, resA), handler(reqB, resB)]);

    const parsedA = JSON.parse(resA._body);
    const parsedB = JSON.parse(resB._body);
    // Each response must have the correct title — no cross-contamination
    assert.equal(parsedA[0].title, "A", "response A has title A");
    assert.equal(parsedB[0].title, "B", "response B has title B");
    assert.equal(parsedA[0].id, 1, "response A has id 1");
    assert.equal(parsedB[0].id, 2, "response B has id 2");
  });

  /**
   * Scenario: 404-retry race where the retry ALSO returns 404.
   * All concurrent requests should propagate the 404 — none should hang or
   * return undefined body.
   */
  it("concurrent requests all hitting persistent 404 — no hangs", async () => {
    const handler = buildHandler(async () => {
      return makeResponse({
        status: 404,
        body: JSON.stringify({ code: "42P01", message: "relation not found" }),
        contentType: "application/json",
      });
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => {
        const req = fakeReq();
        const res = fakeRes();
        return handler(req, res).then(() => ({
          status: res._status,
          body: res._body,
        }));
      }),
    );

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i]!.status, 404, `request ${i}: 404 propagated`);
      assert.ok(results[i]!.body.length > 0, `request ${i}: body is not empty`);
    }
  });

  /**
   * Scenario: Staggered schema reload — first 2 requests get 404→201 (retry),
   * requests 3-5 get 201 immediately. Simulates PostgREST finishing its
   * NOTIFY reload 150ms after the first batch of requests.
   *
   * Checks that early requests (retried) and late requests (direct 201)
   * all return consistent array-wrapped responses.
   */
  it("staggered reload: retried and non-retried responses are consistent arrays", async () => {
    let fetchCall = 0;
    const handler = buildHandler(async () => {
      fetchCall++;
      const call = fetchCall;
      // Requests 1-2 get 404 first, then 201 on retry (calls 1,2 → 404; calls 3,4 → retry 201)
      // Requests 3-5 hit after reload (calls 5,6,7 → direct 201)
      if (call <= 2) {
        return makeResponse({
          status: 404,
          body: JSON.stringify({ code: "42P01", message: "relation not found" }),
          contentType: "application/json",
        });
      }
      const id = call - 2;
      return makeResponse({
        status: 201,
        body: JSON.stringify([{ id, title: `Recipe ${id}` }]),
        contentType: "application/json",
      });
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => {
        const req = fakeReq({ body: { title: `Recipe ${i + 1}` } });
        const res = fakeRes();
        return handler(req, res).then(() => {
          const parsed = JSON.parse(res._body);
          return {
            index: i,
            status: res._status,
            isArray: Array.isArray(parsed),
            hasId: Array.isArray(parsed) && parsed.length > 0 && parsed[0].id !== undefined,
          };
        });
      }),
    );

    for (const r of results) {
      assert.equal(r.status, 201, `request ${r.index}: got 201`);
      assert.ok(r.isArray, `request ${r.index}: body is an array`);
      assert.ok(r.hasId, `request ${r.index}: body[0].id is defined`);
    }
  });
});

// ---------------------------------------------------------------------------
// Reproducing the actual bug: single retry not enough after DDL + RLS
// ---------------------------------------------------------------------------

describe("REST proxy 404 retry — insufficient retry window (actual bug)", () => {
  /**
   * Reproduces the actual reported scenario:
   *   CREATE TABLE → RLS setup → 5 sequential POSTs (no sleep)
   *
   * PostgREST is still reloading after CREATE TABLE + RLS (multiple NOTIFY
   * signals). The single 150ms retry is not enough — both the initial request
   * AND the retry hit the stale cache. The gateway returns 404 to the client.
   *
   * The client parses the 404 error body as JSON:
   *   {"code":"42P01","message":"relation not found"}
   * Then does: Array.isArray(result) ? result[0]?.id : result.id → undefined
   *
   * The serial starts at 1 for the 3rd request because no rows were inserted
   * by the first two (they got 404, not 201).
   *
   * Result: undefined, undefined, 1, 2, 3
   */
  it("reproduces: 150ms retry fails when PostgREST takes >300ms to reload after DDL+RLS", async () => {
    // PostgREST takes ~400ms to reload (DDL + RLS = multiple NOTIFY signals).
    // Each request does: initial fetch + 150ms wait + retry = 2 fetches.
    // Sequential requests 1-5 produce fetch calls 1..10.
    //
    // Fetch calls 1-4 (requests 1-2: initial + retry each) → 404 (still reloading)
    // Fetch calls 5+  (request 3 onward) → 201 (reload complete)
    let fetchCall = 0;
    let nextId = 1;
    // Use maxRetries=1 to reproduce the old (buggy) behavior
    const handler = buildHandler(async () => {
      fetchCall++;
      if (fetchCall <= 4) {
        // PostgREST still reloading — 404 for both initial and retry of first 2 requests
        return makeResponse({
          status: 404,
          body: JSON.stringify({ code: "42P01", message: "relation \"recipes\" does not exist" }),
          contentType: "application/json",
        });
      }
      // PostgREST reloaded — 201 with representation
      return makeResponse({
        status: 201,
        body: JSON.stringify([{ id: nextId++, title: "recipe" }]),
        contentType: "application/json",
      });
    }, 1);

    // Client extraction logic (from the actual bug report):
    function extractId(body: string): number | undefined {
      const result = JSON.parse(body);
      return Array.isArray(result) ? result[0]?.id : result.id;
    }

    // Fire 5 sequential requests (like the actual client code)
    const ids: (number | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      const req = fakeReq({ body: { title: `Recipe ${i + 1}` } });
      const res = fakeRes();
      await handler(req, res);
      ids.push(extractId(res._body));
    }

    // This is exactly the observed output: undefined, undefined, 1, 2, 3
    assert.deepEqual(ids, [undefined, undefined, 1, 2, 3],
      "first two return undefined (404 error body has no .id), last three return serial 1,2,3");
  });

  /**
   * Same scenario but with an improved retry strategy (3 retries, 150ms each).
   * This gives PostgREST up to 600ms total (initial + 3 retries) to reload.
   *
   * PostgREST returns 404 for the first 3 fetch calls (simulating ~450ms
   * reload). With maxRetries=1, the first request burns calls 1-2 (both 404)
   * and fails. With maxRetries=3, the first request burns calls 1-3 (404)
   * then call 4 succeeds.
   */
  it("fix: 3 retries recovers from slow reload that defeats 1-retry strategy", async () => {
    function extractId(body: string): number | undefined {
      const result = JSON.parse(body);
      return Array.isArray(result) ? result[0]?.id : result.id;
    }

    // First, show that maxRetries=1 (old behavior) fails with this reload window
    let fetchCall = 0;
    let nextId = 1;
    const stub404then201 = () => {
      fetchCall = 0;
      nextId = 1;
      return async () => {
        fetchCall++;
        if (fetchCall <= 3) {
          return makeResponse({
            status: 404,
            body: JSON.stringify({ code: "42P01", message: "relation not found" }),
            contentType: "application/json",
          });
        }
        return makeResponse({
          status: 201,
          body: JSON.stringify([{ id: nextId++, title: "recipe" }]),
          contentType: "application/json",
        });
      };
    };

    const singleRetryHandler = buildHandler(stub404then201(), 1);

    const singleRetryIds: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const req = fakeReq({ body: { title: `Recipe ${i + 1}` } });
      const res = fakeRes();
      await singleRetryHandler(req, res);
      singleRetryIds.push(extractId(res._body));
    }
    // maxRetries=1: request 1 uses calls 1-2 (both 404) → fail.
    // Request 2 uses call 3 (404) + call 4 (201, id=1) → success.
    assert.deepEqual(singleRetryIds, [undefined, 1, 2],
      "maxRetries=1 loses the first request");

    // Now show that maxRetries=3 (new behavior) handles the same reload window
    const tripleRetryHandler = buildHandler(stub404then201(), 3);

    const tripleRetryIds: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const req = fakeReq({ body: { title: `Recipe ${i + 1}` } });
      const res = fakeRes();
      await tripleRetryHandler(req, res);
      tripleRetryIds.push(extractId(res._body));
    }
    // maxRetries=3: request 1 uses calls 1-3 (404) + call 4 (201, id=1) → success.
    assert.deepEqual(tripleRetryIds, [1, 2, 3],
      "maxRetries=3 recovers all requests — no undefined IDs");
  });
});

// ---------------------------------------------------------------------------
// PGRST204 — column not found in schema cache (new column on existing table)
// ---------------------------------------------------------------------------

describe("REST proxy retry on PGRST204 (column not found in schema cache)", () => {
  /**
   * The original bug: adding a column to an existing table, then inserting
   * with that column. PostgREST finds the table (no 404) but doesn't know
   * the new column yet → returns HTTP 400 with code PGRST204.
   */
  it("retries on PGRST204 then succeeds when schema cache reloads", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      if (callCount <= 2) {
        return makeResponse({
          status: 400,
          body: JSON.stringify({
            code: "PGRST204",
            message: "Could not find the 'description' column of 'items' in the schema cache",
          }),
          contentType: "application/json",
        });
      }
      return makeResponse({
        status: 201,
        body: JSON.stringify([{ id: 1, title: "test", description: "new column" }]),
        contentType: "application/json",
      });
    });

    const req = fakeReq({ body: { title: "test", description: "new column" } });
    const res = fakeRes();
    await handler(req, res);

    assert.equal(callCount, 3, "fetch called 3 times (2 PGRST204 + 1 success)");
    assert.equal(res._status, 201, "final status is 201");
    assert.ok(res._body.includes("description"), "response contains new column");
  });

  it("returns 400 after all retries if column genuinely does not exist", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      return makeResponse({
        status: 400,
        body: JSON.stringify({
          code: "PGRST204",
          message: "Could not find the 'nonexistent' column of 'items' in the schema cache",
        }),
        contentType: "application/json",
      });
    });

    const req = fakeReq({ body: { title: "test", nonexistent: "value" } });
    const res = fakeRes();
    await handler(req, res);

    assert.equal(callCount, 4, "fetch called 4 times (original + 3 retries)");
    assert.equal(res._status, 400, "final status is 400");
    assert.ok(res._body.includes("PGRST204"), "error code preserved");
  });

  it("does not retry on non-schema-cache 400 errors", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      return makeResponse({
        status: 400,
        body: JSON.stringify({
          code: "PGRST100",
          message: "Parsing error in filter",
        }),
        contentType: "application/json",
      });
    });

    const req = fakeReq();
    const res = fakeRes();
    await handler(req, res);

    assert.equal(callCount, 1, "no retry on non-schema-cache 400");
    assert.equal(res._status, 400);
  });

  it("does not retry on 400 with non-JSON body", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      return makeResponse({
        status: 400,
        body: "Bad Request",
        contentType: "text/plain",
      });
    });

    const req = fakeReq();
    const res = fakeRes();
    await handler(req, res);

    assert.equal(callCount, 1, "no retry on non-JSON 400");
    assert.equal(res._status, 400);
  });

  /**
   * Mixed scenario: first call returns PGRST204 (column not found),
   * retry returns 404 (table vanished during reload?), next retry succeeds.
   * Both error types should be retried.
   */
  it("retries through mixed PGRST204 and 404 errors", async () => {
    let callCount = 0;
    const handler = buildHandler(async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse({
          status: 400,
          body: JSON.stringify({ code: "PGRST204", message: "column not found" }),
          contentType: "application/json",
        });
      }
      if (callCount === 2) {
        return makeResponse({
          status: 404,
          body: JSON.stringify({ code: "42P01", message: "relation not found" }),
          contentType: "application/json",
        });
      }
      return makeResponse({
        status: 201,
        body: JSON.stringify([{ id: 1 }]),
        contentType: "application/json",
      });
    });

    const req = fakeReq();
    const res = fakeRes();
    await handler(req, res);

    assert.equal(callCount, 3, "retried through both error types");
    assert.equal(res._status, 201);
  });
});
