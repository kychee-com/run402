import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "../index.js";
import { LocalError, ProjectNotFound } from "../errors.js";
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
    assert.equal(calls[0]!.url, "https://api.test/projects/v1/admin/prj_k/secrets/STRIPE_KEY");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer s");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { value: "sk_xxx" });
  });

  it("list GETs raw secrets endpoint and strips value_hash from legacy envelopes", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ secrets: [{ key: "K", value_hash: "a1b2c3d4", created_at: "c", updated_at: "u" }] }),
    );
    const res = await sdk(fetch).secrets.list("prj_k");
    assert.equal(calls[0]!.method, "GET");
    assert.deepEqual(res.secrets, [{ key: "K", created_at: "c", updated_at: "u" }]);
    assert.equal("value_hash" in res.secrets[0]!, false);
  });

  it("list accepts the shipped raw array response", async () => {
    const { fetch } = mockFetch(() => json([{ key: "K", created_at: "c" }]));
    const res = await sdk(fetch).secrets.list("prj_k");
    assert.deepEqual(res.secrets, [{ key: "K", created_at: "c" }]);
  });

  it("set validates keys and the 4 KiB UTF-8 value cap before fetch", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await assert.rejects(
      sdk(fetch).secrets.set("prj_k", "bad-key", "v"),
      LocalError,
    );
    await assert.rejects(
      sdk(fetch).secrets.set("prj_k", "BIG", "x".repeat(4097)),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });

  it("delete DELETEs the secret path with URL-encoded key", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await sdk(fetch).secrets.delete("prj_k", "my key");
    assert.equal(calls[0]!.url, "https://api.test/projects/v1/admin/prj_k/secrets/my%20key");
    assert.equal(calls[0]!.method, "DELETE");
  });

  it("delete returns the gateway envelope with status and key", async () => {
    const { fetch } = mockFetch(() => json({ status: "deleted", key: "STRIPE_KEY" }));
    const result = await sdk(fetch).secrets.delete("prj_k", "STRIPE_KEY");
    assert.equal(result.status, "deleted");
    assert.equal(result.key, "STRIPE_KEY");
  });

  it("throws ProjectNotFound without any fetch for unknown project", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await assert.rejects(sdk(fetch).secrets.set("prj_missing", "K", "V"), ProjectNotFound);
    assert.equal(calls.length, 0);
  });
});

describe("subdomains", () => {
  it("claim throws LocalError when no projectId and no active project", async () => {
    const { fetch } = mockFetch(() => json({}));
    await assert.rejects(
      sdk(fetch).subdomains.claim("app", "dpl_1"),
      (err: Error) => /projectId|active project/.test(err.message),
    );
  });

  it("claim adds bearer auth when projectId is given", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ name: "app", deployment_id: "dpl_1", url: "u", deployment_url: "du", project_id: "prj_k", created_at: "t", updated_at: "t" }),
    );
    await sdk(fetch).subdomains.claim("app", "dpl_1", { projectId: "prj_k" });
    assert.equal(calls[0]!.headers["Authorization"], "Bearer s");
  });

  it("delete throws LocalError when no projectId and no active project", async () => {
    const { fetch } = mockFetch(() => json({}));
    await assert.rejects(
      sdk(fetch).subdomains.delete("my app"),
      (err: Error) => /projectId|active project/.test(err.message),
    );
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

  it("remove returns the gateway envelope with status and domain", async () => {
    const { fetch } = mockFetch(() => json({ status: "deleted", domain: "ex.com" }));
    const result = await sdk(fetch).domains.remove("ex.com");
    assert.equal(result.status, "deleted");
    assert.equal(result.domain, "ex.com");
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
