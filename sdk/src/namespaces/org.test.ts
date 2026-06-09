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

function parseBody(body: unknown): Record<string, unknown> {
  return typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {};
}

// ─── r.orgs (collection + identity) ─────────────────────────────────────────

describe("r.orgs.whoami", () => {
  it("GETs /agent/v1/whoami; memberships carry org_id + display_name (not billing_account_id)", async () => {
    const payload = {
      principal: { id: "prn_1", type: "human", displayName: "Tal", createdAt: "2026-01-01T00:00:00Z" },
      memberships: [{ org_id: "org_1", display_name: "Kychee", role: "owner", status: "active" }],
      authenticator_id: "auth_1",
    };
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, "https://api.example.test/agent/v1/whoami");
      return jsonResponse(payload);
    });
    const r = await makeSdk(fetch).orgs.whoami();
    assert.equal(r.memberships[0]!.org_id, "org_1");
    assert.equal(r.memberships[0]!.display_name, "Kychee");
    assert.equal(r.principal.displayName, "Tal");
    assert.equal(calls.length, 1);
  });
});

describe("r.orgs.list", () => {
  it("GETs /orgs/v1 and unwraps { orgs } with org_id + display_name", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, "https://api.example.test/orgs/v1");
      return jsonResponse({ orgs: [{ org_id: "org_1", display_name: null, role: "developer", status: "active" }] });
    });
    const orgs = await makeSdk(fetch).orgs.list();
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0]!.org_id, "org_1");
    assert.equal(orgs[0]!.display_name, null);
    assert.equal(calls.length, 1);
  });
});

describe("r.orgs.create", () => {
  it("POSTs /orgs/v1 with display_name only (never a tier) and returns the summary", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/orgs/v1");
      const body = parseBody(call.body);
      assert.equal(body.display_name, "Kychee");
      assert.ok(!("tier" in body), "create must never send a tier");
      return jsonResponse({ org_id: "org_new", display_name: "Kychee", tier: "prototype" }, 201);
    });
    const org = await makeSdk(fetch).orgs.create({ displayName: "Kychee" });
    assert.equal(org.org_id, "org_new");
    assert.equal(org.tier, "prototype");
    assert.equal(calls.length, 1);
  });

  it("sends an empty body when no displayName is given", async () => {
    const { fetch } = mockFetch((call) => {
      assert.deepEqual(parseBody(call.body), {});
      return jsonResponse({ org_id: "org_new", display_name: null, tier: "prototype" }, 201);
    });
    const org = await makeSdk(fetch).orgs.create();
    assert.equal(org.display_name, null);
  });

  it("surfaces FREE_ORG_OWNER_LIMIT_EXCEEDED as an ApiError preserving the code", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ error: "too many free orgs", code: "FREE_ORG_OWNER_LIMIT_EXCEEDED" }, 429),
    );
    await assert.rejects(
      () => makeSdk(fetch).orgs.create({ displayName: "x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "FREE_ORG_OWNER_LIMIT_EXCEEDED");
        return true;
      },
    );
  });
});

// ─── r.org(id) (scoped instance) ────────────────────────────────────────────

describe("r.org(id).get", () => {
  it("GETs /orgs/v1/:org_id and returns the caller role", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, "https://api.example.test/orgs/v1/org_abc");
      return jsonResponse({ org_id: "org_abc", display_name: "Kychee", tier: "prototype", role: "owner" });
    });
    const org = await makeSdk(fetch).org("org_abc").get();
    assert.equal(org.role, "owner");
    assert.equal(org.org_id, "org_abc");
    assert.equal(calls.length, 1);
  });
});

describe("r.org(id).rename", () => {
  it("PATCHes /orgs/v1/:org_id with the new display_name", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "PATCH");
      assert.equal(call.url, "https://api.example.test/orgs/v1/org_abc");
      assert.equal(parseBody(call.body).display_name, "New");
      return jsonResponse({ org_id: "org_abc", display_name: "New", tier: "prototype" });
    });
    const org = await makeSdk(fetch).org("org_abc").rename("New");
    assert.equal(org.display_name, "New");
    assert.equal(calls.length, 1);
  });

  it("sends display_name: null to clear the label", async () => {
    const { fetch } = mockFetch((call) => {
      const body = parseBody(call.body);
      assert.ok("display_name" in body);
      assert.equal(body.display_name, null);
      return jsonResponse({ org_id: "org_abc", display_name: null, tier: "prototype" });
    });
    const org = await makeSdk(fetch).org("org_abc").rename(null);
    assert.equal(org.display_name, null);
  });
});

describe("r.org(id) — id binding", () => {
  it("throws a LocalError when constructed without an org id", () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    assert.throws(() => makeSdk(fetch).org(""), (err: unknown) => isLocalError(err));
  });

  it("binds the id into member/invite/audit paths without a repeated argument", async () => {
    const seen: string[] = [];
    const { fetch } = mockFetch((call) => {
      seen.push(`${call.method} ${call.url}`);
      if (call.url.endsWith("/members")) return jsonResponse({ members: [] });
      if (call.url.endsWith("/invites")) return jsonResponse({ invites: [] });
      return jsonResponse({ events: [] });
    });
    const p = makeSdk(fetch).org("org_xyz");
    await p.members.list();
    await p.invites.list();
    await p.audit({ limit: 10 });
    assert.deepEqual(seen, [
      "GET https://api.example.test/orgs/v1/org_xyz/members",
      "GET https://api.example.test/orgs/v1/org_xyz/invites",
      "GET https://api.example.test/orgs/v1/org_xyz/audit?limit=10",
    ]);
  });
});

describe("r.org(id).members", () => {
  it("adds a member by wallet on the bound org", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, "https://api.example.test/orgs/v1/org_abc/members");
      assert.deepEqual(parseBody(call.body), { wallet: "0xabc", role: "admin" });
      return jsonResponse({ status: "ok", principal_id: "prn_2", role: "admin" }, 201);
    });
    const res = await makeSdk(fetch).org("org_abc").members.add({ wallet: "0xabc", role: "admin" });
    assert.equal(res.principal_id, "prn_2");
    assert.equal(calls.length, 1);
  });

  it("surfaces LAST_OWNER on a forbidden revoke", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ error: "cannot remove last owner", code: "LAST_OWNER" }, 409));
    await assert.rejects(
      () => makeSdk(fetch).org("org_abc").members.revoke("prn_owner"),
      (err: unknown) => err instanceof ApiError && (err as ApiError).code === "LAST_OWNER",
    );
  });
});

// ─── Drift guard (task 5.2): r.org(id) must expose the instance surface ──────

describe("r.org(id) surface drift guard", () => {
  it("exposes exactly the expected instance methods + sub-clients", () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const scoped = makeSdk(fetch).org("org_drift");
    // Direct instance methods.
    for (const m of ["get", "rename", "audit"]) {
      assert.equal(typeof (scoped as unknown as Record<string, unknown>)[m], "function", `r.org(id).${m} must exist`);
    }
    // Sub-clients with their full method sets — adding an org-instance method
    // without wiring it here (and onto the scoped sub-client) fails this test.
    for (const m of ["list", "add", "setRole", "revoke"]) {
      assert.equal(typeof (scoped.members as unknown as Record<string, unknown>)[m], "function", `members.${m} must exist`);
    }
    for (const m of ["list", "create", "revoke"]) {
      assert.equal(typeof (scoped.invites as unknown as Record<string, unknown>)[m], "function", `invites.${m} must exist`);
    }
    assert.equal(scoped.orgId, "org_drift");
  });
});
