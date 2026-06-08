import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, ApiError, isLocalError } from "../index.js";
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

describe("org.whoami", () => {
  it("GETs /agent/v1/whoami and returns the resolved principal + memberships", async () => {
    // The gateway serializes `principal` in camelCase (displayName/createdAt),
    // unlike the snake_case memberships[] and authenticator_id.
    const payload = {
      principal: { id: "prn_1", type: "human", displayName: "Tal", createdAt: "2026-01-01T00:00:00Z" },
      memberships: [{ billing_account_id: "ba_1", role: "owner", status: "active" }],
      authenticator_id: "auth_1",
    };
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, "https://api.example.test/agent/v1/whoami");
      return jsonResponse(payload);
    });
    const r = await makeSdk(fetch).org.whoami();
    assert.deepEqual(r, payload);
    // typed camelCase fields resolve (would not compile if the type used snake_case)
    assert.equal(r.principal.displayName, "Tal");
    assert.equal(r.principal.createdAt, "2026-01-01T00:00:00Z");
    assert.equal(r.memberships[0]!.billing_account_id, "ba_1");
    assert.equal(calls.length, 1);
  });

  it("omits displayName when the gateway does (null → absent)", async () => {
    const payload = {
      principal: { id: "prn_1", type: "ci", createdAt: "2026-01-01T00:00:00Z" },
      memberships: [],
      authenticator_id: "auth_2",
    };
    const { fetch } = mockFetch(() => jsonResponse(payload));
    const r = await makeSdk(fetch).org.whoami();
    assert.equal(r.principal.displayName, undefined);
    assert.equal(r.principal.createdAt, "2026-01-01T00:00:00Z");
  });
});

describe("org.list", () => {
  it("GETs /orgs/v1 and unwraps { orgs }", async () => {
    const orgs = [{ billing_account_id: "ba_1", role: "admin", status: "active" }];
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/orgs/v1");
      return jsonResponse({ orgs });
    });
    assert.deepEqual(await makeSdk(fetch).org.list(), orgs);
  });

  it("returns [] when the gateway omits orgs", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    assert.deepEqual(await makeSdk(fetch).org.list(), []);
  });
});

describe("org.members", () => {
  it("GETs the members route and unwraps { members }, encoding the id", async () => {
    const members = [{ principal_id: "prn_2", role: "developer", status: "active" }];
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/orgs/v1/ba%2F1/members");
      return jsonResponse({ members });
    });
    assert.deepEqual(await makeSdk(fetch).org.members.list("ba/1"), members);
  });

  it("throws LocalError without a billing account id", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(makeSdk(fetch).org.members.list(""), (e: unknown) => isLocalError(e));
    assert.equal(calls.length, 0, "no network call on local validation failure");
  });
});

describe("org.addMember", () => {
  it("POSTs { wallet } and omits role when not provided", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/orgs/v1/ba_1/members");
      assert.deepEqual(JSON.parse(String(call.body)), { wallet: "0xABC" });
      return jsonResponse({ status: "ok", principal_id: "prn_3", role: "developer" }, 201);
    });
    const res = await makeSdk(fetch).org.members.add("ba_1", { wallet: "0xABC" });
    assert.equal(res.principal_id, "prn_3");
    assert.equal(res.role, "developer");
  });

  it("includes role when provided", async () => {
    const { fetch } = mockFetch((call) => {
      assert.deepEqual(JSON.parse(String(call.body)), { wallet: "0xABC", role: "admin" });
      return jsonResponse({ status: "ok", principal_id: "prn_3", role: "admin" }, 201);
    });
    await makeSdk(fetch).org.members.add("ba_1", { wallet: "0xABC", role: "admin" });
  });

  it("throws LocalError without a wallet", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    // @ts-expect-error intentionally missing wallet
    await assert.rejects(makeSdk(fetch).org.members.add("ba_1", {}), (e: unknown) => isLocalError(e));
    assert.equal(calls.length, 0);
  });
});

describe("org.setRole", () => {
  it("PATCHes the member route with { role }", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "PATCH");
      assert.equal(call.url, "https://api.example.test/orgs/v1/ba_1/members/prn_2");
      assert.deepEqual(JSON.parse(String(call.body)), { role: "owner" });
      return jsonResponse({ status: "ok", principal_id: "prn_2", role: "owner" });
    });
    const res = await makeSdk(fetch).org.members.setRole("ba_1", "prn_2", "owner");
    assert.equal(res.role, "owner");
  });

  it("surfaces 409 LAST_OWNER as an ApiError carrying the code", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ code: "LAST_OWNER", message: "The org must keep one active owner." }, 409),
    );
    await assert.rejects(
      makeSdk(fetch).org.members.setRole("ba_1", "prn_2", "viewer"),
      (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === "LAST_OWNER",
    );
  });
});

describe("org.removeMember", () => {
  it("DELETEs the member route", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "DELETE");
      assert.equal(call.url, "https://api.example.test/orgs/v1/ba_1/members/prn_2");
      return jsonResponse({ status: "revoked", principal_id: "prn_2" });
    });
    const res = await makeSdk(fetch).org.members.revoke("ba_1", "prn_2");
    assert.equal(res.status, "revoked");
  });

  it("throws LocalError without a principal id", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(makeSdk(fetch).org.members.revoke("ba_1", ""), (e: unknown) => isLocalError(e));
    assert.equal(calls.length, 0);
  });
});
