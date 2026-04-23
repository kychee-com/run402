/**
 * Unit tests for the `projects` namespace. Each test mocks `fetch` via a
 * custom implementation passed to `new Run402()`. Verifies URL, method,
 * headers, body composition, and response parsing per method.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { ProjectNotFound, PaymentRequired } from "../errors.js";
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
  it("GETs /wallets/v1/:wallet/projects without auth", async () => {
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
});

describe("projects.getUsage", () => {
  it("GETs /projects/v1/admin/:id/usage with service key", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_known",
        tier: "prototype",
        api_calls: 10,
        api_calls_limit: 1000,
        storage_bytes: 1024,
        storage_limit_bytes: 1048576,
        lease_expires_at: "2026-05-01T00:00:00Z",
        status: "active",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.getUsage("prj_known");

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/usage");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.equal(result.tier, "prototype");
    assert.equal(result.api_calls, 10);
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

describe("projects.setupRls", () => {
  it("POSTs the template and tables to /projects/v1/admin/:id/rls", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ status: "ok", template: "user_owns_rows", tables: ["notes"] }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.setupRls("prj_known", {
      template: "user_owns_rows",
      tables: [{ table: "notes", owner_column: "user_id" }],
    });

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/rls");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      template: "user_owns_rows",
      tables: [{ table: "notes", owner_column: "user_id" }],
    });
    assert.equal(result.status, "ok");
  });

  it("refuses the UNRESTRICTED template without the ack flag", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ status: "ok" }));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      sdk.projects.setupRls("prj_known", {
        template: "public_read_write_UNRESTRICTED",
        tables: [{ table: "t" }],
      }),
      (err: unknown) =>
        err instanceof Error &&
        /i_understand_this_is_unrestricted/.test((err as Error).message),
    );
    assert.equal(calls.length, 0);
  });

  it("allows the UNRESTRICTED template when acknowledged", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ status: "ok", template: "public_read_write_UNRESTRICTED", tables: ["t"] }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.projects.setupRls("prj_known", {
      template: "public_read_write_UNRESTRICTED",
      tables: [{ table: "t" }],
      i_understand_this_is_unrestricted: true,
    });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0]!.body as string);
    assert.equal(body.i_understand_this_is_unrestricted, true);
  });
});

describe("projects.pin", () => {
  it("POSTs /projects/v1/admin/:id/pin", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ status: "pinned", project_id: "prj_known" }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.pin("prj_known");

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/pin");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(result.status, "pinned");
  });
});

describe("projects.getQuote", () => {
  it("GETs /tiers/v1 without auth", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        tiers: {
          prototype: { price: "0", lease_days: 7, storage_mb: 100, api_calls: 10000 },
        },
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.getQuote();

    assert.equal(calls[0]!.url, "https://api.example.test/tiers/v1");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.ok(result.tiers.prototype);
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
