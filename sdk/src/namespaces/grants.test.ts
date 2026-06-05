import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isLocalError } from "../index.js";
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
      body: init?.body ?? null,
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

describe("grants.create", () => {
  it("POSTs the project grants route with wallet + capability only", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/grants");
      assert.deepEqual(JSON.parse(String(call.body)), { wallet: "0xABC", capability: "deploy" });
      return jsonResponse({ status: "ok", grant_id: "grt_1", principal_id: "prn_1" }, 201);
    });
    const res = await makeSdk(fetch).grants.create("prj_1", { wallet: "0xABC", capability: "deploy" });
    assert.equal(res.grant_id, "grt_1");
  });

  it("maps policy + expiresAt → policy + expires_at on the wire", async () => {
    const { fetch } = mockFetch((call) => {
      assert.deepEqual(JSON.parse(String(call.body)), {
        wallet: "0xABC",
        capability: "functions:write",
        policy: { paths: ["/api/*"] },
        expires_at: "2026-12-31T00:00:00Z",
      });
      return jsonResponse({ status: "ok", grant_id: "grt_2", principal_id: "prn_1" }, 201);
    });
    await makeSdk(fetch).grants.create("prj_1", {
      wallet: "0xABC",
      capability: "functions:write",
      policy: { paths: ["/api/*"] },
      expiresAt: "2026-12-31T00:00:00Z",
    });
  });

  it("throws LocalError without capability", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    // @ts-expect-error intentionally missing capability
    await assert.rejects(makeSdk(fetch).grants.create("prj_1", { wallet: "0xABC" }), (e: unknown) =>
      isLocalError(e),
    );
    assert.equal(calls.length, 0);
  });
});

describe("grants.revoke", () => {
  it("DELETEs the grant route, encoding ids", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "DELETE");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/grants/grt_1");
      return jsonResponse({ status: "revoked", grant_id: "grt_1" });
    });
    const res = await makeSdk(fetch).grants.revoke("prj_1", "grt_1");
    assert.equal(res.status, "revoked");
  });

  it("throws LocalError without a grant id", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(makeSdk(fetch).grants.revoke("prj_1", ""), (e: unknown) => isLocalError(e));
    assert.equal(calls.length, 0);
  });
});

describe("scoped grants (r.project(id).grants)", () => {
  it("pre-binds the project id from the scope", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_scoped/grants");
      assert.deepEqual(JSON.parse(String(call.body)), { wallet: "0xABC", capability: "deploy" });
      return jsonResponse({ status: "ok", grant_id: "grt_3", principal_id: "prn_1" }, 201);
    });
    const p = await makeSdk(fetch).project("prj_scoped");
    const res = await p.grants.create({ wallet: "0xABC", capability: "deploy" });
    assert.equal(res.grant_id, "grt_3");
  });
});
