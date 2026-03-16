import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { getApiBase, getConfigDir, getKeystorePath, getWalletPath } from "./config.js";

const origApiBase = process.env.RUN402_API_BASE;
const origConfigDir = process.env.RUN402_CONFIG_DIR;

afterEach(() => {
  if (origApiBase !== undefined) process.env.RUN402_API_BASE = origApiBase;
  else delete process.env.RUN402_API_BASE;
  if (origConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = origConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
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

  it("derives wallet path from config dir", () => {
    process.env.RUN402_CONFIG_DIR = "/tmp/test-config";
    assert.equal(getWalletPath(), "/tmp/test-config/wallet.json");
  });
});
