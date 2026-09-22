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

describe("grants.create with a key", () => {
  it("maps the key request to snake_case and returns the once-only token", async () => {
    const { fetch } = mockFetch((call) => {
      assert.deepEqual(JSON.parse(String(call.body)), {
        wallet: "0xABC",
        capability: "deploy",
        key: {
          kind: "run402_agent_key",
          spend_cap: { v: 1, currency: "usd_micros", per_period: 5_000_000, period: "month" },
          expires_at: "2026-12-31T00:00:00Z",
        },
      });
      return jsonResponse({
        status: "ok",
        grant_id: "grt_k",
        principal_id: "prn_1",
        key: { key_id: "key_1", kind: "run402_agent_key", token: "tok_once", expires_at: "2026-12-31T00:00:00Z" },
      }, 201);
    });
    const res = await makeSdk(fetch).grants.create("prj_1", {
      wallet: "0xABC",
      capability: "deploy",
      key: {
        kind: "run402_agent_key",
        spendCap: { v: 1, currency: "usd_micros", per_period: 5_000_000, period: "month" },
        expiresAt: "2026-12-31T00:00:00Z",
      },
    });
    assert.equal(res.key?.token, "tok_once");
  });

  it("sends key: {} when every default is taken", async () => {
    const { fetch } = mockFetch((call) => {
      assert.deepEqual(JSON.parse(String(call.body)), { wallet: "0xABC", capability: "deploy", key: {} });
      return jsonResponse({ status: "ok", grant_id: "grt_k", principal_id: "prn_1" }, 201);
    });
    await makeSdk(fetch).grants.create("prj_1", { wallet: "0xABC", capability: "deploy", key: {} });
  });
});

describe("grants.list", () => {
  it("GETs the project grants route and returns grants with keys nested", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/grants");
      return jsonResponse({
        grants: [{ grant_id: "grt_1", principal_id: "prn_1", wallet: "0xabc", capability: "deploy", policy: {}, expires_at: null, revoked_at: null, created_at: "2026-09-22T00:00:00Z", keys: [{ key_id: "key_1", grant_id: "grt_1" }] }],
      });
    });
    const res = await makeSdk(fetch).grants.list("prj_1");
    assert.equal(res.grants[0]?.keys[0]?.key_id, "key_1");
  });
});

describe("grant keys", () => {
  it("createKey POSTs the grant's keys route", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/grants/grt_1/keys");
      assert.deepEqual(JSON.parse(String(call.body)), { scope: { v: 1, capabilities: ["deploy"] } });
      return jsonResponse({ status: "ok", grant_id: "grt_1", key: { key_id: "key_2", kind: "run402_agent_key", token: "tok", expires_at: null } }, 201);
    });
    const res = await makeSdk(fetch).grants.createKey("prj_1", "grt_1", { scope: { v: 1, capabilities: ["deploy"] } });
    assert.equal(res.key.key_id, "key_2");
  });

  it("revokeKey DELETEs the grant-keys route", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "DELETE");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/grant-keys/key_1");
      return jsonResponse({ status: "revoked", key_id: "key_1" });
    });
    const res = await makeSdk(fetch).grants.revokeKey("prj_1", "key_1");
    assert.equal(res.key_id, "key_1");
  });

  it("rotateKey POSTs the rotate route", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/grant-keys/key_1/rotate");
      return jsonResponse({ status: "rotated", replaced_key_id: "key_1", grant_id: "grt_1", key: { key_id: "key_3", kind: "run402_agent_key", token: "tok2", expires_at: null } }, 201);
    });
    const res = await makeSdk(fetch).grants.rotateKey("prj_1", "key_1");
    assert.equal(res.replaced_key_id, "key_1");
    assert.equal(res.key.token, "tok2");
  });

  it("throws LocalError without a key id", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(makeSdk(fetch).grants.revokeKey("prj_1", ""), (e: unknown) => isLocalError(e));
    await assert.rejects(makeSdk(fetch).grants.rotateKey("prj_1", ""), (e: unknown) => isLocalError(e));
    await assert.rejects(makeSdk(fetch).grants.createKey("prj_1", ""), (e: unknown) => isLocalError(e));
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

  it("pre-binds the project id on list and the key verbs", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ grants: [] }));
    const p = await makeSdk(fetch).project("prj_scoped");
    await p.grants.list();
    await p.grants.createKey("grt_1");
    await p.grants.revokeKey("key_1");
    await p.grants.rotateKey("key_1");
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
      "GET https://api.example.test/projects/v1/prj_scoped/grants",
      "POST https://api.example.test/projects/v1/prj_scoped/grants/grt_1/keys",
      "DELETE https://api.example.test/projects/v1/prj_scoped/grant-keys/key_1",
      "POST https://api.example.test/projects/v1/prj_scoped/grant-keys/key_1/rotate",
    ]);
  });
});
