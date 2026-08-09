import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError, ProjectCredentialNotFound } from "../errors.js";
import type { CredentialsProvider, ProjectKeys } from "../credentials.js";

const known: ProjectKeys = {
  anon_key: "anon_secret_value",
  service_key: "service_secret_value",
  site_url: "https://example.run402.com",
  cached_at: "2026-07-03T00:00:00Z",
};

function sdk(overrides: Partial<CredentialsProvider> = {}) {
  const entries: Record<string, ProjectKeys> = { prj_known: { ...known } };
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: {
      async getAuth() {
        return null;
      },
      async getProjectCredentials(id) {
        return entries[id] ?? null;
      },
      async listProjectCredentials() {
        return entries;
      },
      async saveProject(id, project) {
        entries[id] = project;
      },
      async removeProject(id) {
        delete entries[id];
      },
      getProjectCredentialCacheInfo() {
        return { source: "local_cache", cache_path: "/tmp/project-keys.v1.json", profile: "default" };
      },
      ...overrides,
    },
    fetch: async () => {
      throw new Error("unexpected fetch");
    },
  });
}

describe("credentials.projectKeys", () => {
  it("status redacts local project-key material", async () => {
    const result = await sdk().credentials.projectKeys.status("prj_known");

    assert.equal(result.source, "local_cache");
    assert.equal(result.configured, true);
    assert.equal(result.has_service_key, true);
    assert.equal(result.service_key_prefix, "service_...");
    assert.equal(result.site_url, "https://example.run402.com");
    assert.equal(JSON.stringify(result).includes("service_secret_value"), false);
  });

  it("list returns redacted local-cache entries with provenance", async () => {
    const result = await sdk().credentials.projectKeys.list();

    assert.equal(result.source, "local_cache");
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0]!.project_id, "prj_known");
    assert.equal(result.projects[0]!.cache_path, "/tmp/project-keys.v1.json");
    assert.equal(JSON.stringify(result).includes("anon_secret_value"), false);
  });

  it("export requires reveal before emitting secret material", async () => {
    await assert.rejects(
      () => sdk().credentials.projectKeys.export("prj_known"),
      (err: unknown) => err instanceof LocalError && err.code === "REVEAL_REQUIRED",
    );

    const result = await sdk().credentials.projectKeys.export("prj_known", { reveal: true });
    assert.equal(result.revealed, true);
    assert.equal(result.service_key, "service_secret_value");
    assert.equal(result.source, "local_cache");
  });

  it("export preserves ProjectCredentialNotFound for missing local keys", async () => {
    await assert.rejects(
      () => sdk().credentials.projectKeys.export("prj_missing", { reveal: true }),
      ProjectCredentialNotFound,
    );
  });

  it("import and remove delegate to provider persistence hooks", async () => {
    const client = sdk();

    const imported = await client.credentials.projectKeys.import("prj_new", {
      anonKey: "anon_new",
      serviceKey: "service_new",
    });
    assert.equal(imported.imported, true);
    assert.equal(imported.configured, true);

    const removed = await client.credentials.projectKeys.remove("prj_new");
    assert.equal(removed.removed, true);
    assert.equal(removed.configured, false);
  });
});

// ---------------------------------------------------------------------------
// The gateway's project credentials — the remote half of this namespace.
//
// These routes shipped on the gateway and in openapi.json with NO client at
// all, so the documented way off the legacy derived keys required hand-rolling
// a SIWX-signed request. That is the hidden manual step the platform exists to
// remove, and it is what these tests pin.
// ---------------------------------------------------------------------------

type Recorded = { url: string; method: string; body: unknown };

function remoteSdk(respond: (req: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const r = new Run402({
    apiBase: "https://api.example.test",
    credentials: {
      async getAuth() {
        return { headers: { "SIGN-IN-WITH-X": "c2l3eA==" } };
      },
      async getProjectCredentials() {
        return null;
      },
    } as unknown as CredentialsProvider,
    fetch: (async (url: string | URL, init?: { method?: string; body?: string }) => {
      const call: Recorded = {
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return new Response(JSON.stringify(respond(call)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch,
  });
  return { r, calls };
}

const RECORD = {
  credential_id: "pcr_1",
  project_id: "prj_1",
  kind: "service",
  name: "ci-deploy",
  created_at: "2026-08-09T00:00:00Z",
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  revoked_reason: null,
  replacement_of: null,
};

describe("credentials — gateway project credentials", () => {
  it("issue() POSTs the documented shape and returns the one-time secret", async () => {
    const { r, calls } = remoteSdk(() => ({ ...RECORD, secret: "r402_live_abc" }));
    const out = await r.credentials.issue("prj_1", { kind: "service", name: "ci-deploy" });

    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/projects\/v1\/prj_1\/credentials$/);
    assert.deepEqual(calls[0].body, { kind: "service", name: "ci-deploy" });
    assert.equal(out.secret, "r402_live_abc");
  });

  it("issue() sends expires_at in the wire's snake_case", async () => {
    const { r, calls } = remoteSdk(() => ({ ...RECORD, secret: "s" }));
    await r.credentials.issue("prj_1", { kind: "anon", name: "web", expiresAt: "2027-01-01T00:00:00Z" });

    assert.deepEqual(calls[0].body, { kind: "anon", name: "web", expires_at: "2027-01-01T00:00:00Z" });
  });

  it("issue() rejects a bad kind locally, without spending a round-trip", async () => {
    const { r, calls } = remoteSdk(() => ({}));
    await assert.rejects(
      () => r.credentials.issue("prj_1", { kind: "admin" as never, name: "x" }),
      (e: unknown) => e instanceof LocalError,
    );
    assert.equal(calls.length, 0, "a local validation failure must not hit the network");
  });

  it("issue() requires a name — it is the handle you rotate by later", async () => {
    const { r } = remoteSdk(() => ({}));
    await assert.rejects(
      () => r.credentials.issue("prj_1", { kind: "service", name: "   " }),
      (e: unknown) => e instanceof LocalError,
    );
  });

  it("list() is metadata-only and passes include_revoked through", async () => {
    const { r, calls } = remoteSdk(() => ({ credentials: [RECORD] }));
    const out = await r.credentials.list("prj_1", { includeRevoked: true });

    assert.match(calls[0].url, /\?include_revoked=true$/);
    assert.equal(out.credentials[0].credential_id, "pcr_1");
    assert.equal("secret" in out.credentials[0], false, "a read must never carry a secret");
  });

  it("list() omits the query string when include_revoked is not asked for", async () => {
    const { r, calls } = remoteSdk(() => ({ credentials: [] }));
    await r.credentials.list("prj_1");
    assert.match(calls[0].url, /\/credentials$/);
  });

  it("status() answers 'am I on the retiring key' and never invents a deadline", async () => {
    const { r, calls } = remoteSdk(() => ({
      project_id: "prj_1",
      state: "legacy",
      legacy_key: "k0",
      rotatable_credentials: 0,
      credentials: [],
      retirement: { gated_on: ["all known tenants migrated"], deadline: null },
    }));
    const out = await r.credentials.status("prj_1");

    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/projects\/v1\/prj_1\/credential-status$/);
    assert.equal(out.state, "legacy");
    assert.equal(out.retirement.deadline, null, "retirement is condition-gated, never a date");
  });

  it("rotate() hits the rotate sub-path and returns a fresh secret", async () => {
    const { r, calls } = remoteSdk(() => ({ ...RECORD, credential_id: "pcr_2", replacement_of: "pcr_1", secret: "r402_new" }));
    const out = await r.credentials.rotate("prj_1", "pcr_1");

    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/credentials\/pcr_1\/rotate$/);
    assert.equal(out.replacement_of, "pcr_1");
    assert.equal(out.secret, "r402_new");
  });

  it("revoke() DELETEs, and only sends a body when a reason is given", async () => {
    const { r, calls } = remoteSdk(() => ({ ...RECORD, revoked_at: "2026-08-09T01:00:00Z", revoked: true }));
    await r.credentials.revoke("prj_1", "pcr_1");
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].body, undefined);

    await r.credentials.revoke("prj_1", "pcr_1", { reason: "leaked in a log" });
    assert.deepEqual(calls[1].body, { reason: "leaked in a log" });
  });

  it("mintToken() defaults to service — the kind an agent needs to deploy", async () => {
    const { r, calls } = remoteSdk(() => ({ ...RECORD, secret: "r402_tmp", expires_in: 900 }));
    const out = await r.credentials.mintToken("prj_1");

    assert.match(calls[0].url, /\/projects\/v1\/prj_1\/tokens$/);
    assert.deepEqual(calls[0].body, { kind: "service" });
    assert.equal(out.expires_in, 900);
  });

  it("every remote method rejects an empty projectId before the network", async () => {
    const { r, calls } = remoteSdk(() => ({}));
    const attempts = [
      () => r.credentials.issue("", { kind: "service", name: "n" }),
      () => r.credentials.list(""),
      () => r.credentials.status(""),
      () => r.credentials.rotate("", "pcr_1"),
      () => r.credentials.revoke("", "pcr_1"),
      () => r.credentials.mintToken(""),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt, (e: unknown) => e instanceof LocalError);
    }
    assert.equal(calls.length, 0);
  });

  it("the local cache and the gateway rows stay distinguishable on one namespace", async () => {
    const { r } = remoteSdk(() => ({ credentials: [] }));
    assert.equal(typeof r.credentials.list, "function", "remote");
    assert.equal(typeof r.credentials.projectKeys.list, "function", "local cache");
  });
});
