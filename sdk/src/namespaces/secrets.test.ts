import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "../index.js";
import { ProjectNotFound } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

function creds(): CredentialsProvider {
  return {
    async getAuth() { return { "SIGN-IN-WITH-X": "t" }; },
    async getProject(id) { return id === "prj_k" ? { anon_key: "a", service_key: "s" } : null; },
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
function mockFetch(h: (c: Call) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return h(call);
  };
  return { fetch, calls };
}

function sdk(f: typeof globalThis.fetch): Run402 {
  return new Run402({ apiBase: "https://api.test", credentials: creds(), fetch: f });
}

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
}

describe("secrets", () => {
  it("set POSTs key/value with service bearer", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await sdk(fetch).secrets.set("prj_k", "STRIPE_KEY", "sk_xxx");
    assert.equal(calls[0]!.url, "https://api.test/projects/v1/admin/prj_k/secrets");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer s");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { key: "STRIPE_KEY", value: "sk_xxx" });
  });

  it("list GETs secrets endpoint", async () => {
    const { fetch, calls } = mockFetch(() => json({ secrets: [{ key: "K", value_hash: "a1b2c3d4" }] }));
    const res = await sdk(fetch).secrets.list("prj_k");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(res.secrets.length, 1);
  });

  it("delete DELETEs the secret path with URL-encoded key", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await sdk(fetch).secrets.delete("prj_k", "my key");
    assert.equal(calls[0]!.url, "https://api.test/projects/v1/admin/prj_k/secrets/my%20key");
    assert.equal(calls[0]!.method, "DELETE");
  });

  it("throws ProjectNotFound without any fetch for unknown project", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await assert.rejects(sdk(fetch).secrets.set("prj_missing", "K", "V"), ProjectNotFound);
    assert.equal(calls.length, 0);
  });
});

describe("subdomains", () => {
  it("claim POSTs name/deployment_id without auth when no projectId", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ name: "app", deployment_id: "dpl_1", url: "u", deployment_url: "du", project_id: null, created_at: "t", updated_at: "t" }),
    );
    await sdk(fetch).subdomains.claim("app", "dpl_1");
    assert.equal(calls[0]!.url, "https://api.test/subdomains/v1");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { name: "app", deployment_id: "dpl_1" });
  });

  it("claim adds bearer auth when projectId is given", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ name: "app", deployment_id: "dpl_1", url: "u", deployment_url: "du", project_id: "prj_k", created_at: "t", updated_at: "t" }),
    );
    await sdk(fetch).subdomains.claim("app", "dpl_1", { projectId: "prj_k" });
    assert.equal(calls[0]!.headers["Authorization"], "Bearer s");
  });

  it("delete DELETEs the encoded name path", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await sdk(fetch).subdomains.delete("my app");
    assert.equal(calls[0]!.url, "https://api.test/subdomains/v1/my%20app");
    assert.equal(calls[0]!.method, "DELETE");
  });

  it("list requires a projectId and GETs with bearer, unwrapping the gateway envelope", async () => {
    // Gateway shape is `{ subdomains: [...] }`; SDK must hand back a bare array.
    const { fetch, calls } = mockFetch(() =>
      json({
        subdomains: [
          { name: "demo", url: "https://demo.run402.com", deployment_id: "dep_1", deployment_url: "https://x.run402.com" },
        ],
      }),
    );
    const result = await sdk(fetch).subdomains.list("prj_k");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer s");
    assert.ok(Array.isArray(result), "list() must return a bare array, not the envelope");
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "demo");
  });
});

describe("domains (custom)", () => {
  it("add POSTs domain+subdomain", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ domain: "ex.com", subdomain_name: "app", url: "https://ex.com", subdomain_url: "https://app.run402.com", status: "pending", dns_instructions: null, project_id: "prj_k", created_at: "t" }),
    );
    await sdk(fetch).domains.add("prj_k", "ex.com", "app");
    assert.equal(calls[0]!.url, "https://api.test/domains/v1");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { domain: "ex.com", subdomain_name: "app" });
  });

  it("status GETs the domain path", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ domain: "ex.com", subdomain_name: "app", url: "u", subdomain_url: "su", status: "active", dns_instructions: null, created_at: "t" }),
    );
    const res = await sdk(fetch).domains.status("prj_k", "ex.com");
    assert.equal(calls[0]!.url, "https://api.test/domains/v1/ex.com");
    assert.equal(res.status, "active");
  });

  it("remove DELETEs with optional projectId auth", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await sdk(fetch).domains.remove("ex.com");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    await sdk(fetch).domains.remove("ex.com", { projectId: "prj_k" });
    assert.equal(calls[1]!.headers["Authorization"], "Bearer s");
  });
});

describe("sites", () => {
  // Inline-bytes `sites.deploy(files)` was removed in v1.32 (see sdk/src/node/
  // sites-node.test.ts for plan/commit transport coverage). The isomorphic
  // surface only retains the public read-only `getDeployment` helper.
  it("getDeployment GETs public endpoint with no auth", async () => {
    const { fetch, calls } = mockFetch(() => json({ id: "dpl_1", name: "site", url: "u", status: "active", files_count: 3, total_size: 1024 }));
    await sdk(fetch).sites.getDeployment("dpl_1");
    assert.equal(calls[0]!.url, "https://api.test/deployments/v1/dpl_1");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
  });
});

describe("service (public)", () => {
  it("status GETs /status with no auth", async () => {
    const { fetch, calls } = mockFetch(() => json({ schema_version: "run402-status-v1", current_status: "ok" }));
    const res = await sdk(fetch).service.status();
    assert.equal(calls[0]!.url, "https://api.test/status");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    assert.equal(res.current_status, "ok");
  });

  it("health GETs /health with no auth", async () => {
    const { fetch, calls } = mockFetch(() => json({ status: "healthy", checks: { db: "ok" } }));
    await sdk(fetch).service.health();
    assert.equal(calls[0]!.url, "https://api.test/health");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
  });
});
