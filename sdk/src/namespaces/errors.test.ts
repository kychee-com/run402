import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isLocalError, isApiError, isUnauthorized } from "../index.js";
import type { CredentialsProvider, ProjectKeys } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function headerRecord(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: headerRecord(init),
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

/** Serve a fixed queue of responses, one per call (last repeats if overrun). */
function mockSequence(
  responses: Array<() => Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  let i = 0;
  return mockFetch(() => {
    const make = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return make();
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const KEYS: ProjectKeys = { anon_key: "anon.jwt.test", service_key: "service.jwt.test" };

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProjectCredentials() {
      return KEYS;
    },
    async getProject() {
      return KEYS;
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl });
}

const VERDICT = {
  window: { since: "2026-07-11T00:00:00.000Z", until: "2026-07-12T00:00:00.000Z" },
  compared_release_id: "rel_new",
  baseline_release_id: "rel_old",
  new_fingerprints: 0,
  recurring_fingerprints: 2,
  invocations_in_window: 4210,
  coverage: { full_fidelity_functions: 3, coarse_functions: 1 },
  row_cap: { limit: 5000, at_cap: false },
};

const ROW = {
  fingerprint_id: "fp_deadbeef01234567",
  function: "checkout",
  kind: "uncaught",
  fingerprint_quality: "frame_names",
  error_name: "TypeError",
  message_template: 'Cannot read properties of undefined (reading "id")',
  stable_frames: ["user_default", "chargeCard"],
  count: 12,
  first_seen: "2026-07-11T09:00:00.000Z",
  last_seen: "2026-07-11T09:30:00.000Z",
  first_seen_release_id: "rel_new",
  last_seen_release_id: "rel_new",
  samples: {
    first: { id: "req_aaa", at: "2026-07-11T09:00:00.000Z", release_id: "rel_new" },
    recent: [{ id: "req_bbb", at: "2026-07-11T09:30:00.000Z", release_id: "rel_new" }],
  },
  next_actions: [
    { type: "fetch_logs", command: "run402 logs checkout --request-id req_bbb", why: "Retrieve the logs." },
  ],
};

const CLEAN_PAGE = { verdict: { ...VERDICT }, errors: [], has_more: false };
const DIRTY_PAGE = {
  verdict: { ...VERDICT, new_fingerprints: 1 },
  errors: [ROW],
  has_more: false,
};

describe("errors.list", () => {
  it("GETs the project errors route with no query when no options given", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/errors");
      return jsonResponse(CLEAN_PAGE);
    });
    const page = await makeSdk(fetch).errors.list("prj_1");
    // Envelope passed through untouched — the gateway's verdict is the truth.
    assert.equal(page.verdict.new_fingerprints, 0);
    assert.equal(page.verdict.baseline_release_id, "rel_old");
    assert.equal(page.has_more, false);
    // Authorized with the addressed project's OWN key on the apikey header.
    assert.equal(calls[0]!.headers["apikey"], "service.jwt.test");
  });

  it("maps newIn → new_in and passes every other filter through 1:1", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(
        call.url,
        "https://api.example.test/projects/v1/prj_1/errors?" +
          "since=2026-07-01T00%3A00%3A00Z&until=2026-07-02T00%3A00%3A00Z&function=checkout&kind=uncaught&" +
          "fingerprint=fp_abc&new_in=rel_x&limit=25&cursor=cur_opaque",
      );
      return jsonResponse(CLEAN_PAGE);
    });
    await makeSdk(fetch).errors.list("prj_1", {
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-02T00:00:00Z",
      function: "checkout",
      kind: "uncaught",
      fingerprint: "fp_abc",
      newIn: "rel_x",
      limit: 25,
      cursor: "cur_opaque",
    });
  });

  it("passes new_in=active through verbatim (gateway resolves the live release)", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/errors?new_in=active");
      return jsonResponse(CLEAN_PAGE);
    });
    await makeSdk(fetch).errors.list("prj_1", { newIn: "active" });
  });

  it("returns errors[] + next_cursor untouched", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ ...DIRTY_PAGE, has_more: true, next_cursor: "cur_next" }),
    );
    const page = await makeSdk(fetch).errors.list("prj_1", { newIn: "rel_new" });
    assert.equal(page.errors.length, 1);
    assert.equal(page.errors[0]!.fingerprint_id, "fp_deadbeef01234567");
    assert.equal(page.errors[0]!.next_actions[0]!.command, "run402 logs checkout --request-id req_bbb");
    assert.equal(page.has_more, true);
    assert.equal(page.next_cursor, "cur_next");
  });

  it("URL-encodes the projectId", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/prj%2Fweird/errors");
      return jsonResponse(CLEAN_PAGE);
    });
    await makeSdk(fetch).errors.list("prj/weird");
  });

  it("rejects locally when projectId is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(CLEAN_PAGE));
    await assert.rejects(makeSdk(fetch).errors.list(""), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });

  it("is available project-scoped with the id pre-bound", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_9/errors?new_in=rel_new");
      return jsonResponse(CLEAN_PAGE);
    });
    const scoped = await makeSdk(fetch).project("prj_9");
    const page = await scoped.errors.list({ newIn: "rel_new" });
    assert.equal(page.verdict.compared_release_id, "rel_new");
  });
});

describe("errors.get", () => {
  it("GETs the fingerprint detail route and passes the detail through", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(
        call.url,
        "https://api.example.test/projects/v1/prj_1/errors/fp_deadbeef01234567",
      );
      return jsonResponse({ ...ROW, also_seen_in_functions: ["reports"] });
    });
    const detail = await makeSdk(fetch).errors.get("prj_1", "fp_deadbeef01234567");
    assert.equal(detail.fingerprint_id, "fp_deadbeef01234567");
    assert.deepEqual(detail.also_seen_in_functions, ["reports"]);
    assert.equal(calls[0]!.headers["apikey"], "service.jwt.test");
  });

  it("URL-encodes both projectId and fingerprintId", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/p%2F1/errors/fp%2Fx");
      return jsonResponse(ROW);
    });
    await makeSdk(fetch).errors.get("p/1", "fp/x");
  });

  it("rejects locally when either arg is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(ROW));
    await assert.rejects(makeSdk(fetch).errors.get("", "fp_1"), (err: unknown) => isLocalError(err));
    await assert.rejects(makeSdk(fetch).errors.get("prj_1", ""), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });
});

describe("errors.watch", () => {
  it("requires newIn", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(CLEAN_PAGE));
    await assert.rejects(
      // @ts-expect-error — newIn is required by the type; assert the runtime guard too.
      makeSdk(fetch).errors.watch("prj_1", {}),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });

  it("clean run: two polls of zero new fingerprints → clean:true", async () => {
    const { fetch, calls } = mockSequence([() => jsonResponse(CLEAN_PAGE)]);
    // durationMs < intervalMs ⇒ exactly two polls: the immediate one (elapsed
    // ~0 < durationMs, so not final), then one final poll once the window has
    // elapsed (elapsed ~intervalMs ≥ durationMs).
    const res = await makeSdk(fetch).errors.watch("prj_1", {
      newIn: "rel_new",
      durationMs: 10,
      intervalMs: 40,
    });
    assert.equal(res.clean, true);
    assert.equal(res.verdict.new_fingerprints, 0);
    assert.equal(res.polls, 2);
    assert.equal(calls.length, 2);
    assert.equal(res.aborted, undefined);
    assert.deepEqual(res.new_errors, []);
  });

  it("invokes onPoll after each successful poll", async () => {
    const { fetch } = mockSequence([() => jsonResponse(CLEAN_PAGE)]);
    const seen: number[] = [];
    const res = await makeSdk(fetch).errors.watch("prj_1", {
      newIn: "rel_new",
      durationMs: 10,
      intervalMs: 40,
      onPoll: (_page, meta) => seen.push(meta.poll),
    });
    assert.deepEqual(seen, [1, 2]);
    assert.equal(res.polls, 2);
  });

  it("fail-fast: stops the moment new_fingerprints > 0", async () => {
    const { fetch, calls } = mockSequence([
      () => jsonResponse(CLEAN_PAGE),
      () => jsonResponse(DIRTY_PAGE),
    ]);
    const res = await makeSdk(fetch).errors.watch("prj_1", {
      newIn: "rel_new",
      durationMs: 10_000,
      intervalMs: 1,
    });
    assert.equal(res.clean, false);
    assert.equal(res.verdict.new_fingerprints, 1);
    assert.equal(res.new_errors.length, 1);
    assert.equal(res.new_errors[0]!.fingerprint_id, "fp_deadbeef01234567");
    assert.equal(res.polls, 2);
    assert.equal(calls.length, 2);
  });

  it("failFast:false keeps polling despite new fingerprints until the window ends", async () => {
    const { fetch } = mockSequence([() => jsonResponse(DIRTY_PAGE)]);
    const res = await makeSdk(fetch).errors.watch("prj_1", {
      newIn: "rel_new",
      durationMs: 10,
      intervalMs: 40,
      failFast: false,
    });
    // Did not short-circuit — ran the immediate + final poll.
    assert.equal(res.polls, 2);
    assert.equal(res.clean, false);
  });

  it("a 4xx (non-408/429) aborts immediately — auth/validation won't heal", async () => {
    const { fetch, calls } = mockSequence([
      () => jsonResponse({ error: "Not authorized for this project's errors", code: "FORBIDDEN" }, 403),
    ]);
    await assert.rejects(
      makeSdk(fetch).errors.watch("prj_1", { newIn: "rel_new", durationMs: 10_000, intervalMs: 1 }),
      (err: unknown) => isUnauthorized(err),
    );
    assert.equal(calls.length, 1);
  });

  it("tolerates transient failures but rethrows after 3 consecutive; a success resets the counter", async () => {
    const { fetch, calls } = mockSequence([
      () => jsonResponse({ error: "boom" }, 500),
      () => jsonResponse({ error: "boom" }, 500),
      () => jsonResponse(CLEAN_PAGE), // success → resets the streak
      () => jsonResponse({ error: "boom" }, 500),
      () => jsonResponse({ error: "boom" }, 500),
      () => jsonResponse({ error: "boom" }, 500), // 3rd consecutive after reset → rethrow
    ]);
    await assert.rejects(
      makeSdk(fetch).errors.watch("prj_1", { newIn: "rel_new", durationMs: 10_000, intervalMs: 1 }),
      (err: unknown) => isApiError(err) && (err as { status?: number }).status === 500,
    );
    // 6 calls proves the mid-run success reset the failure counter (without the
    // reset it would have thrown at the 3rd call).
    assert.equal(calls.length, 6);
  });

  it("signal abort after a successful poll → returns result-so-far with aborted:true", async () => {
    const { fetch } = mockSequence([() => jsonResponse(CLEAN_PAGE)]);
    const controller = new AbortController();
    const res = await makeSdk(fetch).errors.watch("prj_1", {
      newIn: "rel_new",
      durationMs: 10_000,
      intervalMs: 50,
      signal: controller.signal,
      onPoll: () => controller.abort(),
    });
    assert.equal(res.aborted, true);
    assert.equal(res.clean, true);
    assert.equal(res.polls, 1);
  });

  it("signal already aborted before any poll → throws LocalError, no fetch", async () => {
    const { fetch, calls } = mockSequence([() => jsonResponse(CLEAN_PAGE)]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      makeSdk(fetch).errors.watch("prj_1", { newIn: "rel_new", signal: controller.signal }),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });
});
