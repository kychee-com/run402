import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readWallet, saveWallet } from "./wallet.js";
import type { WalletData } from "./wallet.js";

let tempDir: string;
let walletPath: string;

// Valid shape values — used by all round-trip tests.
const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const VALID_PRIVATE_KEY = "0x" + "ab".repeat(32);

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
    const localWallet: WalletData = {
      address: VALID_ADDRESS,
      privateKey: VALID_PRIVATE_KEY,
      created: "2026-03-15T00:00:00Z",
      funded: true,
    };
    saveWallet(localWallet, walletPath);
    const loaded = readWallet(walletPath);
    assert.deepEqual(loaded, localWallet);
  });

  it("creates file with 0600 permissions", { skip: process.platform === "win32" ? "POSIX file modes not enforced on Windows NTFS" : false }, () => {
    saveWallet({ address: VALID_ADDRESS, privateKey: VALID_PRIVATE_KEY }, walletPath);
    const stats = statSync(walletPath);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0600 but got 0${mode.toString(8)}`);
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(walletPath, "NOT VALID JSON{{{");
    assert.equal(readWallet(walletPath), null);
  });

  it("self-heals a world-readable wallet file on read", { skip: process.platform === "win32" ? "POSIX file modes not enforced on Windows NTFS" : false }, () => {
    // Simulate a legacy wallet.json (mode 0644) migrated to wallet.json.
    writeFileSync(walletPath, JSON.stringify({ address: VALID_ADDRESS, privateKey: VALID_PRIVATE_KEY }));
    chmodSync(walletPath, 0o644);
    assert.equal(statSync(walletPath).mode & 0o777, 0o644);

    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    // @ts-expect-error monkey-patch for test
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    };
    try {
      const loaded = readWallet(walletPath);
      assert.equal(loaded?.address, VALID_ADDRESS);
    } finally {
      process.stderr.write = origWrite;
    }
    // tightened to 0600 + warned
    assert.equal(statSync(walletPath).mode & 0o777, 0o600);
    assert.match(captured, /tightened permissions/i);
  });

  it("atomic write produces valid JSON", () => {
    const localWallet: WalletData = { address: VALID_ADDRESS, privateKey: VALID_PRIVATE_KEY };
    saveWallet(localWallet, walletPath);
    const raw = readFileSync(walletPath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.address, VALID_ADDRESS);
  });

  it("round-trips rail field", () => {
    const localWallet: WalletData = {
      address: VALID_ADDRESS,
      privateKey: VALID_PRIVATE_KEY,
      rail: "mpp",
    };
    saveWallet(localWallet, walletPath);
    const loaded = readWallet(walletPath);
    assert.equal(loaded?.rail, "mpp");
  });

  it("missing rail field reads as undefined", () => {
    const localWallet: WalletData = { address: VALID_ADDRESS, privateKey: VALID_PRIVATE_KEY };
    saveWallet(localWallet, walletPath);
    const loaded = readWallet(walletPath);
    assert.equal(loaded?.rail, undefined);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // malformed-shape (valid JSON, wrong fields) must throw a structured
  // error instead of returning a partial object that crashes downstream when
  // callers reach for `.toLowerCase()` on a missing address or pass a too-short
  // privateKey to noble curves. The CLI/MCP wrappers convert this throw into
  // their own friendly error envelope.
  // ──────────────────────────────────────────────────────────────────────────

  describe("GH-194 shape validation", () => {
    it("throws when JSON parses to an empty object (no address)", () => {
      writeFileSync(walletPath, "{}");
      assert.throws(
        () => readWallet(walletPath),
        (err: Error) =>
          /address/i.test(err.message) &&
          /run402 init/.test(err.message),
        "must throw a clear error mentioning the missing address and the recovery command",
      );
    });

    it("throws when address is missing but other fields are present", () => {
      writeFileSync(
        walletPath,
        JSON.stringify({ privateKey: VALID_PRIVATE_KEY, rail: "x402" }),
      );
      assert.throws(
        () => readWallet(walletPath),
        (err: Error) => /address/i.test(err.message),
      );
    });

    it("throws when privateKey is the wrong length (too short)", () => {
      writeFileSync(
        walletPath,
        JSON.stringify({
          address: VALID_ADDRESS,
          privateKey: "0xdeadbeef",
          weirdfield: "value",
        }),
      );
      assert.throws(
        () => readWallet(walletPath),
        (err: Error) =>
          /privateKey/i.test(err.message) &&
          /run402 init/.test(err.message),
        "must throw mentioning privateKey shape and the recovery command",
      );
    });

    it("throws when address is malformed (not 0x-prefixed 40-hex)", () => {
      writeFileSync(
        walletPath,
        JSON.stringify({ address: "0xnotvalid", privateKey: VALID_PRIVATE_KEY }),
      );
      assert.throws(
        () => readWallet(walletPath),
        (err: Error) => /address/i.test(err.message),
      );
    });

    it("throws when JSON parses to null", () => {
      writeFileSync(walletPath, "null");
      assert.throws(
        () => readWallet(walletPath),
        (err: Error) => /JSON object/i.test(err.message),
      );
    });

    it("throws when JSON parses to an array", () => {
      writeFileSync(walletPath, "[]");
      assert.throws(
        () => readWallet(walletPath),
        (err: Error) => /JSON object/i.test(err.message),
      );
    });

    it("throws when JSON parses to a number", () => {
      writeFileSync(walletPath, "42");
      assert.throws(
        () => readWallet(walletPath),
        (err: Error) => /JSON object/i.test(err.message),
      );
    });

    it("throws when JSON parses to a string", () => {
      writeFileSync(walletPath, '"hello"');
      assert.throws(
        () => readWallet(walletPath),
        (err: Error) => /JSON object/i.test(err.message),
      );
    });

    it("accepts a valid wallet with both address and privateKey in the right shape", () => {
      writeFileSync(
        walletPath,
        JSON.stringify({
          address: VALID_ADDRESS,
          privateKey: VALID_PRIVATE_KEY,
        }),
      );
      const loaded = readWallet(walletPath);
      assert.equal(loaded?.address, VALID_ADDRESS);
      assert.equal(loaded?.privateKey, VALID_PRIVATE_KEY);
    });

    it("accepts uppercase hex in address and privateKey", () => {
      const upperAddress = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01";
      const upperKey = "0x" + "AB".repeat(32);
      writeFileSync(
        walletPath,
        JSON.stringify({ address: upperAddress, privateKey: upperKey }),
      );
      const loaded = readWallet(walletPath);
      assert.equal(loaded?.address, upperAddress);
      assert.equal(loaded?.privateKey, upperKey);
    });
  });
});
