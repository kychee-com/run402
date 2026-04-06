import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---- Mock pool + KMS service before importing under test --------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockClient: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockCreateKmsKey: (proj: string, w: string) => Promise<any>;

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
    createKmsKey: (p: string, w: string) => mockCreateKmsKey(p, w),
  },
});

mock.module("../utils/async-handler.js", {
  namedExports: {
    HttpError: class HttpError extends Error {
      public statusCode: number;
      public body?: Record<string, unknown>;
      constructor(statusCode: number, message: string, body?: Record<string, unknown>) {
        super(message);
        this.statusCode = statusCode;
        this.name = "HttpError";
        this.body = body;
      }
    },
  },
});

const {
  provisionWallet,
  getWallet,
  listWallets,
  setRecoveryAddress,
  setLowBalanceThreshold,
} = await import("./contract-wallets.js");

// ---- Test fixtures -----------------------------------------------------

const TEST_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

interface CapturedQuery { text: string; params?: unknown[] }

function makeMockClient(opts: {
  available?: number;
  listWalletRows?: Record<string, unknown>[];
  walletRow?: Record<string, unknown> | null;
  failKms?: boolean;
} = {}) {
  const queries: CapturedQuery[] = [];
  let released = false;
  let rolledBack = false;
  return {
    queries,
    get released() { return released; },
    get rolledBack() { return rolledBack; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (text: any, params?: unknown[]) => {
      const t = typeof text === "string" ? text : text?.text || String(text);
      queries.push({ text: t, params });
      if (/BEGIN|COMMIT/.test(t)) return { rows: [] };
      if (/ROLLBACK/.test(t)) { rolledBack = true; return { rows: [] }; }
      if (/SELECT \* FROM internal\.billing_accounts WHERE id = \$1 FOR UPDATE/i.test(t)) {
        return { rows: [{ id: "ba_1", available_usd_micros: String(opts.available ?? 5_000_000) }] };
      }
      if (/INSERT INTO internal\.contract_wallets/i.test(t)) {
        return { rows: [] };
      }
      if (/UPDATE internal\.billing_accounts SET available_usd_micros/i.test(t)) {
        return { rows: [] };
      }
      if (/INSERT INTO internal\.allowance_ledger/i.test(t)) {
        return { rows: [] };
      }
      if (/SELECT \* FROM internal\.contract_wallets WHERE id = \$1/i.test(t)) {
        return { rows: opts.walletRow ? [opts.walletRow] : [] };
      }
      if (/SELECT \* FROM internal\.contract_wallets WHERE project_id = \$1/i.test(t)) {
        return { rows: opts.listWalletRows ?? [] };
      }
      if (/UPDATE internal\.contract_wallets SET recovery_address/i.test(t)) {
        return { rows: opts.walletRow ? [opts.walletRow] : [] };
      }
      if (/UPDATE internal\.contract_wallets SET low_balance_threshold_wei/i.test(t)) {
        return { rows: opts.walletRow ? [opts.walletRow] : [] };
      }
      return { rows: [] };
    },
    release: () => { released = true; },
  };
}

beforeEach(() => {
  mockCreateKmsKey = async () => ({
    kms_key_id: "kms-key-test",
    address: TEST_ADDRESS,
    public_key_der: new Uint8Array(),
  });
  mockClient = makeMockClient({});
});

// ---- provisionWallet ---------------------------------------------------

describe("provisionWallet", () => {
  it("happy path: creates KMS key, inserts wallet, debits first day's rent atomically", async () => {
    const wallet = await provisionWallet({
      projectId: "proj_1",
      billingAccountId: "ba_1",
      chain: "base-mainnet",
    });
    assert.equal(wallet.address, TEST_ADDRESS);
    assert.equal(wallet.kms_key_id, "kms-key-test");
    assert.equal(wallet.status, "active");
    assert.equal(wallet.chain, "base-mainnet");
    assert.equal(wallet.project_id, "proj_1");

    const all = mockClient.queries.map((q: CapturedQuery) => q.text).join("\n");
    assert.match(all, /BEGIN/);
    assert.match(all, /INSERT INTO internal\.contract_wallets/);
    assert.match(all, /UPDATE internal\.billing_accounts SET available_usd_micros/);
    assert.match(all, /INSERT INTO internal\.allowance_ledger.*kms_wallet_rental/s);
    assert.match(all, /COMMIT/);
    assert.equal(mockClient.released, true);
  });

  it("includes recovery_address when supplied", async () => {
    const recovery = "0x000000000000000000000000000000000000DEAD";
    await provisionWallet({
      projectId: "proj_1",
      billingAccountId: "ba_1",
      chain: "base-mainnet",
      recoveryAddress: recovery,
    });
    const insertQuery = mockClient.queries.find((q: CapturedQuery) =>
      /INSERT INTO internal\.contract_wallets/i.test(q.text),
    );
    assert.ok(insertQuery);
    assert.ok(insertQuery!.params?.includes(recovery));
  });

  it("rejects unsupported chain (no KMS call)", async () => {
    let kmsCalled = false;
    mockCreateKmsKey = async () => { kmsCalled = true; return { kms_key_id: "x", address: TEST_ADDRESS, public_key_der: new Uint8Array() }; };
    await assert.rejects(
      () => provisionWallet({ projectId: "p", billingAccountId: "ba_1", chain: "ethereum-mainnet" }),
      /unsupported_chain/,
    );
    assert.equal(kmsCalled, false);
  });

  it("rejects self-referential recovery address", async () => {
    await assert.rejects(
      () => provisionWallet({
        projectId: "p",
        billingAccountId: "ba_1",
        chain: "base-mainnet",
        recoveryAddress: TEST_ADDRESS,
      }),
      /recovery_address_self_reference/,
    );
  });

  it("KMS createKey failure leaves no half-state (no DB writes)", async () => {
    mockCreateKmsKey = async () => { throw new Error("KMS_DOWN"); };
    await assert.rejects(
      () => provisionWallet({ projectId: "p", billingAccountId: "ba_1", chain: "base-mainnet" }),
      /KMS_DOWN/,
    );
    // KMS fails before the DB transaction opens — there must be no INSERT/UPDATE.
    const all = mockClient.queries.map((q: CapturedQuery) => q.text).join("\n");
    assert.doesNotMatch(all, /INSERT INTO internal\.contract_wallets/);
    assert.doesNotMatch(all, /UPDATE internal\.billing_accounts/);
    assert.doesNotMatch(all, /INSERT INTO internal\.allowance_ledger/);
  });
});

// ---- getWallet ---------------------------------------------------------

describe("getWallet", () => {
  it("returns the wallet when project matches", async () => {
    mockClient = makeMockClient({
      walletRow: {
        id: "wlt_1", project_id: "proj_1", chain: "base-mainnet",
        address: TEST_ADDRESS, status: "active", kms_key_id: "k1",
        recovery_address: null, low_balance_threshold_wei: "1000000000000000",
        last_alert_sent_at: null, last_rent_debited_on: "2026-04-06",
        suspended_at: null, deleted_at: null, last_warning_day: null,
        created_at: new Date("2026-04-06"),
      },
    });
    const w = await getWallet("wlt_1", "proj_1");
    assert.ok(w);
    assert.equal(w!.id, "wlt_1");
    assert.equal(w!.project_id, "proj_1");
  });

  it("returns null on wrong project (no info leak)", async () => {
    mockClient = makeMockClient({
      walletRow: {
        id: "wlt_1", project_id: "proj_OTHER", chain: "base-mainnet",
        address: TEST_ADDRESS, status: "active", kms_key_id: "k1",
        recovery_address: null, low_balance_threshold_wei: "1000",
        last_alert_sent_at: null, last_rent_debited_on: null,
        suspended_at: null, deleted_at: null, last_warning_day: null,
        created_at: new Date(),
      },
    });
    const w = await getWallet("wlt_1", "proj_1");
    assert.equal(w, null);
  });

  it("returns null when wallet does not exist", async () => {
    mockClient = makeMockClient({ walletRow: null });
    const w = await getWallet("nope", "proj_1");
    assert.equal(w, null);
  });
});

// ---- listWallets -------------------------------------------------------

describe("listWallets", () => {
  it("includes deleted wallets", async () => {
    mockClient = makeMockClient({
      listWalletRows: [
        { id: "w1", project_id: "p", chain: "base-mainnet", address: TEST_ADDRESS, status: "active", kms_key_id: "k1", recovery_address: null, low_balance_threshold_wei: "1", last_alert_sent_at: null, last_rent_debited_on: null, suspended_at: null, deleted_at: null, last_warning_day: null, created_at: new Date() },
        { id: "w2", project_id: "p", chain: "base-mainnet", address: TEST_ADDRESS, status: "deleted", kms_key_id: null, recovery_address: null, low_balance_threshold_wei: "1", last_alert_sent_at: null, last_rent_debited_on: null, suspended_at: null, deleted_at: new Date(), last_warning_day: null, created_at: new Date() },
      ],
    });
    const list = await listWallets("p");
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((w) => w.status), ["active", "deleted"]);
  });
});

// ---- setRecoveryAddress ------------------------------------------------

describe("setRecoveryAddress", () => {
  it("rejects self-reference", async () => {
    mockClient = makeMockClient({
      walletRow: {
        id: "w1", project_id: "p", chain: "base-mainnet", address: TEST_ADDRESS,
        status: "active", kms_key_id: "k", recovery_address: null,
        low_balance_threshold_wei: "1", last_alert_sent_at: null,
        last_rent_debited_on: null, suspended_at: null, deleted_at: null,
        last_warning_day: null, created_at: new Date(),
      },
    });
    await assert.rejects(
      () => setRecoveryAddress("w1", "p", TEST_ADDRESS),
      /recovery_address_self_reference/,
    );
  });

  it("rejects when wallet is deleted", async () => {
    mockClient = makeMockClient({
      walletRow: {
        id: "w1", project_id: "p", chain: "base-mainnet", address: TEST_ADDRESS,
        status: "deleted", kms_key_id: null, recovery_address: null,
        low_balance_threshold_wei: "1", last_alert_sent_at: null,
        last_rent_debited_on: null, suspended_at: null,
        deleted_at: new Date(), last_warning_day: null, created_at: new Date(),
      },
    });
    await assert.rejects(
      () => setRecoveryAddress("w1", "p", "0x000000000000000000000000000000000000dEaD"),
      /wallet_deleted/,
    );
  });

  it("returns 404 when wallet not owned", async () => {
    mockClient = makeMockClient({ walletRow: null });
    await assert.rejects(
      () => setRecoveryAddress("w1", "p", "0x000000000000000000000000000000000000dEaD"),
      /not_found|HttpError/,
    );
  });
});

// ---- setLowBalanceThreshold --------------------------------------------

describe("setLowBalanceThreshold", () => {
  it("returns 404 when wallet not owned", async () => {
    mockClient = makeMockClient({ walletRow: null });
    await assert.rejects(
      () => setLowBalanceThreshold("w1", "p", BigInt(1000)),
      /not_found|HttpError/,
    );
  });
});
