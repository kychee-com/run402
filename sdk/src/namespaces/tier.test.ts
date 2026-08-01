/**
 * Unit tests for the `tier` namespace. Verifies URL, method, SIWX auth, and
 * runtime payload shape per method (GH-173 type alignment).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PaymentBuyerError, RUN402_MPP_LIGHTNING_PROFILE, Run402 } from "../index.js";
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
      function_limits: {
        max_function_timeout_seconds: 10,
        max_function_memory_mb: 128,
        max_scheduled_functions: 1,
        min_cron_interval_minutes: 15,
        current_scheduled_functions: 1,
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
    assert.equal(result.function_limits?.max_function_timeout_seconds, 10);
    assert.equal(result.function_limits?.max_function_memory_mb, 128);
    assert.equal(result.function_limits?.max_scheduled_functions, 1);
    assert.equal(result.function_limits?.min_cron_interval_minutes, 15);
    assert.equal(result.function_limits?.current_scheduled_functions, 1);

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

describe("tier.set idempotency", () => {
  const setBody = {
    wallet: "0xad17000000000000000000000000000000000000",
    action: "subscribe",
    tier: "prototype",
    previous_tier: null,
    lease_started_at: "2026-04-23T14:49:10.884Z",
    lease_expires_at: "2026-04-30T14:49:10.884Z",
    allowance_remaining_usd_micros: 0,
  };

  it("sends the Idempotency-Key header when idempotencyKey is provided", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(setBody));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.tier.set("prototype", { idempotencyKey: "k1" });
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.example.test/tiers/v1/prototype");
    assert.equal(calls[0]!.headers["Idempotency-Key"], "k1");
  });

  it("omits the Idempotency-Key header when no key is provided (no auto-derive)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(setBody));
    const sdk = makeSdk(makeCreds(), fetch);
    await sdk.tier.set("prototype");
    assert.equal(calls[0]!.headers["Idempotency-Key"], undefined);
  });

  it("uses the shared payment executor with identical auth, body, key, and policy", async () => {
    let paidCall: { url: string; init?: RequestInit; options?: unknown } | null = null;
    const sdk = new Run402({
      apiBase: "https://api.example.test",
      credentials: makeCreds(),
      fetch: async () => { throw new Error("legacy fetch must not run"); },
      payExecutor: async (url, init, options) => {
        paidCall = { url, init, options };
        return {
          response: jsonResponse(setBody, 201),
          payment: null,
          outcome: "settled",
          replay: false,
          paymentResult: {
            protocol: "mpp", method: "lightning", intent: "charge",
            profile: RUN402_MPP_LIGHTNING_PROFILE, intentId: "pint_1", attemptId: "patt_1",
            canonicalAmountUsdMicros: 100_000, invoiceAmountMsat: 80_000,
            receivedAmountMsat: 80_000, excessAmountMsat: 0, paymentHash: "11".repeat(32),
            fundsMoved: true, rawNodeState: "SETTLED", terminality: "terminal_paid",
            settlementRole: "primary", operationState: "succeeded", recoveryState: "none",
            replay: false, paymentReceipt: "receipt", settlementAttestation: null,
            outcomeAttestations: [], merchantFulfillment: setBody, currentStatus: null, credits: [],
          },
        };
      },
    });
    const result = await sdk.tier.set("prototype", {
      idempotencyKey: "tier:lightning:1",
      profile: RUN402_MPP_LIGHTNING_PROFILE,
      maxUsdMicros: 100_000,
      maxNativeAmountMsat: 100_000,
      maxRoutingFeeMsat: 10_000,
      principalTransport: "siwx",
      paymentPreferences: [
        { protocol: "mpp", method: "lightning", intent: "charge", wallet: "nwc:deploy-bot" },
      ],
    });
    assert.equal(paidCall?.url, "https://api.example.test/tiers/v1/prototype");
    const headers = new Headers(paidCall?.init?.headers);
    assert.equal(headers.get("sign-in-with-x"), "test-siwx");
    assert.equal(headers.get("idempotency-key"), "tier:lightning:1");
    assert.equal(paidCall?.init?.body, "{}");
    assert.equal(result.payment_result?.method, "lightning");
  });

  it("refuses a Lightning-capable tier call without a stable caller key before dispatch", async () => {
    let dispatched = false;
    const sdk = new Run402({
      apiBase: "https://api.example.test",
      credentials: makeCreds(),
      payExecutor: async () => {
        dispatched = true;
        throw new Error("must not run");
      },
    });
    await assert.rejects(sdk.tier.set("prototype", {
      profile: RUN402_MPP_LIGHTNING_PROFILE,
      maxUsdMicros: 100_000,
      maxNativeAmountMsat: 100_000,
      maxRoutingFeeMsat: 10_000,
      paymentPreferences: [
        { protocol: "mpp", method: "lightning", intent: "charge", wallet: "nwc:deploy-bot" },
      ],
    }), (error: unknown) => error instanceof PaymentBuyerError && error.fundsMoved === false);
    assert.equal(dispatched, false);
  });
});
