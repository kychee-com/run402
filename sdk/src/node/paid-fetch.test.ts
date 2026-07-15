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
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveAllowance } from "../../../core/src/allowance.js";
import type { AllowanceData, CredentialsProvider } from "../credentials.js";
import { LocalError } from "../errors.js";
import type { X402Stack } from "./_paid-stack.js";
import { run402 } from "./index.js";
import {
  _setPaidStackLoadersForTest,
  __paidFetchInternals,
  checkBalanceAcrossProviders,
  createLazyPaidFetch,
  filterAffordableRequirements,
  setupPaidFetch,
  X402BalanceError,
  type EvmPaymentSigner,
} from "./paid-fetch.js";
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
