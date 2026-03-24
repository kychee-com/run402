import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: any[]) => mockPoolQuery(...args),
    },
  },
});

const { isAdminWallet, addAdminWallet, removeAdminWallet, listAdminWallets, initAdminWalletsTable } =
  await import("./admin-wallets.js");

describe("initAdminWalletsTable", () => {
  it("creates table and loads wallets into memory", async () => {
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 2) return { rows: [{ address: "0xABC" }, { address: "0xDEF" }] };
      return { rows: [] };
    };
    await initAdminWalletsTable();
    assert.ok(isAdminWallet("0xabc"));
    assert.ok(isAdminWallet("0xdef"));
  });
});

describe("isAdminWallet", () => {
  it("normalizes address to lowercase", () => {
    // 0xABC was loaded in initAdminWalletsTable
    assert.ok(isAdminWallet("0xABC"));
    assert.ok(isAdminWallet("0xAbC"));
  });

  it("returns false for unknown address", () => {
    assert.ok(!isAdminWallet("0xunknown"));
  });
});

describe("addAdminWallet", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("adds wallet to memory and DB", async () => {
    let capturedParams: any[];
    mockPoolQuery = async (_sql: string, params: any[]) => {
      capturedParams = params;
      return { rows: [] };
    };

    await addAdminWallet("0xNEW", "test-label", "admin");
    assert.ok(isAdminWallet("0xnew"));
    assert.equal(capturedParams![0], "0xnew"); // normalized
    assert.equal(capturedParams![1], "test-label");
    assert.equal(capturedParams![2], "admin");
  });
});

describe("removeAdminWallet", () => {
  it("removes wallet from memory and DB, returns true when found", async () => {
    mockPoolQuery = async () => ({ rowCount: 1 });
    const result = await removeAdminWallet("0xNEW");
    assert.ok(result);
    assert.ok(!isAdminWallet("0xnew"));
  });

  it("returns false when wallet not found in DB", async () => {
    mockPoolQuery = async () => ({ rowCount: 0 });
    const result = await removeAdminWallet("0xnonexistent");
    assert.ok(!result);
  });
});

describe("listAdminWallets", () => {
  it("returns rows from DB", async () => {
    const rows = [
      { address: "0xabc", label: "test", added_by: "admin", added_at: "2026-01-01" },
    ];
    mockPoolQuery = async () => ({ rows });
    const result = await listAdminWallets();
    assert.deepEqual(result, rows);
  });
});
