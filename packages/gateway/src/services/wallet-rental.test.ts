import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---- Mock pool --------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockClient: any;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (...args: any[]) => mockClient.query(...args),
      connect: async () => mockClient,
    },
  },
});

mock.module("../utils/async-handler.js", {
  namedExports: {
    HttpError: class HttpError extends Error {
      public statusCode: number;
      constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
      }
    },
  },
});

const { debitDailyRent, reactivateProject } = await import("./wallet-rental.js");

// ---- Mock client builder ----------------------------------------------

interface CapturedQuery { text: string; params?: unknown[] }

interface MockState {
  walletsToProcess: Array<{ id: string; project_id: string; available_usd_micros: string }>;
  suspendedWallets: Array<{ id: string; project_id: string }>;
}

function makeClient(state: MockState) {
  const queries: CapturedQuery[] = [];
  // Per-project debit tracking so the same project doesn't get double-debited.
  const debitedWalletIds = new Set<string>();
  return {
    queries,
    debitedWalletIds,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (text: any, params?: unknown[]) => {
      const t = typeof text === "string" ? text : text?.text || String(text);
      queries.push({ text: t, params });
      if (/BEGIN|COMMIT|ROLLBACK/.test(t)) return { rows: [] };
      if (/SELECT .* FROM internal\.contract_wallets\s+WHERE status = 'active'/is.test(t)) {
        return {
          rows: state.walletsToProcess
            .filter((w) => !debitedWalletIds.has(w.id))
            .map((w) => ({ id: w.id, project_id: w.project_id })),
        };
      }
      if (/SELECT ba\.\* FROM internal\.billing_accounts ba/is.test(t)) {
        const projectId = (params as string[])[0];
        const w = state.walletsToProcess.find((x) => x.project_id === projectId);
        if (!w) return { rows: [] };
        return {
          rows: [{
            id: `ba_for_${projectId}`,
            available_usd_micros: w.available_usd_micros,
            held_usd_micros: "0",
          }],
        };
      }
      if (/UPDATE internal\.billing_accounts SET available_usd_micros/i.test(t)) {
        return { rows: [] };
      }
      if (/INSERT INTO internal\.allowance_ledger/i.test(t)) {
        return { rows: [] };
      }
      if (/UPDATE internal\.contract_wallets\s+SET last_rent_debited_on/is.test(t)) {
        const walletId = (params as string[])[0];
        debitedWalletIds.add(walletId);
        return { rows: [] };
      }
      if (/UPDATE internal\.contract_wallets\s+SET status = 'suspended'/is.test(t)) {
        const projectId = (params as string[])[0];
        for (const w of state.walletsToProcess.filter((x) => x.project_id === projectId)) {
          state.suspendedWallets.push({ id: w.id, project_id: projectId });
          debitedWalletIds.add(w.id);
        }
        return { rows: [] };
      }
      if (/SELECT .* FROM internal\.contract_wallets WHERE project_id = \$1 AND status = 'suspended'/is.test(t)) {
        const projectId = (params as string[])[0];
        return { rows: state.suspendedWallets.filter((w) => w.project_id === projectId).map((w) => ({ id: w.id })) };
      }
      if (/UPDATE internal\.contract_wallets\s+SET status = 'active'.*WHERE project_id = \$1 AND status = 'suspended'/is.test(t)) {
        const projectId = (params as string[])[0];
        state.suspendedWallets = state.suspendedWallets.filter((w) => w.project_id !== projectId);
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
}

// ---- debitDailyRent ----------------------------------------------------

describe("debitDailyRent", () => {
  it("happy path: debits one day per wallet, sets last_rent_debited_on", async () => {
    const state: MockState = {
      walletsToProcess: [
        { id: "w1", project_id: "p1", available_usd_micros: "5000000" },
      ],
      suspendedWallets: [],
    };
    mockClient = makeClient(state);
    const result = await debitDailyRent();
    assert.equal(result.debited.length, 1);
    assert.equal(result.suspended.length, 0);
    const all = mockClient.queries.map((q: CapturedQuery) => q.text).join("\n");
    assert.match(all, /INSERT INTO internal\.allowance_ledger[\s\S]*kms_wallet_rental/);
    assert.match(all, /UPDATE internal\.contract_wallets[\s\S]*SET last_rent_debited_on/);
  });

  it("idempotent re-run: second pass debits nothing more", async () => {
    const state: MockState = {
      walletsToProcess: [
        { id: "w1", project_id: "p1", available_usd_micros: "5000000" },
      ],
      suspendedWallets: [],
    };
    mockClient = makeClient(state);
    await debitDailyRent();
    const second = await debitDailyRent();
    assert.equal(second.debited.length, 0);
    assert.equal(second.suspended.length, 0);
  });

  it("insufficient balance: suspends ALL wallets on the project", async () => {
    const state: MockState = {
      walletsToProcess: [
        { id: "w1", project_id: "p1", available_usd_micros: "10000" }, // < 40000
        { id: "w2", project_id: "p1", available_usd_micros: "10000" },
      ],
      suspendedWallets: [],
    };
    mockClient = makeClient(state);
    const result = await debitDailyRent();
    assert.equal(result.suspended.length, 1); // 1 project suspended
    assert.equal(result.suspended[0], "p1");
    assert.equal(state.suspendedWallets.length, 2);
  });

  it("never takes balance below zero (debit skipped if insufficient)", async () => {
    const state: MockState = {
      walletsToProcess: [
        { id: "w1", project_id: "p1", available_usd_micros: "30000" }, // < 40000
      ],
      suspendedWallets: [],
    };
    mockClient = makeClient(state);
    await debitDailyRent();
    const all = mockClient.queries.map((q: CapturedQuery) => q.text).join("\n");
    assert.doesNotMatch(all, /INSERT INTO internal\.allowance_ledger[\s\S]*kms_wallet_rental/);
  });

  it("partial-day catch-up: processes multiple wallets across projects independently", async () => {
    const state: MockState = {
      walletsToProcess: [
        { id: "w1", project_id: "p1", available_usd_micros: "5000000" },
        { id: "w2", project_id: "p2", available_usd_micros: "5000000" },
        { id: "w3", project_id: "p3", available_usd_micros: "100" }, // suspends
      ],
      suspendedWallets: [],
    };
    mockClient = makeClient(state);
    const result = await debitDailyRent();
    assert.equal(result.debited.length, 2);
    assert.equal(result.suspended.length, 1);
    assert.deepEqual(result.suspended.sort(), ["p3"]);
  });
});

// ---- reactivateProject -------------------------------------------------

describe("reactivateProject", () => {
  it("transitions all suspended wallets back to active and debits one day", async () => {
    const state: MockState = {
      walletsToProcess: [],
      suspendedWallets: [
        { id: "w1", project_id: "p1" },
        { id: "w2", project_id: "p1" },
      ],
    };
    mockClient = makeClient(state);
    // The reactivate path needs the billing account row, which the mock
    // returns based on walletsToProcess — patch the state so the reactivate
    // SQL finds a non-empty billing account.
    state.walletsToProcess.push({ id: "w1", project_id: "p1", available_usd_micros: "5000000" });
    const result = await reactivateProject("p1");
    assert.equal(result.reactivated_count, 2);
    assert.equal(state.suspendedWallets.length, 0);
  });

  it("no-op when project has no suspended wallets", async () => {
    mockClient = makeClient({ walletsToProcess: [], suspendedWallets: [] });
    const result = await reactivateProject("p_none");
    assert.equal(result.reactivated_count, 0);
  });
});
