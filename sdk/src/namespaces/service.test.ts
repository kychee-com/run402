/**
 * Unit tests for the `service` namespace. Verifies URL, method, auth omission,
 * and runtime payload shape per method (GH-173 type alignment).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";
import type {
  ServiceStatusPayload,
  ServiceHealthPayload,
} from "./service.js";

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
    async getProject() {
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

describe("service.status", () => {
  it("GETs /status without auth and returns the runtime payload shape", async () => {
    const runtimeBody = {
      status: "ok",
      uptime_seconds: 388,
      deployment: { version: "1.0.4" },
      capabilities: [
        "x402",
        "siwx",
        "postgres",
        "functions",
        "blob",
        "email",
        "mailboxes",
        "mpp",
      ],
      operator: { name: "Run402", contact: "https://run402.com" },
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(runtimeBody));
    const sdk = makeSdk(makeCreds(), fetch);
    const result: ServiceStatusPayload = await sdk.service.status();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/status");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);

    assert.equal(result.status, "ok");
    assert.equal(result.uptime_seconds, 388);
    assert.deepEqual(result.deployment, { version: "1.0.4" });
    assert.ok(Array.isArray(result.capabilities));
    assert.equal(result.capabilities.length, 8);
    assert.equal(result.capabilities[0], "x402");
    assert.equal(result.operator.name, "Run402");
    assert.equal(result.operator.contact, "https://run402.com");
  });
});

describe("service.health", () => {
  it("GETs /health without auth and returns required status/checks/version", async () => {
    const runtimeBody = {
      status: "healthy",
      checks: {
        postgres: "ok",
        postgrest: "ok",
        s3: "ok",
        cloudfront: "ok",
      },
      version: "1.0.4",
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(runtimeBody));
    const sdk = makeSdk(makeCreds(), fetch);
    const result: ServiceHealthPayload = await sdk.service.health();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/health");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);

    assert.equal(result.status, "healthy");
    assert.equal(result.version, "1.0.4");
    assert.equal(result.checks.postgres, "ok");
    assert.equal(result.checks.postgrest, "ok");
    assert.equal(result.checks.s3, "ok");
    assert.equal(result.checks.cloudfront, "ok");
  });
});
