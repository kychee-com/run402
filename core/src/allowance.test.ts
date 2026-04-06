import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAllowance, saveAllowance } from "./allowance.js";
import type { AllowanceData } from "./allowance.js";

let tempDir: string;
let allowancePath: string;

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
      address: "0xtest123",
      privateKey: "0xpk456",
      created: "2026-03-15T00:00:00Z",
      funded: true,
    };
    saveAllowance(allowance, allowancePath);
    const loaded = readAllowance(allowancePath);
    assert.deepEqual(loaded, allowance);
  });

  it("creates file with 0600 permissions", { skip: process.platform === "win32" ? "POSIX file modes not enforced on Windows NTFS" : false }, () => {
    saveAllowance({ address: "0x1", privateKey: "0x2" }, allowancePath);
    const stats = statSync(allowancePath);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600, `Expected 0600 but got 0${mode.toString(8)}`);
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(allowancePath, "NOT VALID JSON{{{");
    assert.equal(readAllowance(allowancePath), null);
  });

  it("atomic write produces valid JSON", () => {
    const allowance: AllowanceData = { address: "0xabc", privateKey: "0xdef" };
    saveAllowance(allowance, allowancePath);
    const raw = readFileSync(allowancePath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.address, "0xabc");
  });

  it("round-trips rail field", () => {
    const allowance: AllowanceData = {
      address: "0xtest",
      privateKey: "0xpk",
      rail: "mpp",
    };
    saveAllowance(allowance, allowancePath);
    const loaded = readAllowance(allowancePath);
    assert.equal(loaded?.rail, "mpp");
  });

  it("missing rail field reads as undefined", () => {
    const allowance: AllowanceData = { address: "0xtest", privateKey: "0xpk" };
    saveAllowance(allowance, allowancePath);
    const loaded = readAllowance(allowancePath);
    assert.equal(loaded?.rail, undefined);
  });
});
