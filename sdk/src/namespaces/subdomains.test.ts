/**
 * Unit tests for the `subdomains` namespace. Each test mocks `fetch` via a
 * custom implementation passed to `new Run402()`. Verifies URL, method,
 * headers, body composition, and response parsing per method.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { ProjectNotFound } from "../errors.js";
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

describe("subdomains.list", () => {
  it("returns the array of summaries with project_id and timestamps populated", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        subdomains: [
          {
            name: "odbc-port",
            deployment_id: "dpl_molnjnty_089d0e",
            url: "https://odbc-port.run402.com",
            deployment_url: "https://dpl-molnjnty-089d0e.sites.run402.com",
            project_id: "prj_1777563179844_1095",
            created_at: "2026-04-30T15:42:08.080Z",
            updated_at: "2026-04-30T15:42:08.080Z",
          },
        ],
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.subdomains.list("prj_known");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/subdomains/v1");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.equal(result.length, 1);
    const item = result[0]!;
    assert.equal(item.name, "odbc-port");
    assert.equal(item.deployment_id, "dpl_molnjnty_089d0e");
    assert.equal(item.url, "https://odbc-port.run402.com");
    assert.equal(item.deployment_url, "https://dpl-molnjnty-089d0e.sites.run402.com");
    assert.equal(item.project_id, "prj_1777563179844_1095");
    assert.equal(item.created_at, "2026-04-30T15:42:08.080Z");
    assert.equal(item.updated_at, "2026-04-30T15:42:08.080Z");
  });

  it("returns [] when gateway returns no subdomains key", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.subdomains.list("prj_known");
    assert.deepEqual(result, []);
  });

  it("throws ProjectNotFound for unknown ids before hitting the network", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(sdk.subdomains.list("prj_missing"), ProjectNotFound);
    assert.equal(calls.length, 0);
  });
});

describe("subdomains.delete", () => {
  it("returns the deleted record from the gateway response", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        name: "x",
        deployment_id: "dpl_y",
        project_id: "prj_z",
        deleted_at: "2026-05-01T12:00:00.000Z",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.subdomains.delete("x", { projectId: "prj_known" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/subdomains/v1/x");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.equal(result.name, "x");
    assert.equal(result.deployment_id, "dpl_y");
    assert.equal(result.project_id, "prj_z");
    assert.equal(result.deleted_at, "2026-05-01T12:00:00.000Z");
  });

  it("works without a projectId (no Authorization header)", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        name: "x",
        deployment_id: "dpl_y",
        project_id: "prj_z",
        deleted_at: "2026-05-01T12:00:00.000Z",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.subdomains.delete("x");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    assert.equal(result.name, "x");
  });

  it("throws ProjectNotFound for unknown ids before hitting the network", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(makeCreds(), fetch);
    await assert.rejects(
      sdk.subdomains.delete("x", { projectId: "prj_missing" }),
      ProjectNotFound,
    );
    assert.equal(calls.length, 0);
  });
});

describe("subdomains.claim", () => {
  it("POSTs /subdomains/v1 with name and deployment_id", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        name: "x",
        deployment_id: "dpl_y",
        url: "https://x.run402.com",
        deployment_url: "https://dpl-y.sites.run402.com",
        project_id: "prj_z",
        created_at: "2026-05-01T12:00:00.000Z",
        updated_at: "2026-05-01T12:00:00.000Z",
      }),
    );
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.subdomains.claim("x", "dpl_y", { projectId: "prj_known" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/subdomains/v1");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_xxx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      name: "x",
      deployment_id: "dpl_y",
    });
    assert.equal(result.name, "x");
  });
});
