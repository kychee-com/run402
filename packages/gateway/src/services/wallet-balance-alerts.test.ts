import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockClient: any;
let mockGetBalance: (addr: string, chain: string) => Promise<bigint>;
let sentEmails: { to: string; walletId: string }[] = [];

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (...args: any[]) => mockClient.query(...args),
      connect: async () => mockClient,
    },
  },
});

mock.module("./contract-call-tx.js", {
  namedExports: {
    getNativeBalanceWei: (a: string, c: string) => mockGetBalance(a, c),
  },
});

mock.module("./platform-mail.js", {
  namedExports: {
    sendPlatformEmail: async (opts: { to: string; subject: string; html: string }) => {
      sentEmails.push({ to: opts.to, walletId: opts.subject });
    },
  },
});

const { checkLowBalances } = await import("./wallet-balance-alerts.js");

interface WalletRow {
  id: string;
  project_id: string;
  address: string;
  chain: string;
  low_balance_threshold_wei: string;
  last_alert_sent_at: Date | null;
  billing_email?: string;
}

function makeClient(wallets: WalletRow[]) {
  const queries: { text: string; params?: unknown[] }[] = [];
  return {
    queries,
    wallets,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (text: any, params?: unknown[]) => {
      const t = typeof text === "string" ? text : text?.text || String(text);
      queries.push({ text: t, params });
      if (/SELECT [\s\S]+ FROM internal\.contract_wallets[\s\S]+WHERE status = 'active'/i.test(t)) {
        return { rows: wallets };
      }
      if (/SELECT primary_contact_email FROM internal\.billing_accounts[\s\S]+JOIN/i.test(t)) {
        const projectId = (params as string[])[0];
        const w = wallets.find((x) => x.project_id === projectId);
        return { rows: w?.billing_email ? [{ primary_contact_email: w.billing_email }] : [] };
      }
      if (/UPDATE internal\.contract_wallets\s+SET last_alert_sent_at/is.test(t)) {
        const id = (params as string[])[0];
        const w = wallets.find((x) => x.id === id);
        if (w) w.last_alert_sent_at = new Date();
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
}

beforeEach(() => {
  sentEmails = [];
  mockGetBalance = async () => BigInt(0);
});

describe("checkLowBalances", () => {
  it("under threshold + cooldown ok → email sent", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", chain: "base-mainnet",
      low_balance_threshold_wei: "1000000000000000",
      last_alert_sent_at: null,
      billing_email: "owner@example.com",
    }]);
    mockGetBalance = async () => BigInt(1000); // way under
    await checkLowBalances();
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, "owner@example.com");
  });

  it("under threshold + recent alert (within 24h) → no email", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", chain: "base-mainnet",
      low_balance_threshold_wei: "1000000000000000",
      last_alert_sent_at: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
      billing_email: "owner@example.com",
    }]);
    mockGetBalance = async () => BigInt(1000);
    await checkLowBalances();
    assert.equal(sentEmails.length, 0);
  });

  it("over threshold → no email", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", chain: "base-mainnet",
      low_balance_threshold_wei: "1000",
      last_alert_sent_at: null,
      billing_email: "owner@example.com",
    }]);
    mockGetBalance = async () => BigInt(1_000_000_000);
    await checkLowBalances();
    assert.equal(sentEmails.length, 0);
  });

  it("no billing email → silent (no email, no error)", async () => {
    mockClient = makeClient([{
      id: "w1", project_id: "p1", address: "0xaaa", chain: "base-mainnet",
      low_balance_threshold_wei: "1000000000000000",
      last_alert_sent_at: null,
      billing_email: undefined,
    }]);
    mockGetBalance = async () => BigInt(0);
    await checkLowBalances();
    assert.equal(sentEmails.length, 0);
  });
});
