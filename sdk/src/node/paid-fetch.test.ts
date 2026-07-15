/**
 * Tests for the Node paid-fetch lazy wrapper. Full x402 retry against a
 * funded wallet on real chains is out of scope here (belongs in integration
 * tests, not unit). What we verify:
 *   - setupPaidFetch returns null when no allowance file exists
 *   - RPC reads retry and fail over without becoming a zero balance
 *   - RPC-unavailable and confirmed-insufficient states stay distinct
 *   - createLazyPaidFetch recovers from transient initialization/preflight
 *     failures instead of caching degraded state
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  __paidFetchInternals,
  checkBalanceAcrossProviders,
  createLazyPaidFetch,
  filterAffordableRequirements,
  setupPaidFetch,
  X402BalanceError,
} from "./paid-fetch.js";

let tempDir: string;
const originalConfigDir = process.env.RUN402_CONFIG_DIR;
const originalApiBase = process.env.RUN402_API_BASE;
const originalFetch = globalThis.fetch;

before(() => {
  process.env.RUN402_API_BASE = "https://api.run402.test";
});

after(() => {
  if (originalApiBase !== undefined) process.env.RUN402_API_BASE = originalApiBase;
  else delete process.env.RUN402_API_BASE;
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-sdk-paidfetch-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (originalConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = originalConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

describe("setupPaidFetch", () => {
  it("returns null when no allowance file exists", async () => {
    const f = await setupPaidFetch();
    assert.equal(f, null);
  });
});

describe("x402 balance preflight", () => {
  it("retries a provider with deterministic backoff, then fails over independently", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const sleeps: number[] = [];
    const balance = await checkBalanceAcrossProviders(
      [
        {
          async readContract() {
            firstCalls += 1;
            throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
          },
        },
        {
          async readContract() {
            secondCalls += 1;
            return 250_000n;
          },
        },
      ],
      "0xtoken",
      "0xwallet",
      "eip155:8453",
      {
        attemptsPerProvider: 2,
        baseDelayMs: 100,
        random: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    );

    assert.equal(balance, 250_000n);
    assert.equal(firstCalls, 2);
    assert.equal(secondCalls, 1);
    assert.deepEqual(sleeps, [100]);
  });

  it("reports exhausted timeouts as retryable unknown balance, never zero", async () => {
    const timeoutClient = {
      async readContract(): Promise<bigint> {
        throw Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
      },
    };

    await assert.rejects(
      () =>
        checkBalanceAcrossProviders(
          [timeoutClient, timeoutClient],
          "0xtoken",
          "0xwallet",
          "eip155:84532",
          { attemptsPerProvider: 1, sleep: async () => undefined },
        ),
      (err: unknown) => {
        assert.ok(err instanceof X402BalanceError);
        assert.equal(err.code, "X402_RPC_TIMEOUT");
        assert.equal(err.retryable, true);
        assert.equal(err.safeToRetry, true);
        assert.equal(err.mutationState, "not_started");
        assert.partialDeepStrictEqual(err.details, {
          payment_started: false,
          balance_status: "unknown",
          providers_exhausted: true,
        });
        return true;
      },
    );
  });

  it("keeps rate limiting distinct from general RPC unavailability", async () => {
    await assert.rejects(
      () =>
        checkBalanceAcrossProviders(
          [
            {
              async readContract(): Promise<bigint> {
                throw Object.assign(new Error("Too many requests"), { status: 429 });
              },
            },
          ],
          "0xtoken",
          "0xwallet",
          "eip155:8453",
          { attemptsPerProvider: 1, sleep: async () => undefined },
        ),
      (err: unknown) => {
        assert.ok(err instanceof X402BalanceError);
        assert.equal(err.code, "X402_RPC_RATE_LIMITED");
        return true;
      },
    );
  });

  it("throws confirmed insufficient funds only after successful balance reads", () => {
    assert.throws(
      () =>
        filterAffordableRequirements(
          [{ network: "eip155:8453", amount: "250000" }],
          { "eip155:8453": { status: "known", balance: 10n } },
        ),
      (err: unknown) => {
        assert.ok(err instanceof X402BalanceError);
        assert.equal(err.code, "X402_INSUFFICIENT_FUNDS");
        assert.equal(err.retryable, false);
        assert.equal(err.safeToRetry, false);
        assert.equal(err.mutationState, "not_started");
        return true;
      },
    );
  });

  it("prefers an unknown-balance RPC error over a false insufficient-funds result", () => {
    const rpcError = new X402BalanceError(
      "X402_RPC_UNAVAILABLE",
      "balance unknown",
      { network: "eip155:84532" },
    );
    assert.throws(
      () =>
        filterAffordableRequirements(
          [
            { network: "eip155:8453", amount: "250000" },
            { network: "eip155:84532", amount: "250000" },
          ],
          {
            "eip155:8453": { status: "known", balance: 0n },
            "eip155:84532": { status: "unknown", error: rpcError },
          },
        ),
      (err: unknown) => err === rpcError,
    );
  });
});

describe("createLazyPaidFetch", () => {
  it("falls back to globalThis.fetch when no allowance is configured", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof globalThis.fetch;

    const fetchFn = createLazyPaidFetch();
    const res = await fetchFn("https://example.test/x");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(calls, ["https://example.test/x"]);
  });

  it("does not cache a transient initialization failure", async () => {
    let setupCalls = 0;
    const fetchFn = __paidFetchInternals.createLazyPaidFetchFrom(async () => {
      setupCalls += 1;
      if (setupCalls === 1) throw new Error("temporary setup failure");
      return (async () => new Response("recovered", { status: 200 })) as typeof globalThis.fetch;
    });

    await assert.rejects(() => fetchFn("https://example.test/paid"), /temporary setup failure/);
    const response = await fetchFn("https://example.test/paid");
    assert.equal(await response.text(), "recovered");
    assert.equal(setupCalls, 2);
  });

  it("drops a cached wrapper after a retryable RPC preflight failure", async () => {
    let setupCalls = 0;
    const fetchFn = __paidFetchInternals.createLazyPaidFetchFrom(async () => {
      setupCalls += 1;
      if (setupCalls === 1) {
        return (async () => {
          throw new X402BalanceError(
            "X402_RPC_UNAVAILABLE",
            "providers unavailable",
            { network: "eip155:8453" },
          );
        }) as typeof globalThis.fetch;
      }
      return (async () => new Response("ok", { status: 200 })) as typeof globalThis.fetch;
    });

    await assert.rejects(
      () => fetchFn("https://example.test/paid"),
      (err: unknown) => err instanceof X402BalanceError && err.code === "X402_RPC_UNAVAILABLE",
    );
    const response = await fetchFn("https://example.test/paid");
    assert.equal(response.status, 200);
    assert.equal(setupCalls, 2);
  });
});
