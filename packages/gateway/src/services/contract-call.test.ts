import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---- Mocks --------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockClient: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSignDigest: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetWallet: (id: string, projectId: string) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockBuildTx: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockBroadcast: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetNativeBalance: (addr: string, chain: string) => Promise<bigint>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (...args: any[]) => mockClient.query(...args),
      connect: async () => mockClient,
    },
  },
});

mock.module("./kms-wallet.js", {
  namedExports: {
    signDigest: (...args: unknown[]) => mockSignDigest(...args),
  },
});

mock.module("./contract-wallets.js", {
  namedExports: {
    getWallet: (id: string, projectId: string) => mockGetWallet(id, projectId),
  },
});

mock.module("./contract-call-tx.js", {
  namedExports: {
    buildSignedTransaction: (...args: unknown[]) => mockBuildTx(...args),
    broadcastSignedTransaction: (...args: unknown[]) => mockBroadcast(...args),
    getNativeBalanceWei: (addr: string, chain: string) => mockGetNativeBalance(addr, chain),
  },
});

mock.module("../utils/async-handler.js", {
  namedExports: {
    HttpError: class extends Error {
      public statusCode: number;
      public body?: Record<string, unknown>;
      constructor(statusCode: number, message: string, body?: Record<string, unknown>) {
        super(message);
        this.statusCode = statusCode;
        this.body = body;
      }
    },
  },
});

const { submitContractCall, submitDrainCall } = await import("./contract-call.js");

// ---- Helpers ------------------------------------------------------------

const TEST_ADDR = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TEST_TARGET = "0x1111111111111111111111111111111111111111";
const SIMPLE_ABI = [
  { type: "function", name: "ping", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

interface MockOpts {
  walletStatus?: "active" | "suspended" | "deleted" | "missing";
  balanceWei?: bigint;
  duplicateIdempotency?: string;
}

function makeClient(opts: MockOpts = {}) {
  const queries: { text: string; params?: unknown[] }[] = [];
  return {
    queries,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (text: any, params?: unknown[]) => {
      const t = typeof text === "string" ? text : text?.text || String(text);
      queries.push({ text: t, params });
      if (/SELECT id, tx_hash, status FROM internal\.contract_calls/i.test(t)) {
        if (opts.duplicateIdempotency) {
          return { rows: [{ id: opts.duplicateIdempotency, tx_hash: "0xexisting", status: "pending" }] };
        }
        return { rows: [] };
      }
      if (/INSERT INTO internal\.contract_calls/i.test(t)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
}

beforeEach(() => {
  mockClient = makeClient({});
  mockGetWallet = async () => ({
    id: "w1", project_id: "p1", chain: "base-mainnet",
    address: TEST_ADDR, status: "active", kms_key_id: "k1",
    recovery_address: null, low_balance_threshold_wei: BigInt(0),
    last_alert_sent_at: null, last_rent_debited_on: null,
    suspended_at: null, deleted_at: null, last_warning_day: null,
    created_at: new Date(),
  });
  mockSignDigest = async () => ({ r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32), v: 27 });
  mockGetNativeBalance = async () => BigInt(10) ** BigInt(18); // 1 ETH
  mockBuildTx = async () => ({
    digest32: new Uint8Array(32),
    serializedSigned: "0xdeadbeef",
    estimatedGasCostWei: BigInt(21000) * BigInt(1_000_000_000),
    nonce: 0,
  });
  mockBroadcast = async () => ({ tx_hash: "0xnewtx" });
});

// ---- submitContractCall -------------------------------------------------

describe("submitContractCall", () => {
  it("happy path: validates, signs, broadcasts, persists call row", async () => {
    const result = await submitContractCall({
      projectId: "p1",
      walletId: "w1",
      chain: "base-mainnet",
      contractAddress: TEST_TARGET,
      abiFragment: SIMPLE_ABI,
      functionName: "ping",
      args: [],
    });
    assert.match(result.call_id, /^ccall_/);
    assert.equal(result.tx_hash, "0xnewtx");
    assert.equal(result.status, "pending");
    const all = mockClient.queries.map((q: { text: string }) => q.text).join("\n");
    assert.match(all, /INSERT INTO internal\.contract_calls/);
  });

  it("ABI parse failure → 400", async () => {
    await assert.rejects(
      () => submitContractCall({
        projectId: "p1", walletId: "w1", chain: "base-mainnet",
        contractAddress: TEST_TARGET,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        abiFragment: "not-an-abi" as any,
        functionName: "ping", args: [],
      }),
      /invalid_abi/,
    );
  });

  it("function not in ABI → 400", async () => {
    await assert.rejects(
      () => submitContractCall({
        projectId: "p1", walletId: "w1", chain: "base-mainnet",
        contractAddress: TEST_TARGET,
        abiFragment: SIMPLE_ABI,
        functionName: "missingFn", args: [],
      }),
      /invalid_abi/,
    );
  });

  it("insufficient native balance → 402, no broadcast", async () => {
    mockGetNativeBalance = async () => BigInt(0);
    let broadcasted = false;
    mockBroadcast = async () => { broadcasted = true; return { tx_hash: "0x" }; };
    await assert.rejects(
      () => submitContractCall({
        projectId: "p1", walletId: "w1", chain: "base-mainnet",
        contractAddress: TEST_TARGET, abiFragment: SIMPLE_ABI,
        functionName: "ping", args: [],
      }),
      /insufficient_native_balance/,
    );
    assert.equal(broadcasted, false);
  });

  it("suspended wallet → 402, no broadcast", async () => {
    mockGetWallet = async () => ({
      id: "w1", project_id: "p1", chain: "base-mainnet", address: TEST_ADDR,
      status: "suspended", kms_key_id: "k1", recovery_address: null,
      low_balance_threshold_wei: BigInt(0), last_alert_sent_at: null,
      last_rent_debited_on: null, suspended_at: new Date(), deleted_at: null,
      last_warning_day: null, created_at: new Date(),
    });
    let broadcasted = false;
    mockBroadcast = async () => { broadcasted = true; return { tx_hash: "0x" }; };
    await assert.rejects(
      () => submitContractCall({
        projectId: "p1", walletId: "w1", chain: "base-mainnet",
        contractAddress: TEST_TARGET, abiFragment: SIMPLE_ABI,
        functionName: "ping", args: [],
      }),
      /wallet_suspended/,
    );
    assert.equal(broadcasted, false);
  });

  it("deleted wallet → 410", async () => {
    mockGetWallet = async () => ({
      id: "w1", project_id: "p1", chain: "base-mainnet", address: TEST_ADDR,
      status: "deleted", kms_key_id: null, recovery_address: null,
      low_balance_threshold_wei: BigInt(0), last_alert_sent_at: null,
      last_rent_debited_on: null, suspended_at: null,
      deleted_at: new Date(), last_warning_day: null, created_at: new Date(),
    });
    await assert.rejects(
      () => submitContractCall({
        projectId: "p1", walletId: "w1", chain: "base-mainnet",
        contractAddress: TEST_TARGET, abiFragment: SIMPLE_ABI,
        functionName: "ping", args: [],
      }),
      /wallet_deleted/,
    );
  });

  it("idempotency: same key → returns existing call_id, no second broadcast", async () => {
    mockClient = makeClient({ duplicateIdempotency: "ccall_existing" });
    let broadcasted = false;
    mockBroadcast = async () => { broadcasted = true; return { tx_hash: "0x" }; };
    const result = await submitContractCall({
      projectId: "p1", walletId: "w1", chain: "base-mainnet",
      contractAddress: TEST_TARGET, abiFragment: SIMPLE_ABI,
      functionName: "ping", args: [],
      idempotencyKey: "abc",
    });
    assert.equal(result.call_id, "ccall_existing");
    assert.equal(broadcasted, false);
  });

  it("RPC submit failure → status='failed', no gas charge", async () => {
    mockBroadcast = async () => { throw new Error("RPC_REJECTED nonce too low"); };
    await assert.rejects(
      () => submitContractCall({
        projectId: "p1", walletId: "w1", chain: "base-mainnet",
        contractAddress: TEST_TARGET, abiFragment: SIMPLE_ABI,
        functionName: "ping", args: [],
      }),
      /RPC_REJECTED|broadcast_failed/,
    );
    const all = mockClient.queries.map((q: { text: string }) => q.text).join("\n");
    // Should still record the call as failed
    assert.match(all, /INSERT INTO internal\.contract_calls/);
  });
});

// ---- submitDrainCall ----------------------------------------------------

describe("submitDrainCall", () => {
  it("active wallet drain: signs and broadcasts a value-transfer tx", async () => {
    const result = await submitDrainCall({
      projectId: "p1",
      walletId: "w1",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    assert.match(result.call_id, /^ccall_/);
    assert.equal(result.tx_hash, "0xnewtx");
  });

  it("suspended wallet drain works (the safety valve)", async () => {
    mockGetWallet = async () => ({
      id: "w1", project_id: "p1", chain: "base-mainnet", address: TEST_ADDR,
      status: "suspended", kms_key_id: "k1", recovery_address: null,
      low_balance_threshold_wei: BigInt(0), last_alert_sent_at: null,
      last_rent_debited_on: null, suspended_at: new Date(),
      deleted_at: null, last_warning_day: null, created_at: new Date(),
    });
    const result = await submitDrainCall({
      projectId: "p1", walletId: "w1",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    assert.equal(result.tx_hash, "0xnewtx");
  });

  it("deleted wallet drain → 410", async () => {
    mockGetWallet = async () => ({
      id: "w1", project_id: "p1", chain: "base-mainnet", address: TEST_ADDR,
      status: "deleted", kms_key_id: null, recovery_address: null,
      low_balance_threshold_wei: BigInt(0), last_alert_sent_at: null,
      last_rent_debited_on: null, suspended_at: null, deleted_at: new Date(),
      last_warning_day: null, created_at: new Date(),
    });
    await assert.rejects(
      () => submitDrainCall({
        projectId: "p1", walletId: "w1",
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      }),
      /wallet_deleted/,
    );
  });

  it("nothing to drain → 409", async () => {
    mockGetNativeBalance = async () => BigInt(100); // < dust
    await assert.rejects(
      () => submitDrainCall({
        projectId: "p1", walletId: "w1",
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      }),
      /nothing_to_drain/,
    );
  });

  it("invalid destination address → 400", async () => {
    await assert.rejects(
      () => submitDrainCall({
        projectId: "p1", walletId: "w1",
        destinationAddress: "not-an-address",
      }),
      /invalid_destination_address/,
    );
  });

  // Regression for kms-drain-gas-margin-fix: under EIP-1559, the base fee can
  // tick up between the placeholder-value build and the final drain build, so
  // the reserved `gas * firstMaxFeePerGas` undershoots the ACTUAL cost of the
  // second broadcast. Fix: reserve a 20% safety margin when computing the
  // drain value.
  it("reserves a 20% gas-cost safety margin so EIP-1559 fee bumps don't revert", async () => {
    const balance = BigInt(1_000_000_000_000_000); // 0.001 ETH
    const firstGasCostWei = BigInt(21_000) * BigInt(1_000_000_000); // 21k × 1 gwei = 21_000_000_000_000
    mockGetNativeBalance = async () => balance;
    const buildCalls: Array<{ valueWei: bigint }> = [];
    mockBuildTx = async (input: { valueWei: bigint }) => {
      buildCalls.push({ valueWei: input.valueWei });
      return {
        digest32: new Uint8Array(32),
        serializedSigned: "0xdeadbeef",
        estimatedGasCostWei: firstGasCostWei,
        nonce: 0,
      };
    };
    const result = await submitDrainCall({
      projectId: "p1", walletId: "w1",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    assert.equal(result.tx_hash, "0xnewtx");
    // The SECOND build (the real drain) must reserve 20% above raw gas cost.
    const expectedReservation = (firstGasCostWei * BigInt(120)) / BigInt(100);
    const secondValue = buildCalls[1]!.valueWei;
    assert.equal(
      secondValue,
      balance - expectedReservation,
      `drain value should be balance - 1.2*gasCost (${balance - expectedReservation}), got ${secondValue}`,
    );
  });

  it("nothing_to_drain when balance < 1.2×gasCost (post-margin guard)", async () => {
    const balance = BigInt(20_000) * BigInt(1_000_000_000); // 20k gas × 1 gwei = less than 1.2 × 21k gwei
    mockGetNativeBalance = async () => balance * BigInt(1); // keep > DUST so we pass the initial dust gate
    // Force DUST gate pass but post-margin drainValue < 0.
    // DUST_WEI = 1000; balance 20_000 gwei = 20e12 wei > 1000 wei ✓
    const firstGasCostWei = BigInt(21_000) * BigInt(1_000_000_000); // 21k gwei
    mockBuildTx = async () => ({
      digest32: new Uint8Array(32),
      serializedSigned: "0xdeadbeef",
      estimatedGasCostWei: firstGasCostWei,
      nonce: 0,
    });
    mockGetNativeBalance = async () => firstGasCostWei; // exactly equal to raw gas; post-margin goes negative
    await assert.rejects(
      () => submitDrainCall({
        projectId: "p1", walletId: "w1",
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      }),
      /nothing_to_drain/,
    );
  });
});
