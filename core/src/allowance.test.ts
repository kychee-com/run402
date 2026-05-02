import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAllowance, saveAllowance } from "./allowance.js";
import type { AllowanceData } from "./allowance.js";

let tempDir: string;
let allowancePath: string;

// Valid shape values — used by all round-trip tests.
const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const VALID_PRIVATE_KEY = "0x" + "ab".repeat(32);

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-allowance-test-"));
  allowancePath = join(tempDir, "allowance.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("allowance", () => {
  it("returns null when file does not exist", () => {
    assert.equal(readAllowance(allowancePath), null);
  });

  it("saves and reads allowance", () => {
    const allowance: AllowanceData = {
      address: VALID_ADDRESS,
      privateKey: VALID_PRIVATE_KEY,
      created: "2026-03-15T00:00:00Z",
      funded: true,
    };
    saveAllowance(allowance, allowancePath);
    const loaded = readAllowance(allowancePath);
    assert.deepEqual(loaded, allowance);
  });

  it("creates file with 0600 permissions", { skip: process.platform === "win32" ? "POSIX file modes not enforced on Windows NTFS" : false }, () => {
    saveAllowance({ address: VALID_ADDRESS, privateKey: VALID_PRIVATE_KEY }, allowancePath);
    const stats = statSync(allowancePath);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0600 but got 0${mode.toString(8)}`);
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(allowancePath, "NOT VALID JSON{{{");
    assert.equal(readAllowance(allowancePath), null);
  });

  it("atomic write produces valid JSON", () => {
    const allowance: AllowanceData = { address: VALID_ADDRESS, privateKey: VALID_PRIVATE_KEY };
    saveAllowance(allowance, allowancePath);
    const raw = readFileSync(allowancePath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.address, VALID_ADDRESS);
  });

  it("round-trips rail field", () => {
    const allowance: AllowanceData = {
      address: VALID_ADDRESS,
      privateKey: VALID_PRIVATE_KEY,
      rail: "mpp",
    };
    saveAllowance(allowance, allowancePath);
    const loaded = readAllowance(allowancePath);
    assert.equal(loaded?.rail, "mpp");
  });

  it("missing rail field reads as undefined", () => {
    const allowance: AllowanceData = { address: VALID_ADDRESS, privateKey: VALID_PRIVATE_KEY };
    saveAllowance(allowance, allowancePath);
    const loaded = readAllowance(allowancePath);
    assert.equal(loaded?.rail, undefined);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GH-194: malformed-shape (valid JSON, wrong fields) must throw a structured
  // error instead of returning a partial object that crashes downstream when
  // callers reach for `.toLowerCase()` on a missing address or pass a too-short
  // privateKey to noble curves. The CLI/MCP wrappers convert this throw into
  // their own friendly error envelope.
  // ──────────────────────────────────────────────────────────────────────────

  describe("GH-194 shape validation", () => {
    it("throws when JSON parses to an empty object (no address)", () => {
      writeFileSync(allowancePath, "{}");
      assert.throws(
        () => readAllowance(allowancePath),
        (err: Error) =>
          /address/i.test(err.message) &&
          /run402 init/.test(err.message),
        "must throw a clear error mentioning the missing address and the recovery command",
      );
    });

    it("throws when address is missing but other fields are present", () => {
      writeFileSync(
        allowancePath,
        JSON.stringify({ privateKey: VALID_PRIVATE_KEY, rail: "x402" }),
      );
      assert.throws(
        () => readAllowance(allowancePath),
        (err: Error) => /address/i.test(err.message),
      );
    });

    it("throws when privateKey is the wrong length (too short)", () => {
      writeFileSync(
        allowancePath,
        JSON.stringify({
          address: VALID_ADDRESS,
          privateKey: "0xdeadbeef",
          weirdfield: "value",
        }),
      );
      assert.throws(
        () => readAllowance(allowancePath),
        (err: Error) =>
          /privateKey/i.test(err.message) &&
          /run402 init/.test(err.message),
        "must throw mentioning privateKey shape and the recovery command",
      );
    });

    it("throws when address is malformed (not 0x-prefixed 40-hex)", () => {
      writeFileSync(
        allowancePath,
        JSON.stringify({ address: "0xnotvalid", privateKey: VALID_PRIVATE_KEY }),
      );
      assert.throws(
        () => readAllowance(allowancePath),
        (err: Error) => /address/i.test(err.message),
      );
    });

    it("throws when JSON parses to null", () => {
      writeFileSync(allowancePath, "null");
      assert.throws(
        () => readAllowance(allowancePath),
        (err: Error) => /JSON object/i.test(err.message),
      );
    });

    it("throws when JSON parses to an array", () => {
      writeFileSync(allowancePath, "[]");
      assert.throws(
        () => readAllowance(allowancePath),
        (err: Error) => /JSON object/i.test(err.message),
      );
    });

    it("throws when JSON parses to a number", () => {
      writeFileSync(allowancePath, "42");
      assert.throws(
        () => readAllowance(allowancePath),
        (err: Error) => /JSON object/i.test(err.message),
      );
    });

    it("throws when JSON parses to a string", () => {
      writeFileSync(allowancePath, '"hello"');
      assert.throws(
        () => readAllowance(allowancePath),
        (err: Error) => /JSON object/i.test(err.message),
      );
    });

    it("accepts a valid allowance with both address and privateKey in the right shape", () => {
      writeFileSync(
        allowancePath,
        JSON.stringify({
          address: VALID_ADDRESS,
          privateKey: VALID_PRIVATE_KEY,
        }),
      );
      const loaded = readAllowance(allowancePath);
      assert.equal(loaded?.address, VALID_ADDRESS);
      assert.equal(loaded?.privateKey, VALID_PRIVATE_KEY);
    });

    it("accepts uppercase hex in address and privateKey", () => {
      const upperAddress = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01";
      const upperKey = "0x" + "AB".repeat(32);
      writeFileSync(
        allowancePath,
        JSON.stringify({ address: upperAddress, privateKey: upperKey }),
      );
      const loaded = readAllowance(allowancePath);
      assert.equal(loaded?.address, upperAddress);
      assert.equal(loaded?.privateKey, upperKey);
    });
  });
});
