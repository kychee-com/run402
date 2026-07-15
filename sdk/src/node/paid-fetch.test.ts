/**
 * Tests for the Node paid-fetch lazy wrapper. Full x402 retry against a
 * funded wallet on real chains is out of scope here (belongs in integration
 * tests, not unit). What we verify:
 *   - setupPaidFetch returns null when no allowance file exists
 *   - RPC reads retry and fail over without becoming a zero balance
 *   - RPC-unavailable and confirmed-insufficient states stay distinct
 *   - createLazyPaidFetch recovers from transient initialization/preflight
 *     failures instead of caching degraded state
 *   - payment source precedence is deterministic and never inherits an
 *     ambient wallet after a custom source is selected
 *   - opaque async signers expose only the public payer + sign operation
 *   - lazy initialization recovers when an allowance appears later
 *   - createLazyPaidFetch transparently falls back to globalThis.fetch
 *     when setupPaidFetch returns null
 *   - each x402 failure boundary produces a canonical retry-safe or ambiguous
 *     PaymentAttemptError and a sanitized durable attempt record
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveAllowance } from "../../../core/src/allowance.js";
import type { AllowanceData, CredentialsProvider } from "../credentials.js";
import { LocalError, PaymentAttemptError } from "../errors.js";
import type { X402Stack } from "./_paid-stack.js";
import { run402 } from "./index.js";
import {
  _setPaidStackLoadersForTest,
  __paidFetchInternals,
  checkBalanceAcrossProviders,
  createLazyPaidFetch,
  createTrackedX402Fetch,
  filterAffordableRequirements,
  setupPaidFetch,
  X402BalanceError,
  type EvmPaymentSigner,
} from "./paid-fetch.js";
import {
  PAYMENT_ATTEMPT_HEADER,
  createFilePaymentAttemptStore,
  listPaymentAttempts,
  type PaymentAttemptRecord,
  type PaymentAttemptStore,
} from "./payment-attempts.js";

const PRIVATE_KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS_A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const PRIVATE_KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDRESS_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

let tempDir: string;
const originalConfigDir = process.env.RUN402_CONFIG_DIR;
const originalApiBase = process.env.RUN402_API_BASE;
const originalFetch = globalThis.fetch;
let loadedPrivateKeys: string[];
let stackLoadCount: number;
let paidPayers: string[];
let balanceReader: () => Promise<bigint>;
let simulatePaymentChallenge: boolean;

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
  loadedPrivateKeys = [];
  stackLoadCount = 0;
  paidPayers = [];
  balanceReader = async () => 1_000_000n;
  simulatePaymentChallenge = false;
  _setPaidStackLoadersForTest({ x402: async () => fakeX402Stack() });
});

afterEach(() => {
  if (originalConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = originalConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  _setPaidStackLoadersForTest();
});

describe("setupPaidFetch", () => {
  it("returns null when no allowance file exists", async () => {
    const f = await setupPaidFetch();
    assert.equal(f, null);
  });

  it("uses an explicit allowancePath instead of the ambient wallet", async () => {
    saveAllowance(allowance(ADDRESS_A, PRIVATE_KEY_A), join(tempDir, "allowance.json"));
    const explicitPath = join(tempDir, "payer-b.json");
    saveAllowance(allowance(ADDRESS_B, PRIVATE_KEY_B), explicitPath);
    mockFetch();

    const f = await setupPaidFetch({ allowancePath: explicitPath });
    assert.ok(f);
    assert.deepEqual(f.payer, {
      source: "allowance_path",
      rail: "x402",
      payers: [
        { address: ADDRESS_B, network: "eip155:8453" },
        { address: ADDRESS_B, network: "eip155:84532" },
      ],
    });
    await f("https://example.test/paid");

    assert.deepEqual(loadedPrivateKeys, [PRIVATE_KEY_B]);
    assert.deepEqual(paidPayers, [ADDRESS_B]);
  });

  it("uses a supplied credentials provider as the implicit payment source", async () => {
    saveAllowance(allowance(ADDRESS_A, PRIVATE_KEY_A), join(tempDir, "allowance.json"));
    mockFetch();

    const f = await setupPaidFetch({
      credentials: {
        async readAllowance() {
          return allowance(ADDRESS_B, PRIVATE_KEY_B);
        },
      },
    });
    assert.ok(f);
    await f("https://example.test/paid");

    assert.deepEqual(loadedPrivateKeys, [PRIVATE_KEY_B]);
    assert.deepEqual(paidPayers, [ADDRESS_B]);
  });

  it("fails closed instead of falling back to the ambient wallet", async () => {
    saveAllowance(allowance(ADDRESS_A, PRIVATE_KEY_A), join(tempDir, "allowance.json"));

    const f = await setupPaidFetch({ credentials: {} });

    assert.equal(f, null);
    assert.equal(stackLoadCount, 0);
    assert.deepEqual(loadedPrivateKeys, []);
  });

  it("rejects conflicting explicit payment sources", async () => {
    const paymentSigner = {
      async getSigner(): Promise<EvmPaymentSigner> {
        return signer(ADDRESS_B);
      },
    };

    await assert.rejects(
      setupPaidFetch({ allowancePath: join(tempDir, "allowance.json"), paymentSigner }),
      (err: unknown) => err instanceof LocalError && err.code === "PAYMENT_SOURCE_CONFLICT",
    );
  });

  it("accepts an opaque async signer without receiving its key material", async () => {
    const requestedNetworks: string[] = [];
    mockFetch();

    const f = await setupPaidFetch({
      paymentSigner: {
        async getSigner({ network }) {
          requestedNetworks.push(network);
          return signer(ADDRESS_B);
        },
      },
    });
    assert.ok(f);
    await f("https://example.test/paid");

    assert.deepEqual(requestedNetworks, ["eip155:8453", "eip155:84532"]);
    assert.deepEqual(loadedPrivateKeys, []);
    assert.deepEqual(f.payer, {
      source: "payment_signer",
      rail: "x402",
      payers: [
        { address: ADDRESS_B, network: "eip155:8453" },
        { address: ADDRESS_B, network: "eip155:84532" },
      ],
    });
    assert.deepEqual(paidPayers, [ADDRESS_B]);
  });

  it("preserves payer provenance and journals the signed request in the integrated wrapper", async () => {
    simulatePaymentChallenge = true;
    const calls: Array<{ attemptId: string | null; payment: string | null; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (_input, init) => {
      calls.push({
        attemptId: new Headers(init?.headers).get(PAYMENT_ATTEMPT_HEADER),
        payment: new Headers(init?.headers).get("PAYMENT-SIGNATURE"),
        redirect: init?.redirect,
      });
      return calls.length === 1
        ? new Response("payment required", { status: 402 })
        : new Response("created", { status: 201 });
    }) as typeof globalThis.fetch;

    const f = await setupPaidFetch({
      paymentSigner: { async getSigner() { return signer(ADDRESS_B); } },
    });
    assert.ok(f);
    assert.equal(typeof f.refreshBalances, "function");
    assert.equal(f.payer.payers[0]?.address, ADDRESS_B);

    const response = await f("https://paid.example/envelopes", { method: "POST" });

    assert.equal(response.status, 201);
    assert.deepEqual(calls.map((call) => ({ ...call, attemptId: call.attemptId ? "present" : null })), [
      { attemptId: null, payment: null, redirect: undefined },
      { attemptId: "present", payment: "fake-proof", redirect: "error" },
    ]);
    const records = listPaymentAttempts();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.state, "completed");
    assert.equal(records[0]?.mutation_state, "completed");
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

  it("retries initialization after a payment provider recovers", async () => {
    let current: AllowanceData | null = null;
    const headers: Headers[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;
    const fetchFn = createLazyPaidFetch({
      credentials: {
        async readAllowance() {
          return current;
        },
      },
    });

    await fetchFn("https://example.test/first");
    assert.equal(await fetchFn.getPayer(), null);
    current = allowance(ADDRESS_B, PRIVATE_KEY_B);
    assert.deepEqual(await fetchFn.getPayer(), {
      source: "credentials",
      rail: "x402",
      payers: [
        { address: ADDRESS_B, network: "eip155:8453" },
        { address: ADDRESS_B, network: "eip155:84532" },
      ],
    });
    await fetchFn("https://example.test/second");
    await fetchFn("https://example.test/third");

    assert.equal(headers[0].get("x-test-payer"), null);
    assert.equal(headers[1].get("x-test-payer"), ADDRESS_B);
    assert.equal(headers[2].get("x-test-payer"), ADDRESS_B);
    assert.equal(stackLoadCount, 1, "successful paid fetch is cached after recovery");
  });

  it("refreshes RPC balances without re-resolving or changing the selected payer", async () => {
    let rpcHealthy = false;
    let signerCalls = 0;
    balanceReader = async () => {
      if (!rpcHealthy) throw Object.assign(new Error("RPC unavailable"), { code: "ECONNRESET" });
      return 1_000_000n;
    };
    mockFetch();
    const fetchFn = createLazyPaidFetch({
      paymentSigner: {
        async getSigner() {
          signerCalls += 1;
          return signer(ADDRESS_B);
        },
      },
    });

    await assert.rejects(
      () => fetchFn("https://example.test/paid"),
      (err: unknown) => err instanceof X402BalanceError && err.code === "X402_RPC_UNAVAILABLE",
    );
    const selected = await fetchFn.getPayer();
    assert.equal(signerCalls, 2, "one signer resolution per supported network");

    rpcHealthy = true;
    const response = await fetchFn("https://example.test/paid");

    assert.equal(response.status, 200);
    assert.equal(signerCalls, 2, "RPC recovery must not re-resolve the signer");
    assert.deepEqual(await fetchFn.getPayer(), selected);
  });

  it("refreshes a confirmed low balance after funding without changing the signer", async () => {
    let funded = false;
    let signerCalls = 0;
    balanceReader = async () => funded ? 1_000_000n : 0n;
    mockFetch();
    const fetchFn = createLazyPaidFetch({
      paymentSigner: {
        async getSigner() {
          signerCalls += 1;
          return signer(ADDRESS_B);
        },
      },
    });

    await assert.rejects(
      () => fetchFn("https://example.test/paid"),
      (err: unknown) => {
        assert.ok(err instanceof X402BalanceError);
        assert.equal(err.code, "X402_INSUFFICIENT_FUNDS");
        assert.equal(err.safeToRetry, false);
        return true;
      },
    );

    funded = true;
    const response = await fetchFn("https://example.test/paid");
    assert.equal(response.status, 200);
    assert.equal(signerCalls, 2, "funding recovery must retain the selected payer");
  });
});

describe("run402 payment wiring", () => {
  it("keeps custom auth credentials separate from an explicit payer path", async () => {
    const explicitPath = join(tempDir, "payer-b.json");
    saveAllowance(allowance(ADDRESS_B, PRIVATE_KEY_B), explicitPath);
    let providerAllowanceReads = 0;
    const credentials = authCredentials({
      async readAllowance() {
        providerAllowanceReads += 1;
        return allowance(ADDRESS_A, PRIVATE_KEY_A);
      },
    });

    const r = run402({ credentials, allowancePath: explicitPath });

    assert.deepEqual(await r.paymentPayer(), {
      source: "allowance_path",
      rail: "x402",
      payers: [
        { address: ADDRESS_B, network: "eip155:8453" },
        { address: ADDRESS_B, network: "eip155:84532" },
      ],
    });
    assert.equal(providerAllowanceReads, 0);
  });

  it("does not let auth-only custom credentials inherit the ambient payer", async () => {
    saveAllowance(allowance(ADDRESS_A, PRIVATE_KEY_A), join(tempDir, "allowance.json"));

    const r = run402({ credentials: authCredentials() });

    assert.equal(await r.paymentPayer(), null);
    assert.equal(stackLoadCount, 0);
  });
});

function allowance(address: string, privateKey: string): AllowanceData {
  return { address, privateKey, rail: "x402" };
}

function authCredentials(overrides: Partial<CredentialsProvider> = {}): CredentialsProvider {
  return {
    async getAuth() {
      return { Authorization: "Bearer auth-principal" };
    },
    async getProjectCredentials() {
      return null;
    },
    ...overrides,
  };
}

function signer(address: `0x${string}`): EvmPaymentSigner {
  return {
    address,
    async signTypedData() {
      return "0x01";
    },
  };
}

function mockFetch(): void {
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof globalThis.fetch;
}

function fakeX402Stack(): X402Stack {
  stackLoadCount += 1;

  class FakeScheme {
    constructor(readonly signer: EvmPaymentSigner) {}
  }

  class FakeClient {
    readonly registrations = new Map<string, FakeScheme>();
    policy?: (version: number, requirements: unknown[]) => unknown[];
    register(network: string, scheme: unknown): void {
      this.registrations.set(network, scheme as FakeScheme);
    }
    registerPolicy(policy: (version: number, requirements: unknown[]) => unknown[]): void {
      this.policy = policy;
    }
  }

  return {
    privateKeyToAccount(privateKey) {
      loadedPrivateKeys.push(privateKey);
      const address = privateKey === PRIVATE_KEY_B ? ADDRESS_B : ADDRESS_A;
      return signer(address);
    },
    createPublicClient() {
      return {
        async readContract() {
          return balanceReader();
        },
      };
    },
    http() {
      return {};
    },
    base: { id: 8453 },
    baseSepolia: { id: 84532 },
    x402Client: FakeClient,
    wrapFetchWithPayment(fetchFn, rawClient) {
      const client = rawClient as FakeClient;
      return async (input, init) => {
        if (simulatePaymentChallenge) {
          const challenge = await fetchFn(input, init);
          if (challenge.status !== 402) return challenge;
          client.policy?.(2, [{ network: "eip155:8453", amount: "1" }]);
          const payer = client.registrations.get("eip155:8453")?.signer.address ??
            client.registrations.get("eip155:84532")?.signer.address;
          if (payer) paidPayers.push(payer);
          const headers = new Headers(init?.headers);
          headers.set("PAYMENT-SIGNATURE", "fake-proof");
          return fetchFn(input, { ...init, headers });
        }
        client.policy?.(2, [{ network: "eip155:8453", amount: "1" }]);
        const payer = client.registrations.get("eip155:8453")?.signer.address ??
          client.registrations.get("eip155:84532")?.signer.address;
        const headers = new Headers(init?.headers);
        if (payer) {
          headers.set("x-test-payer", payer);
          paidPayers.push(payer);
        }
        return fetchFn(input, { ...init, headers });
      };
    },
    ExactEvmScheme: FakeScheme,
    toClientEvmSigner(rawSigner, publicClient) {
      const paymentSigner = rawSigner as EvmPaymentSigner;
      return {
        ...paymentSigner,
        readContract: paymentSigner.readContract ??
          ((args: unknown) => (publicClient as { readContract(args: unknown): Promise<bigint> }).readContract(args)),
      };
    },
  };
}

describe("createTrackedX402Fetch", () => {
  const attemptId = "pat_0123456789abcdef0123456789abcdef";

  it("marks an initial transport failure safe to retry with no mutation", async () => {
    const { store, records } = memoryStore();
    const fetchFn = createTrackedX402Fetch(
      (baseFetch) => baseFetch,
      {},
      {
        store,
        createAttemptId: () => attemptId,
        fetch: async () => {
          throw new TypeError("socket failed with secret-token");
        },
      },
    );

    await assert.rejects(fetchFn("https://paid.example/path?token=secret-token"), (err) => {
      assert.ok(err instanceof PaymentAttemptError);
      assert.equal(err.code, "X402_INITIAL_REQUEST_FAILED");
      assert.equal(err.phase, "initial_request");
      assert.equal(err.paymentAttemptId, attemptId);
      assert.equal(err.safeToRetry, true);
      assert.equal(err.mutationState, "not_started");
      assert.equal(records.size, 0, "no payment intent exists before a 402 challenge");
      const serialized = JSON.stringify(err);
      assert.doesNotMatch(serialized, /secret-token/);
      assert.doesNotMatch(serialized, /cause/);
      assert.match(serialized, /"type":"retry"/);
      return true;
    });
  });

  it("classifies signing failure before dispatch as safe and persists failure", async () => {
    const { store, records } = memoryStore();
    const fetchFn = createTrackedX402Fetch(
      (baseFetch) => async (input, init) => {
        await baseFetch(input, init);
        throw new TypeError("signer rejected secret-private-key");
      },
      {},
      {
        store,
        createAttemptId: () => attemptId,
        fetch: async () => new Response("payment required", { status: 402 }),
      },
    );

    await assert.rejects(fetchFn("https://paid.example/envelopes?auth=secret"), (err) => {
      assert.ok(err instanceof PaymentAttemptError);
      assert.equal(err.code, "X402_PAYMENT_SIGNING_FAILED");
      assert.equal(err.phase, "payment_signing");
      assert.equal(err.providerStarted, false);
      assert.equal(err.safeToRetry, true);
      assert.equal(err.mutationState, "not_started");
      return true;
    });
    assert.deepEqual(records.get(attemptId), {
      version: 1,
      payment_attempt_id: attemptId,
      rail: "x402",
      state: "failed",
      mutation_state: "not_started",
      method: "GET",
      origin: "https://paid.example",
      path: "/envelopes",
      created_at: records.get(attemptId)!.created_at,
      updated_at: records.get(attemptId)!.updated_at,
      last_error_code: "X402_PAYMENT_SIGNING_FAILED",
    });
    assert.doesNotMatch(JSON.stringify(records.get(attemptId)), /auth|private-key|secret/);
  });

  it("marks a post-dispatch transport failure ambiguous and never safe to retry", async () => {
    const { store, records } = memoryStore();
    let outboundCalls = 0;
    const fetchFn = createTrackedX402Fetch(
      (baseFetch) => async (input, init) => {
        await baseFetch(input, init);
        return baseFetch(input, {
          ...init,
          headers: { "PAYMENT-SIGNATURE": "replayable-secret-proof" },
        });
      },
      {},
      {
        store,
        createAttemptId: () => attemptId,
        fetch: async (_input, init) => {
          outboundCalls += 1;
          if (outboundCalls === 1) return new Response("payment required", { status: 402 });
          assert.equal(new Headers(init?.headers).get(PAYMENT_ATTEMPT_HEADER), attemptId);
          throw new TypeError("connection reset after write replayable-secret-proof");
        },
      },
    );

    await assert.rejects(fetchFn("https://paid.example/envelopes"), (err) => {
      assert.ok(err instanceof PaymentAttemptError);
      assert.equal(err.code, "X402_PAYMENT_OUTCOME_AMBIGUOUS");
      assert.equal(err.phase, "payment_submission");
      assert.equal(err.providerStarted, true);
      assert.equal(err.safeToRetry, false);
      assert.equal(err.retryable, false);
      assert.equal(err.mutationState, "ambiguous");
      const body = err.body as { next_actions: Array<{ type: string }> };
      assert.deepEqual(body.next_actions.map((action) => action.type), [
        "reconcile_payment",
        "poll",
      ]);
      assert.doesNotMatch(JSON.stringify(err), /replayable-secret-proof/);
      return true;
    });
    const record = records.get(attemptId)!;
    assert.equal(record.state, "ambiguous");
    assert.equal(record.mutation_state, "ambiguous");
    assert.equal(record.last_error_code, "X402_PAYMENT_OUTCOME_AMBIGUOUS");
    assert.ok(record.provider_started_at);
    assert.doesNotMatch(JSON.stringify(record), /PAYMENT-SIGNATURE|replayable|proof/);
  });

  it("persists completed state without payment headers or proofs", async () => {
    const { store, records } = memoryStore();
    const seenAttemptIds: string[] = [];
    let outboundCalls = 0;
    const fetchFn = createTrackedX402Fetch(
      (baseFetch) => async (input, init) => {
        await baseFetch(input, init);
        return baseFetch(input, {
          ...init,
          headers: { "X-PAYMENT": "signed-secret" },
        });
      },
      {},
      {
        store,
        createAttemptId: () => attemptId,
        now: () => "2026-07-15T12:00:00.000Z",
        fetch: async (_input, init) => {
          outboundCalls += 1;
          seenAttemptIds.push(new Headers(init?.headers).get(PAYMENT_ATTEMPT_HEADER) ?? "");
          return outboundCalls === 1
            ? new Response("payment required", { status: 402 })
            : new Response("created", { status: 201 });
        },
      },
    );

    const response = await fetchFn("https://paid.example/envelopes?key=do-not-store", {
      method: "POST",
      body: "private-document",
    });
    assert.equal(response.status, 201);
    assert.deepEqual(seenAttemptIds, ["", attemptId]);
    const record = records.get(attemptId)!;
    assert.equal(record.state, "completed");
    assert.equal(record.mutation_state, "completed");
    assert.equal(record.response_status, 201);
    assert.equal(record.created_at, "2026-07-15T12:00:00.000Z");
    assert.equal(record.updated_at, "2026-07-15T12:00:00.000Z");
    assert.equal(record.provider_started_at, "2026-07-15T12:00:00.000Z");
    const serialized = JSON.stringify(record);
    assert.doesNotMatch(serialized, /signed-secret|do-not-store|private-document|X-PAYMENT/);
  });

  it("accepts only canonical caller-supplied attempt ids and scopes the id to a non-redirecting paid call", async () => {
    const { store } = memoryStore();
    const generatedId = "pat_ffffffffffffffffffffffffffffffff";
    const calls: Array<{ attemptId: string | null; redirect?: RequestRedirect }> = [];
    let outboundCalls = 0;
    const fetchFn = createTrackedX402Fetch(
      (baseFetch) => async (input, init) => {
        await baseFetch(input, init);
        return baseFetch(input, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), "PAYMENT-SIGNATURE": "proof" },
        });
      },
      {},
      {
        store,
        createAttemptId: () => generatedId,
        fetch: async (_input, init) => {
          outboundCalls += 1;
          calls.push({
            attemptId: new Headers(init?.headers).get(PAYMENT_ATTEMPT_HEADER),
            redirect: init?.redirect,
          });
          return outboundCalls % 2 === 1
            ? new Response("payment required", { status: 402 })
            : new Response("ok");
        },
      },
    );

    const validId = "pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await fetchFn("https://paid.example/one", {
      headers: { [PAYMENT_ATTEMPT_HEADER]: validId },
    });
    await fetchFn("https://paid.example/two", {
      headers: { [PAYMENT_ATTEMPT_HEADER]: "invalid-attempt-id" },
    });

    assert.deepEqual(calls, [
      { attemptId: null, redirect: undefined },
      { attemptId: validId, redirect: "error" },
      { attemptId: null, redirect: undefined },
      { attemptId: generatedId, redirect: "error" },
    ]);
  });

  it("fails closed before provider dispatch when the durable intent cannot be written", async () => {
    let outboundCalls = 0;
    const store: PaymentAttemptStore = {
      write() {
        throw new Error("disk full");
      },
      read() {
        return null;
      },
    };
    const fetchFn = createTrackedX402Fetch(
      (baseFetch) => async (input, init) => {
        await baseFetch(input, init);
        return baseFetch(input, {
          ...init,
          headers: { "PAYMENT-SIGNATURE": "must-not-be-sent" },
        });
      },
      {},
      {
        store,
        createAttemptId: () => attemptId,
        fetch: async () => {
          outboundCalls += 1;
          return new Response("payment required", { status: 402 });
        },
      },
    );

    await assert.rejects(fetchFn("https://paid.example/envelopes"), (err) => {
      assert.ok(err instanceof PaymentAttemptError);
      assert.equal(err.code, "X402_ATTEMPT_JOURNAL_FAILED");
      assert.equal(err.safeToRetry, true);
      assert.equal(err.providerStarted, false);
      return true;
    });
    assert.equal(outboundCalls, 1, "only the unpriced challenge request was sent");
  });
});

describe("payment attempt file journal", () => {
  it("atomically persists only sanitized mode-0600 records", () => {
    const dir = join(tempDir, "attempt-journal");
    const store = createFilePaymentAttemptStore(dir);
    const id = "pat_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const record: PaymentAttemptRecord = {
      version: 1,
      payment_attempt_id: id,
      rail: "x402",
      state: "intent",
      mutation_state: "not_started",
      method: "POST",
      origin: "https://paid.example",
      path: "/envelopes",
      created_at: "2026-07-15T12:00:00.000Z",
      updated_at: "2026-07-15T12:00:00.000Z",
    };
    store.write(record);

    const path = join(dir, `${id}.json`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(store.read(id), record);
    const bytes = readFileSync(path, "utf8");
    assert.doesNotMatch(bytes, /header|query|body|private|signature|proof/i);
  });
});

function memoryStore(): {
  store: PaymentAttemptStore;
  records: Map<string, PaymentAttemptRecord>;
} {
  const records = new Map<string, PaymentAttemptRecord>();
  return {
    records,
    store: {
      write(record) {
        records.set(record.payment_attempt_id, structuredClone(record));
      },
      read(paymentAttemptId) {
        return records.get(paymentAttemptId) ?? null;
      },
    },
  };
}
