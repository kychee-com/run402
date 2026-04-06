import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockClient: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetReceipt: (txHash: string, chain: string) => Promise<any>;
let mockGetEthUsdPrice: (chain: string) => Promise<number>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (...args: any[]) => mockClient.query(...args),
      connect: async () => mockClient,
    },
  },
});

mock.module("./contract-call-rpc.js", {
  namedExports: {
    getTransactionReceipt: (h: string, c: string) => mockGetReceipt(h, c),
  },
});

mock.module("./eth-usd-price.js", {
  namedExports: {
    getCachedEthUsdPrice: (chain: string) => mockGetEthUsdPrice(chain),
  },
});

const { reconcilePendingCalls } = await import("./contract-call-reconciler.js");

interface PendingCall {
  id: string;
  wallet_id: string;
  project_id: string;
  chain: string;
  tx_hash: string;
  status: "pending" | "confirmed" | "failed";
  billing_account_id: string;
}

function makeClient(calls: PendingCall[]) {
  const queries: { text: string; params?: unknown[] }[] = [];
  return {
    queries,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (text: any, params?: unknown[]) => {
      const t = typeof text === "string" ? text : text?.text || String(text);
      queries.push({ text: t, params });
      if (/SELECT [\s\S]+ FROM internal\.contract_calls[\s\S]+WHERE status = 'pending'/i.test(t)) {
        return { rows: calls.filter((c) => c.status === "pending") };
      }
      if (/SELECT ba\.id FROM internal\.billing_accounts ba/i.test(t)) {
        const projectId = (params as string[])[0];
        const c = calls.find((x) => x.project_id === projectId);
        return { rows: c ? [{ id: c.billing_account_id }] : [] };
      }
      if (/UPDATE internal\.contract_calls\s+SET status/is.test(t)) {
        const id = (params as unknown[])[(params as unknown[]).length - 1] as string;
        const newStatus = (params as unknown[])[0] as "confirmed" | "failed";
        const c = calls.find((x) => x.id === id);
        if (c) c.status = newStatus;
        return { rows: [] };
      }
      if (/INSERT INTO internal\.allowance_ledger/i.test(t)) {
        return { rows: [] };
      }
      if (/UPDATE internal\.billing_accounts/i.test(t)) {
        return { rows: [] };
      }
      if (/SELECT \* FROM internal\.billing_accounts WHERE id = \$1 FOR UPDATE/i.test(t)) {
        return { rows: [{ id: "ba_1", available_usd_micros: "1000000000", held_usd_micros: "0" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
}

beforeEach(() => {
  mockGetEthUsdPrice = async () => 2000;
});

describe("reconcilePendingCalls", () => {
  it("confirmed call: writes both ledger entries (gas + sign fee)", async () => {
    const calls: PendingCall[] = [
      { id: "c1", wallet_id: "w1", project_id: "p1", chain: "base-mainnet", tx_hash: "0xab", status: "pending", billing_account_id: "ba_1" },
    ];
    mockClient = makeClient(calls);
    mockGetReceipt = async () => ({
      status: "success",
      blockNumber: BigInt(123),
      gasUsed: BigInt(50000),
      effectiveGasPrice: BigInt(1_000_000_000), // 1 gwei
    });

    await reconcilePendingCalls();

    const all = mockClient.queries.map((q: { text: string }) => q.text).join("\n");
    assert.match(all, /INSERT INTO internal\.allowance_ledger[\s\S]*contract_call_gas/);
    assert.match(all, /INSERT INTO internal\.allowance_ledger[\s\S]*kms_sign_fee/);
    assert.equal(calls[0].status, "confirmed");
  });

  it("failed (reverted) call: still writes both ledger entries", async () => {
    const calls: PendingCall[] = [
      { id: "c1", wallet_id: "w1", project_id: "p1", chain: "base-mainnet", tx_hash: "0xab", status: "pending", billing_account_id: "ba_1" },
    ];
    mockClient = makeClient(calls);
    mockGetReceipt = async () => ({
      status: "reverted",
      blockNumber: BigInt(123),
      gasUsed: BigInt(50000),
      effectiveGasPrice: BigInt(1_000_000_000),
    });

    await reconcilePendingCalls();
    const all = mockClient.queries.map((q: { text: string }) => q.text).join("\n");
    assert.match(all, /contract_call_gas/);
    assert.match(all, /kms_sign_fee/);
    assert.equal(calls[0].status, "failed");
  });

  it("pending (no receipt yet): no DB changes", async () => {
    const calls: PendingCall[] = [
      { id: "c1", wallet_id: "w1", project_id: "p1", chain: "base-mainnet", tx_hash: "0xab", status: "pending", billing_account_id: "ba_1" },
    ];
    mockClient = makeClient(calls);
    mockGetReceipt = async () => null;

    await reconcilePendingCalls();
    const all = mockClient.queries.map((q: { text: string }) => q.text).join("\n");
    assert.doesNotMatch(all, /contract_call_gas/);
    assert.equal(calls[0].status, "pending");
  });

  it("receipt fetch error: no change, no throw (retried next tick)", async () => {
    const calls: PendingCall[] = [
      { id: "c1", wallet_id: "w1", project_id: "p1", chain: "base-mainnet", tx_hash: "0xab", status: "pending", billing_account_id: "ba_1" },
    ];
    mockClient = makeClient(calls);
    mockGetReceipt = async () => { throw new Error("RPC down"); };
    await reconcilePendingCalls();
    assert.equal(calls[0].status, "pending");
  });

  it("idempotent: re-reconciling an already-confirmed call is a no-op", async () => {
    const calls: PendingCall[] = [
      { id: "c1", wallet_id: "w1", project_id: "p1", chain: "base-mainnet", tx_hash: "0xab", status: "confirmed", billing_account_id: "ba_1" },
    ];
    mockClient = makeClient(calls);
    mockGetReceipt = async () => ({ status: "success", blockNumber: BigInt(123), gasUsed: BigInt(50000), effectiveGasPrice: BigInt(1_000_000_000) });
    await reconcilePendingCalls();
    const all = mockClient.queries.map((q: { text: string }) => q.text).join("\n");
    assert.doesNotMatch(all, /contract_call_gas/);
  });
});
