/**
 * Unit tests for the `projects` namespace. Each test mocks `fetch` via a
 * custom implementation passed to `new Run402()`. Verifies URL, method,
 * headers, body composition, and response parsing per method.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError, ProjectNotFound, PaymentRequired, Run402Error } from "../errors.js";
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
  it("GETs the membership-scoped /projects/v1 with SIWX by default (cold-start path)", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ projects: [], has_more: false, next_cursor: null }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.list();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1");
    assert.equal(calls[0]!.method, "GET");
    // SIWX wallet auth from the credential provider (mandatory server-side).
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.deepEqual(result, { projects: [], has_more: false, next_cursor: null });
  });

  it("passes ?org_id, ?limit, and ?after for the filtered, paginated read", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ projects: [], has_more: true, next_cursor: "prj_cursor" }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.list({
      org: "11111111-2222-3333-4444-555555555555",
      limit: 25,
      cursor: "prj_prev",
    });

    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/projects/v1");
    assert.equal(url.searchParams.get("org_id"), "11111111-2222-3333-4444-555555555555");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(url.searchParams.get("after"), "prj_prev");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(result.has_more, true);
    assert.equal(result.next_cursor, "prj_cursor");
  });

  it("surfaces the named, domain-aware row shape", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({
        projects: [
          {
            id: "prj_1777563179844_1095",
            name: "kychon-port-olddominionboatclub-com",
            tier: "prototype",
            site_url: "https://port.run402.com",
            custom_domains: ["www.olddominionboatclub.com"],
            status: "active",
            effective_status: "active",
            organization_lifecycle_state: "active",
            lease_perpetual: false,
            organization_id: "11111111-2222-3333-4444-555555555555",
            created_by: "99999999-8888-7777-6666-555555555555",
            created_at: "2026-04-30T15:32:59.891Z",
            deleted_at: null,
            archived_at: null,
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.list();

    assert.equal(result.projects.length, 1);
    const item = result.projects[0]!;
    assert.equal(item.id, "prj_1777563179844_1095");
    assert.equal(item.name, "kychon-port-olddominionboatclub-com");
    assert.equal(item.site_url, "https://port.run402.com");
    assert.deepEqual(item.custom_domains, ["www.olddominionboatclub.com"]);
    assert.equal(item.status, "active");
    assert.equal(item.organization_id, "11111111-2222-3333-4444-555555555555");
    assert.equal(item.created_at, "2026-04-30T15:32:59.891Z");
  });

  it("reads the operator email-union inventory with a token for { all: true }", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        projects: [
          {
            id: "prj_a",
            name: "alpha",
            site_url: null,
            custom_domains: [],
            status: "active",
            organization_id: "11111111-2222-3333-4444-555555555555",
            created_at: "2026-04-30T15:32:59.891Z",
          },
        ],
        scope: "email",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.list({ all: true, token: "op_sess_tok" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/operator/projects");
    assert.equal(calls[0]!.method, "GET");
    // Operator-session bearer overrides SIWX; provider auth is not injected.
    assert.equal(calls[0]!.headers["Authorization"], "Bearer op_sess_tok");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.equal(result.scope, "email");
    assert.equal(result.projects[0]!.name, "alpha");
  });

  it("{ all: true } without a token falls back to SIWX wallet auth (single-wallet slice)", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ projects: [], scope: "wallet" }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.list({ all: true });

    assert.equal(calls[0]!.url, "https://api.example.test/agent/v1/operator/projects");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    assert.equal(result.scope, "wallet");
  });

  it("rejects { all, org } together before requesting (mutually exclusive)", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for mutually-exclusive all+org");
    });
    const sdk = makeSdk(makeCreds(), fetch);

    await assert.rejects(
      sdk.projects.list({ all: true, org: "11111111-2222-3333-4444-555555555555" }),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "listing projects" &&
        /mutually exclusive/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });

  it("propagates Unauthorized from the gateway (e.g. no allowance configured)", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ message: "auth required" }, 401));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      sdk.projects.list(),
      (err: unknown) => err instanceof Run402Error && err.context === "listing projects",
    );
  });
});

describe("projects.rename", () => {
  it("PATCHes /projects/v1/:id with the new name and SIWX auth", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ project_id: "prj_known", name: "My Site" }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.rename("prj_known", "My Site");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/prj_known");
    assert.equal(calls[0]!.method, "PATCH");
    // Authorize-before-reveal endpoint — caller auth (not a service key).
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { name: "My Site" });
    assert.deepEqual(result, { project_id: "prj_known", name: "My Site" });
  });

  it("propagates Unauthorized (authorize-before-reveal 403) without a keystore lookup", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ message: "not authorized" }, 403));
    // Note: prj_missing is NOT in the keystore — rename must still hit the wire
    // (caller-authed), unlike delete which short-circuits on a missing key.
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      sdk.projects.rename("prj_missing", "x"),
      (err: unknown) => err instanceof Run402Error && err.context === "renaming project",
    );
    assert.equal(calls.length, 1);
  });

  it("propagates a 400 on an invalid name", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ error: { code: "VALIDATION_ERROR", message: "name too long" } }, 400),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      sdk.projects.rename("prj_known", "x".repeat(500)),
      (err: unknown) => err instanceof Run402Error && err.context === "renaming project",
    );
  });
});

describe("projects.getUsage", () => {
  it("GETs /projects/v1/admin/:id/usage with service key", async () => {
    // Mirrors the live gateway shape — `lease_expires_at` is intentionally
    // absent because the endpoint doesn't compute it (see GH-163). v1.57:
    // effective_status / organization_lifecycle_state replace the legacy `status`.
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        project_id: "prj_known",
        tier: "prototype",
        api_calls: 10,
        api_calls_limit: 1000,
        storage_bytes: 1024,
        storage_limit_bytes: 1048576,
        effective_status: "active",
        organization_lifecycle_state: "active",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.getUsage("prj_known");

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/admin/prj_known/usage");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.equal(result.tier, "prototype");
    assert.equal(result.api_calls, 10);
    assert.equal(result.effective_status, "active");
    assert.equal(result.organization_lifecycle_state, "active");
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
    assert.equal(calls[0]!.headers["Authorization"], "Bearer anon_xxx");
    assert.deepEqual(result, [{ id: 1 }]);
  });

  it("does not double-prefix REST query strings that already include ?", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse([{ id: 1 }]));
    const sdk = makeSdk(makeCreds(), fetch);

    await sdk.projects.restResponse("prj_known", "todos", "?select=*");

    assert.equal(calls[0]!.url, "https://api.example.test/rest/v1/todos?select=*");
  });

  it("can return project REST status metadata for CLI/MCP shims", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ok: true }, 201));
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.projects.restResponse("prj_known", "todos", {
      method: "POST",
      body: { name: "ship it" },
      keyType: "service",
    });

    // service key routes through the admin REST path (the gateway rejects
    // service_role on /rest/v1/*); anon keys keep the public /rest/v1/ path.
    assert.equal(calls[0]!.url, "https://api.example.test/admin/v1/rest/todos");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["apikey"], "service_xxx");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.equal(calls[0]!.headers["Prefer"], "return=representation");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { name: "ship it" });
    assert.deepEqual(result, { status: 201, body: { ok: true } });
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

  it("validates expose manifests without project context using wallet auth", async () => {
    const validation = {
      hasErrors: true,
      errors: [
        {
          type: "missing-table",
          severity: "error",
          detail: "Table todos does not exist.",
          fix: "Create the table or remove it from the manifest.",
        },
      ],
      warnings: [],
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(validation));
    const sdk = makeSdk(makeCreds(), fetch);
    const manifest = { version: "1", tables: [{ table: "todos" }] };

    const result = await sdk.projects.validateExpose(manifest, {
      migrationSql: "create table todos (id bigint primary key);",
    });

    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/expose/validate");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      manifest,
      migration_sql: "create table todos (id bigint primary key);",
    });
    assert.deepEqual(result, validation);
  });

  it("validates expose manifests against a project with service-key auth", async () => {
    const validation = { hasErrors: false, errors: [], warnings: [] };
    const { fetch, calls } = mockFetch(() => jsonResponse(validation));
    const sdk = makeSdk(makeCreds(), fetch);

    const result = await sdk.projects.validateExpose('{"version":"1","tables":[]}', {
      project: "prj_known",
    });

    assert.equal(
      calls[0]!.url,
      "https://api.example.test/projects/v1/admin/prj_known/expose/validate",
    );
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      manifest: { version: "1", tables: [] },
    });
    assert.deepEqual(result, validation);
  });

  it("returns a validation result for invalid JSON string manifests", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);

    const result = await sdk.projects.validateExpose("{ bad json");

    assert.equal(calls.length, 0);
    assert.equal(result.hasErrors, true);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.errors[0]!.type, "schema-shape");
    assert.match(result.errors[0]!.detail, /invalid/i);
  });

  it("uses structured error paths for project validation operational failures", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);

    await assert.rejects(
      sdk.projects.validateExpose({ version: "1" }, { project_id: "prj_missing" }),
      ProjectNotFound,
    );
    assert.equal(calls.length, 0);
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
