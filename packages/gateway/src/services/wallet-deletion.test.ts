import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

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
    HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } },
  },
});

const { processSuspensionGrace, DUST_WEI } = await import("./wallet-deletion.js");

// ---- Mock builders ----------------------------------------------------

interface SuspendedWallet {
  id: string;
  project_id: string;
  address: string;
  kms_key_id: string;
  recovery_address: string | null;
  suspended_at: Date;
  last_warning_day: number | null;
  balance_wei?: bigint;
  drain_call_status?: "pending" | "confirmed" | "failed";
}

function makeClient(wallets: SuspendedWallet[]) {
  const queries: { text: string; params?: unknown[] }[] = [];
  return {
    queries,
    wallets,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (text: any, params?: unknown[]) => {
      const t = typeof text === "string" ? text : text?.text || String(text);
      queries.push({ text: t, params });
      if (/SELECT [\s\S]+FROM internal\.contract_wallets[\s\S]+WHERE status = 'suspended'/i.test(t)) {
        return { rows: wallets.map((w) => ({
          id: w.id,
          project_id: w.project_id,
          address: w.address,
          kms_key_id: w.kms_key_id,
          recovery_address: w.recovery_address,
          suspended_at: w.suspended_at,
          last_warning_day: w.last_warning_day,
        })) };
      }
      if (/UPDATE internal\.contract_wallets\s+SET last_warning_day/is.test(t)) {
        const id = (params as unknown[])[1] as string;
        const day = (params as unknown[])[0] as number;
        const w = wallets.find((x) => x.id === id);
        if (w) w.last_warning_day = day;
        return { rows: [] };
      }
      if (/UPDATE internal\.contract_wallets\s+SET status = 'deleted'/is.test(t)) {
        const id = (params as unknown[])[0] as string;
        const w = wallets.find((x) => x.id === id);
        if (w) w.kms_key_id = "<cleared>";
        return { rows: [] };
      }
      if (/SELECT id, status FROM internal\.contract_calls[\s\S]+WHERE wallet_id = \$1[\s\S]+function_name = '<auto_drain_pre_deletion>'/i.test(t)) {
        const id = (params as unknown[])[0] as string;
        const w = wallets.find((x) => x.id === id);
        if (!w || !w.drain_call_status) return { rows: [] };
        return { rows: [{ id: `call_${id}`, status: w.drain_call_status }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
}

// ---- Mock injectable deps ---------------------------------------------

let getBalanceCalls: string[] = [];
async function mockGetBalance(addr: string): Promise<bigint> {
  getBalanceCalls.push(addr);
  const w = (mockClient as { wallets: SuspendedWallet[] }).wallets.find((x) => x.address === addr);
  return w?.balance_wei ?? BigInt(0);
}

let scheduledDeletionKeys: string[] = [];
async function mockScheduleDeletion(keyId: string): Promise<void> {
  scheduledDeletionKeys.push(keyId);
}

let drainCalls: { walletId: string; destination: string }[] = [];
async function mockSubmitDrain(walletId: string, destination: string): Promise<{ call_id: string; tx_hash: string }> {
  drainCalls.push({ walletId, destination });
  return { call_id: `drain_${walletId}`, tx_hash: "0xdraintx" };
}

let warnEmails: { walletId: string; daysLeft: number }[] = [];
async function mockSendWarning(walletId: string, daysLeft: number): Promise<void> {
  warnEmails.push({ walletId, daysLeft });
}
let fundLossEmails: string[] = [];
async function mockSendFundLoss(walletId: string): Promise<void> {
  fundLossEmails.push(walletId);
}
let drainConfirmEmails: string[] = [];
async function mockSendDrainConfirm(walletId: string): Promise<void> {
  drainConfirmEmails.push(walletId);
}

beforeEach(() => {
  getBalanceCalls = [];
  scheduledDeletionKeys = [];
  drainCalls = [];
  warnEmails = [];
  fundLossEmails = [];
  drainConfirmEmails = [];
});

const deps = {
  getBalanceWei: mockGetBalance,
  scheduleKmsKeyDeletion: mockScheduleDeletion,
  submitDrainCall: mockSubmitDrain,
  sendWarningEmail: mockSendWarning,
  sendFundLossEmail: mockSendFundLoss,
  sendDrainConfirmEmail: mockSendDrainConfirm,
};

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ---- Tests ------------------------------------------------------------

describe("processSuspensionGrace", () => {
  it("day 90 with dust balance: schedule deletion immediately", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", kms_key_id: "k1",
      recovery_address: null, suspended_at: daysAgo(91),
      last_warning_day: 88, balance_wei: BigInt(100), // < dust
    }]);
    await processSuspensionGrace(deps);
    assert.deepEqual(scheduledDeletionKeys, ["k1"]);
    assert.equal(drainCalls.length, 0);
    assert.equal(fundLossEmails.length, 0);
  });

  it("day 90 with balance + recovery_address: submits drain, defers deletion until confirmed", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", kms_key_id: "k1",
      recovery_address: "0xbbb", suspended_at: daysAgo(91),
      last_warning_day: 88, balance_wei: BigInt(10) ** BigInt(15),
    }]);
    await processSuspensionGrace(deps);
    assert.deepEqual(drainCalls, [{ walletId: "w1", destination: "0xbbb" }]);
    // Deletion not yet — drain still pending
    assert.equal(scheduledDeletionKeys.length, 0);
  });

  it("drain confirms on next tick → schedule deletion", async () => {
    const wallets: SuspendedWallet[] = [{
      id: "w1", project_id: "p1", address: "0xaaa", kms_key_id: "k1",
      recovery_address: "0xbbb", suspended_at: daysAgo(91),
      last_warning_day: 88, balance_wei: BigInt(10) ** BigInt(15),
    }];
    mockClient = makeClient(wallets);
    await processSuspensionGrace(deps); // tick 1: submits drain
    assert.equal(drainCalls.length, 1);
    // Mark drain as confirmed for next tick
    wallets[0].drain_call_status = "confirmed";
    wallets[0].balance_wei = BigInt(0);
    await processSuspensionGrace(deps); // tick 2
    assert.deepEqual(scheduledDeletionKeys, ["k1"]);
    assert.deepEqual(drainConfirmEmails, ["w1"]);
  });

  it("day 90 with balance + NO recovery_address: deletes anyway, sends fund-loss email", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", kms_key_id: "k1",
      recovery_address: null, suspended_at: daysAgo(91),
      last_warning_day: 88, balance_wei: BigInt(10) ** BigInt(15),
    }]);
    await processSuspensionGrace(deps);
    assert.deepEqual(scheduledDeletionKeys, ["k1"]);
    assert.deepEqual(fundLossEmails, ["w1"]);
    assert.equal(drainCalls.length, 0);
  });

  it("day 60 warning (and only once)", async () => {
    const wallets: SuspendedWallet[] = [{
      id: "w1", project_id: "p1", address: "0xaaa", kms_key_id: "k1",
      recovery_address: null, suspended_at: daysAgo(60),
      last_warning_day: null, balance_wei: BigInt(10) ** BigInt(15),
    }];
    mockClient = makeClient(wallets);
    await processSuspensionGrace(deps);
    assert.equal(warnEmails.length, 1);
    assert.equal(warnEmails[0].daysLeft, 30);
    // Re-running same tick should NOT send another email (last_warning_day=60 now)
    await processSuspensionGrace(deps);
    assert.equal(warnEmails.length, 1);
  });

  it("day 75 warning (15 days left)", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", kms_key_id: "k1",
      recovery_address: null, suspended_at: daysAgo(75),
      last_warning_day: 60, balance_wei: BigInt(10) ** BigInt(15),
    }]);
    await processSuspensionGrace(deps);
    assert.equal(warnEmails.length, 1);
    assert.equal(warnEmails[0].daysLeft, 15);
  });

  it("day 88 warning (2 days left)", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", kms_key_id: "k1",
      recovery_address: null, suspended_at: daysAgo(88),
      last_warning_day: 75, balance_wei: BigInt(10) ** BigInt(15),
    }]);
    await processSuspensionGrace(deps);
    assert.equal(warnEmails.length, 1);
    assert.equal(warnEmails[0].daysLeft, 2);
  });

  it("does not warn or delete wallets younger than 60 days", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", kms_key_id: "k1",
      recovery_address: null, suspended_at: daysAgo(30),
      last_warning_day: null, balance_wei: BigInt(10) ** BigInt(15),
    }]);
    await processSuspensionGrace(deps);
    assert.equal(warnEmails.length, 0);
    assert.equal(scheduledDeletionKeys.length, 0);
  });

  it("DUST_WEI exported and >0", () => {
    assert.ok(DUST_WEI > BigInt(0));
  });
});
