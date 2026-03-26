import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getApiBase, getConfigDir, getKeystorePath, getAllowancePath } from "./config.js";

const origApiBase = process.env.RUN402_API_BASE;
const origConfigDir = process.env.RUN402_CONFIG_DIR;
const origAllowancePath = process.env.RUN402_ALLOWANCE_PATH;

afterEach(() => {
  if (origApiBase !== undefined) process.env.RUN402_API_BASE = origApiBase;
  else delete process.env.RUN402_API_BASE;
  if (origConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = origConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  if (origAllowancePath !== undefined) process.env.RUN402_ALLOWANCE_PATH = origAllowancePath;
  else delete process.env.RUN402_ALLOWANCE_PATH;
});

describe("config", () => {
  it("returns default API base", () => {
    delete process.env.RUN402_API_BASE;
    assert.equal(getApiBase(), "https://api.run402.com");
  });

  it("returns custom API base from env", () => {
    process.env.RUN402_API_BASE = "https://custom.api.com";
    assert.equal(getApiBase(), "https://custom.api.com");
  });

  it("returns default config dir", () => {
    delete process.env.RUN402_CONFIG_DIR;
    assert.equal(getConfigDir(), join(homedir(), ".config", "run402"));
  });

  it("returns custom config dir from env", () => {
    process.env.RUN402_CONFIG_DIR = "/tmp/test-config";
    assert.equal(getConfigDir(), "/tmp/test-config");
  });

  it("derives keystore path from config dir", () => {
    process.env.RUN402_CONFIG_DIR = "/tmp/test-config";
    assert.equal(getKeystorePath(), "/tmp/test-config/projects.json");
  });

  it("derives allowance path from config dir", () => {
    process.env.RUN402_CONFIG_DIR = "/tmp/test-config";
    delete process.env.RUN402_ALLOWANCE_PATH;
    assert.equal(getAllowancePath(), "/tmp/test-config/allowance.json");
  });

  it("returns custom allowance path from RUN402_ALLOWANCE_PATH env", () => {
    process.env.RUN402_ALLOWANCE_PATH = "/custom/path/allowance.json";
    assert.equal(getAllowancePath(), "/custom/path/allowance.json");
  });

  it("RUN402_ALLOWANCE_PATH takes precedence over RUN402_CONFIG_DIR", () => {
    process.env.RUN402_CONFIG_DIR = "/tmp/test-config";
    process.env.RUN402_ALLOWANCE_PATH = "/other/place/wallet.json";
    assert.equal(getAllowancePath(), "/other/place/wallet.json");
  });

  it("RUN402_ALLOWANCE_PATH skips legacy wallet.json migration", () => {
    const tmp = mkdtempSync(join(tmpdir(), "config-test-"));
    try {
      writeFileSync(join(tmp, "wallet.json"), "{}");
      process.env.RUN402_CONFIG_DIR = tmp;
      process.env.RUN402_ALLOWANCE_PATH = "/custom/allowance.json";
      assert.equal(getAllowancePath(), "/custom/allowance.json");
      // wallet.json should NOT have been renamed
      assert.ok(existsSync(join(tmp, "wallet.json")), "wallet.json should still exist");
      assert.ok(!existsSync(join(tmp, "allowance.json")), "allowance.json should not have been created");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
