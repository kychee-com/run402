import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { ProjectCredentialNotFound, Unauthorized } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handler: (call: FetchCall) => Response): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
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

function makeSdk(credentials: CredentialsProvider, fetch: typeof globalThis.fetch): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials,
    fetch,
  });
}

function principalCreds(): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProjectCredentials(id) {
      throw new Error(`unexpected local project credential lookup for ${id}`);
    },
  };
}

describe("domains principal auth", () => {
  it("lists domains with principal auth by default without reading local project credentials", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/domains/v1?project_id=prj_visible");
      assert.equal(call.headers["SIGN-IN-WITH-X"], "test-siwx");
      assert.equal(call.headers.Authorization, undefined);
      return jsonResponse({ domains: [] });
    });

    const sdk = makeSdk(principalCreds(), fetch);
    assert.deepEqual(await sdk.domains.list("prj_visible"), { domains: [] });
    assert.equal(calls.length, 1);
  });

  it("adds domains with project_id in the body by default", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/domains/v1");
      assert.equal(call.method, "POST");
      assert.equal(call.headers["SIGN-IN-WITH-X"], "test-siwx");
      assert.equal(call.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(call.body as string), {
        project_id: "prj_visible",
        domain: "example.com",
        subdomain_name: "app",
      });
      return jsonResponse({
        domain: "example.com",
        subdomain_name: "app",
        url: "https://example.com",
        subdomain_url: "https://app.run402.app",
        status: "pending",
        dns_instructions: null,
        project_id: "prj_visible",
        created_at: "2026-07-01T00:00:00Z",
      });
    });

    const sdk = makeSdk(principalCreds(), fetch);
    const result = await sdk.domains.add("prj_visible", {
      domain: "example.com",
      subdomainName: "app",
    });
    assert.equal(result.project_id, "prj_visible");
    assert.equal(calls.length, 1);
  });

  it("requires explicit service_key auth before using the local credential cache", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ domains: [] }));
    const sdk = makeSdk({
      async getAuth() {
        return { "SIGN-IN-WITH-X": "test-siwx" };
      },
      async getProjectCredentials() {
        return null;
      },
      getProjectCredentialCacheInfo() {
        return {
          source: "local_cache",
          cache_path: "/tmp/project-keys.v1.json",
          profile: "kychon",
        };
      },
    }, fetch);

    await assert.rejects(
      sdk.domains.list("prj_missing", { authMode: "service_key" }),
      (err: unknown) => {
        assert.ok(err instanceof ProjectCredentialNotFound);
        assert.equal(err.code, "PROJECT_CREDENTIAL_NOT_FOUND");
        assert.deepEqual(err.details, {
          project_id: "prj_missing",
          source: "local_cache",
          cache_path: "/tmp/project-keys.v1.json",
          profile: "kychon",
        });
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it("preserves gateway project-credential mismatch codes for service-key auth", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.headers.Authorization, "Bearer svc_project");
      return jsonResponse({
        status: "error",
        message: "Service key project_id does not match explicit project_id",
        code: "PROJECT_CREDENTIAL_PROJECT_MISMATCH",
        details: { source: "service_key" },
      }, 403);
    });
    const sdk = makeSdk({
      async getAuth() {
        return null;
      },
      async getProjectCredentials() {
        return { anon_key: "anon_project", service_key: "svc_project" };
      },
    }, fetch);

    await assert.rejects(
      sdk.domains.list("prj_visible", { authMode: "service_key" }),
      (err: unknown) => {
        assert.ok(err instanceof Unauthorized);
        assert.equal(err.code, "PROJECT_CREDENTIAL_PROJECT_MISMATCH");
        assert.deepEqual(err.details, { source: "service_key" });
        assert.ok(!(err instanceof ProjectCredentialNotFound));
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });
});
