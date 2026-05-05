/**
 * Unit tests for the `projects` namespace. Each test mocks `fetch` via a
 * custom implementation passed to `new Run402()`. Verifies URL, method,
 * headers, body composition, and response parsing per method.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { ProjectNotFound, PaymentRequired, Run402Error } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
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
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function makeCreds(
  overrides: Partial<CredentialsProvider> = {},
): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject(id: string) {
      if (id === "prj_known") {
        return { anon_key: "anon_xxx", service_key: "service_xxx" };
      }
      return null;
    },
    ...overrides,
  };
}

function makeSdk(
  creds: CredentialsProvider,
  fetchImpl: typeof globalThis.fetch,
): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: creds,
    fetch: fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("projects.provision", () => {
  it("POSTs /projects/v1 with the requested tier and name", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_new",
        anon_key: "anon_new",
        service_key: "service_new",
        schema_slot: "s_0042",
      }),
    );
    const creds = makeCreds();
    const sdk = makeSdk(creds, fetch);
    const result = await sdk.projects.provision({ tier: "hobby", name: "my-app" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { tier: "hobby", name: "my-app" });
    assert.deepEqual(result, {
      project_id: "prj_new",
      anon_key: "anon_new",
      service_key: "service_new",
      schema_slot: "s_0042",
    });
  });

  it("persists keys via the credential provider after success", async () => {
    const saved: Array<{ id: string; project: unknown }> = [];
    const activeSet: string[] = [];
    const creds = makeCreds({
      async saveProject(id, project) {
        saved.push({ id, project });
      },
      async setActiveProject(id) {
        activeSet.push(id);
      },
    });
    const { fetch } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_new",
        anon_key: "anon_new",
        service_key: "service_new",
        schema_slot: "s_1",
      }),
    );
    const sdk = makeSdk(creds, fetch);
    await sdk.projects.provision({ tier: "prototype" });

    assert.deepEqual(saved, [
      { id: "prj_new", project: { anon_key: "anon_new", service_key: "service_new" } },
    ]);
    assert.deepEqual(activeSet, ["prj_new"]);
  });

  it("throws PaymentRequired on 402 and does not persist", async () => {
    const saved: unknown[] = [];
    const creds = makeCreds({
      async saveProject(id, project) {
        saved.push({ id, project });
      },
    });
    const { fetch } = mockFetch(() =>
      jsonResponse({ message: "pay up", x402: { price: "$0.30" } }, 402),
    );
    const sdk = makeSdk(creds, fetch);
    await assert.rejects(sdk.projects.provision({ tier: "hobby" }), PaymentRequired);
    assert.deepEqual(saved, []);
  });

  it("omits undefined fields from the request body", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_new",
        anon_key: "a",
        service_key: "s",
        schema_slot: "x",
      }),
    );
    const creds = makeCreds();
    const sdk = makeSdk(creds, fetch);
    await sdk.projects.provision({});
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {});
  });
});

describe("projects.delete", () => {
  it("throws ProjectNotFound before any API call for unknown ids", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}, 200));
    const creds = makeCreds();
    const sdk = makeSdk(creds, fetch);
    await assert.rejects(sdk.projects.delete("prj_missing"), ProjectNotFound);
    assert.equal(calls.length, 0);
  });

  it("DELETEs /projects/v1/:id with service key bearer auth and removes locally", async () => {
    const removed: string[] = [];
    const creds = makeCreds({
      async removeProject(id) {
        removed.push(id);
      },
    });
    const { fetch, calls } = mockFetch(() => jsonResponse({ status: "purged" }));
    const sdk = makeSdk(creds, fetch);
    await sdk.projects.delete("prj_known");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/prj_known");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.deepEqual(removed, ["prj_known"]);
  });
});

describe("projects.list", () => {
  it("GETs /wallets/v1/:wallet/projects without auth when wallet is explicit", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        wallet: "0xabc",
        projects: [],
      }),
    );
    const creds = makeCreds();
    const sdk = makeSdk(creds, fetch);
    const result = await sdk.projects.list("0xABC");

    assert.equal(calls[0]!.url, "https://api.example.test/wallets/v1/0xabc/projects");
    assert.equal(calls[0]!.method, "GET");
    // Public endpoint — no SIWX header injected.
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.deepEqual(result, { wallet: "0xabc", projects: [] });
  });

  it("falls back to readAllowance().address when wallet is omitted", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ wallet: "0xfeed", projects: [] }),
    );
    const creds = makeCreds({
      async readAllowance() {
        return { address: "0xFeeD", privateKey: "0xpriv" };
      },
    });
    const sdk = makeSdk(creds, fetch);
    const result = await sdk.projects.list();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/wallets/v1/0xfeed/projects");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.deepEqual(result, { wallet: "0xfeed", projects: [] });
  });

  it("throws Run402Error when wallet omitted and provider lacks readAllowance", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const creds = makeCreds(); // no readAllowance
    const sdk = makeSdk(creds, fetch);

    await assert.rejects(
      sdk.projects.list(),
      (err: unknown) =>
        err instanceof Run402Error &&
        err.context === "listing projects" &&
        /pass an explicit wallet/i.test(err.message) &&
        /@run402\/sdk\/node/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("throws Run402Error when readAllowance returns null", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const creds = makeCreds({
      async readAllowance() {
        return null;
      },
    });
    const sdk = makeSdk(creds, fetch);

    await assert.rejects(
      sdk.projects.list(),
      (err: unknown) =>
        err instanceof Run402Error &&
        err.context === "listing projects" &&
        /run402 allowance create/.test(err.message) &&
        /pass an explicit wallet/i.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("uses the explicit wallet when provided, even if local allowance differs", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ wallet: "0xother", projects: [] }),
    );
    let readAllowanceCalls = 0;
    const creds = makeCreds({
      async readAllowance() {
        readAllowanceCalls++;
        return { address: "0xLocal", privateKey: "0xpriv" };
      },
    });
    const sdk = makeSdk(creds, fetch);
    const result = await sdk.projects.list("0xOther");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/wallets/v1/0xother/projects");
    assert.equal(readAllowanceCalls, 0);
    assert.deepEqual(result, { wallet: "0xother", projects: [] });
  });

  it("accepts items where lease_expires_at is missing (gateway omits it; type is optional)", async () => {
    // Mirrors the live gateway shape — list items don't include lease_expires_at.
    const { fetch } = mockFetch(() =>
      jsonResponse({
        wallet: "0xabc",
        projects: [
          {
            id: "prj_1777563179844_1095",
            name: "kychon-port-olddominionboatclub-com",
            tier: "prototype",
            status: "active",
            api_calls: 212,
            storage_bytes: 12376062,
            created_at: "2026-04-30T15:32:59.891Z",
          },
        ],
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.list("0xabc");

    assert.equal(result.projects.length, 1);
    const item = result.projects[0]!;
    assert.equal(item.id, "prj_1777563179844_1095");
    assert.equal(item.tier, "prototype");
    assert.equal(item.lease_expires_at, undefined,
      "gateway omits lease_expires_at on list items; type is optional");
  });
});

describe("projects.getUsage", () => {
  it("GETs /projects/v1/admin/:id/usage with service key", async () => {
    // Mirrors the live gateway shape — `lease_expires_at` is intentionally
    // absent because the endpoint doesn't compute it (see GH-163).
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_known",
        tier: "prototype",
        api_calls: 10,
        api_calls_limit: 1000,
        storage_bytes: 1024,
        storage_limit_bytes: 1048576,
        status: "active",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.getUsage("prj_known");

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/usage");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.equal(result.tier, "prototype");
    assert.equal(result.api_calls, 10);
    assert.equal(result.lease_expires_at, undefined,
      "gateway omits lease_expires_at; type is optional so callers don't read a non-existent string");
  });

  it("throws ProjectNotFound for unknown ids before hitting the network", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}, 200));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(sdk.projects.getUsage("prj_missing"), ProjectNotFound);
    assert.equal(calls.length, 0);
  });
});

describe("projects.getSchema", () => {
  it("GETs /projects/v1/admin/:id/schema and returns tables", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        schema: "tenant_42",
        tables: [
          {
            name: "users",
            columns: [
              { name: "id", type: "uuid", nullable: false, default_value: null },
            ],
            constraints: [],
            rls_enabled: false,
            policies: [],
          },
        ],
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.getSchema("prj_known");

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/schema");
    assert.equal(result.schema, "tenant_42");
    assert.equal(result.tables.length, 1);
    assert.equal(result.tables[0]!.name, "users");
  });
});

describe("projects.pin", () => {
  it("POSTs /projects/v1/admin/:id/pin with admin-wallet auth, not service key auth", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ status: "pinned", project_id: "prj_external" }),
    );
    const sdk = makeSdk(makeCreds({
      async getProject() {
        return null;
      },
    }), fetch);
    const result = await sdk.projects.pin("prj_external");

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_external/pin");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(calls[0]!.headers.Authorization, undefined);
    assert.equal(calls[0]!.headers["X-Admin-Mode"], "1");
    assert.equal(result.status, "pinned");
  });
});

describe("projects.getQuote", () => {
  it("GETs /tiers/v1 without auth", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        tiers: {
          prototype: { price: "0", lease_days: 7, storage_mb: 100, api_calls: 10000, max_functions: 15, description: "test" },
        },
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.getQuote();

    assert.equal(calls[0]!.url, "https://api.example.test/tiers/v1");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.ok(result.tiers.prototype);
  });

  it("exposes auth field on result and max_functions/description on tier items", async () => {
    // Mirrors the live gateway shape — quote includes per-tier max_functions
    // and description, plus a top-level auth block of opaque shape.
    const { fetch } = mockFetch(() =>
      jsonResponse({
        tiers: {
          prototype: {
            price: "$0.10",
            lease_days: 7,
            storage_mb: 250,
            api_calls: 500000,
            max_functions: 15,
            description: "Prototype tier (FREE) — 7-day lease, 250MB storage, 500k API calls.",
          },
        },
        auth: { challenge: "test-challenge", expires_at: "2026-05-01T00:00:00Z" },
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.getQuote();

    assert.equal(result.tiers.prototype!.max_functions, 15);
    assert.equal(
      result.tiers.prototype!.description,
      "Prototype tier (FREE) — 7-day lease, 250MB storage, 500k API calls.",
    );
    assert.ok(result.auth, "auth field is exposed on the result");
    assert.equal((result.auth as Record<string, unknown>).challenge, "test-challenge");
  });
});

describe("projects admin helpers (SDK/CLI parity)", () => {
  it("runs SQL via the same admin endpoint as the CLI (GH-181)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ rows: [{ ok: true }], rowCount: 1 }));
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.sql("prj_known", "SELECT $1::int AS n", [42]);

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/sql");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.equal(calls[0]!.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      sql: "SELECT $1::int AS n",
      params: [42],
    });
    assert.deepEqual(result, { rows: [{ ok: true }], rowCount: 1 });
  });

  it("runs raw SQL as text/plain when no params are provided (GH-181)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ rows: [], rowCount: 0 }));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.projects.sql("prj_known", "SELECT 1");

    assert.equal(calls[0]!.headers["Content-Type"], "text/plain");
    assert.equal(calls[0]!.body, "SELECT 1");
  });

  it("queries project REST tables with the anon key (GH-181)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse([{ id: 1 }]));
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.rest("prj_known", "todos", "select=id&limit=1");

    assert.equal(calls[0]!.url, "https://api.example.test/rest/v1/todos?select=id&limit=1");
    assert.equal(calls[0]!.headers["apikey"], "anon_xxx");
    assert.deepEqual(result, [{ id: 1 }]);
  });

  it("applies and fetches expose manifests (GH-181)", async () => {
    const seen: FetchCall[] = [];
    const { fetch } = mockFetch((call) => {
      seen.push(call);
      if (call.method === "POST") return jsonResponse({ status: "ok" });
      return jsonResponse({ version: "1", tables: [] });
    });
    const sdk = makeSdk(makeCreds(), fetch);
    const manifest = { version: "1", tables: [] };

    assert.deepEqual(await sdk.projects.applyExpose("prj_known", manifest), { status: "ok" });
    assert.deepEqual(await sdk.projects.getExpose("prj_known"), manifest);

    assert.equal(seen[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/expose");
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.deepEqual(JSON.parse(seen[0]!.body as string), manifest);
    assert.equal(seen[1]!.url, "https://api.example.test/projects/v1/admin/prj_known/expose");
    assert.equal(seen[1]!.method, "GET");
  });

  it("exposes project-admin role helpers under the projects namespace (GH-181)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ status: "ok" }));
    const sdk = makeSdk(makeCreds(), fetch);

    await sdk.projects.promoteUser("prj_known", "admin@example.com");
    await sdk.projects.demoteUser("prj_known", "admin@example.com");

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/promote-user");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { email: "admin@example.com" });
    assert.equal(calls[1]!.url, "https://api.example.test/projects/v1/admin/prj_known/demote-user");
  });
});

describe("projects.info / .keys / .use / .active (local)", () => {
  it("info returns stored keys + id without any fetch", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    const info = await sdk.projects.info("prj_known");
    assert.equal(info.project_id, "prj_known");
    assert.equal(info.anon_key, "anon_xxx");
    assert.equal(calls.length, 0);
  });

  it("info throws ProjectNotFound for unknown ids", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(sdk.projects.info("prj_missing"), ProjectNotFound);
  });

  it("keys returns just the stored keys", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    const keys = await sdk.projects.keys("prj_known");
    assert.deepEqual(keys, { anon_key: "anon_xxx", service_key: "service_xxx" });
  });

  it("use calls setActiveProject on the provider", async () => {
    const active: string[] = [];
    const creds = makeCreds({
      async setActiveProject(id) {
        active.push(id);
      },
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(creds, fetch);
    await sdk.projects.use("prj_known");
    assert.deepEqual(active, ["prj_known"]);
  });

  it("use throws when provider does not support setActiveProject", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      sdk.projects.use("prj_known"),
      (err: unknown) => err instanceof Error && /does not support setActiveProject/.test((err as Error).message),
    );
  });

  it("active returns null when provider does not track active project", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    assert.equal(await sdk.projects.active(), null);
  });

  it("active returns the id when the provider supports it", async () => {
    const creds = makeCreds({
      async getActiveProject() {
        return "prj_known";
      },
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(creds, fetch);
    assert.equal(await sdk.projects.active(), "prj_known");
  });
});
