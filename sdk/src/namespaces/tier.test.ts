/**
 * Unit tests for the `tier` namespace. Verifies URL, method, SIWX auth, and
 * runtime payload shape per method (GH-173 type alignment).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";
import type { TierStatusResult } from "./tier.js";

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

describe("tier.status", () => {
  it("GETs /tiers/v1/status with SIWX auth and returns runtime shape", async () => {
    const runtimeBody = {
      wallet: "0xad17000000000000000000000000000000000000",
      tier: "prototype",
      lease_started_at: "2026-04-23T14:49:10.884Z",
      lease_expires_at: "2026-05-07T14:49:10.884Z",
      active: true,
      pool_usage: {
        projects: 37,
        total_api_calls: 8489,
        total_storage_bytes: 298792511,
        api_calls_limit: 500000,
        storage_bytes_limit: 10737418240,
      },
    };
    const { fetch, calls } = mockFetch(() => jsonResponse(runtimeBody));
    const sdk = makeSdk(makeCreds(), fetch);
    const result: TierStatusResult = await sdk.tier.status();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/tiers/v1/status");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");

    assert.equal(result.wallet, "0xad17000000000000000000000000000000000000");
    assert.equal(result.tier, "prototype");
    assert.equal(result.lease_started_at, "2026-04-23T14:49:10.884Z");
    assert.equal(result.lease_expires_at, "2026-05-07T14:49:10.884Z");
    assert.equal(result.active, true);

    assert.equal(result.pool_usage.projects, 37);
    assert.equal(result.pool_usage.total_api_calls, 8489);
    assert.equal(result.pool_usage.total_storage_bytes, 298792511);
    assert.equal(result.pool_usage.api_calls_limit, 500000);
    assert.equal(result.pool_usage.storage_bytes_limit, 10737418240);

    assert.equal(
      (result as unknown as { status?: unknown }).status,
      undefined,
      "runtime body has no `status` field; the type must not declare one",
    );
  });

  it("accepts null tier and null lease timestamps for unsubscribed wallets", async () => {
    const runtimeBody = {
      wallet: "0xfeed000000000000000000000000000000000000",
      tier: null,
      lease_started_at: null,
      lease_expires_at: null,
      active: false,
      pool_usage: {
        projects: 0,
        total_api_calls: 0,
        total_storage_bytes: 0,
        api_calls_limit: 0,
        storage_bytes_limit: 0,
      },
    };
    const { fetch } = mockFetch(() => jsonResponse(runtimeBody));
    const sdk = makeSdk(makeCreds(), fetch);
    const result = await sdk.tier.status();

    assert.equal(result.tier, null);
    assert.equal(result.lease_started_at, null);
    assert.equal(result.lease_expires_at, null);
    assert.equal(result.active, false);
  });
});
