import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readWallet, saveWallet } from "./wallet.js";
import type { WalletData } from "./wallet.js";

let tempDir: string;
let walletPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-wallet-test-"));
  walletPath = join(tempDir, "wallet.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("wallet", () => {
  it("returns null when file does not exist", () => {
    assert.equal(readWallet(walletPath), null);
  });

  it("saves and reads wallet", () => {
    const wallet: WalletData = {
      address: "0xtest123",
      privateKey: "0xpk456",
      created: "2026-03-15T00:00:00Z",
      funded: true,
    };
    saveWallet(wallet, walletPath);
    const loaded = readWallet(walletPath);
    assert.deepEqual(loaded, wallet);
  });

  it("creates file with 0600 permissions", () => {
    saveWallet({ address: "0x1", privateKey: "0x2" }, walletPath);
    const stats = statSync(walletPath);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0600 but got 0${mode.toString(8)}`);
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(walletPath, "NOT VALID JSON{{{");
    assert.equal(readWallet(walletPath), null);
  });

  it("atomic write produces valid JSON", () => {
    const wallet: WalletData = { address: "0xabc", privateKey: "0xdef" };
    saveWallet(wallet, walletPath);
    const raw = readFileSync(walletPath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.address, "0xabc");
  });
});
