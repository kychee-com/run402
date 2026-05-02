import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getApiBase, getDeployApiBase, getConfigDir, getKeystorePath, getAllowancePath } from "./config.js";

const origApiBase = process.env.RUN402_API_BASE;
const origDeployApiBase = process.env.RUN402_DEPLOY_API_BASE;
const origConfigDir = process.env.RUN402_CONFIG_DIR;
const origAllowancePath = process.env.RUN402_ALLOWANCE_PATH;

afterEach(() => {
  if (origApiBase !== undefined) process.env.RUN402_API_BASE = origApiBase;
  else delete process.env.RUN402_API_BASE;
  if (origDeployApiBase !== undefined) process.env.RUN402_DEPLOY_API_BASE = origDeployApiBase;
  else delete process.env.RUN402_DEPLOY_API_BASE;
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

  it("accepts http:// API base (local dev / staging)", () => {
    process.env.RUN402_API_BASE = "http://localhost:8080";
    assert.equal(getApiBase(), "http://localhost:8080");
  });

  it("warns and falls back to default when RUN402_API_BASE is empty string", () => {
    process.env.RUN402_API_BASE = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    // @ts-expect-error monkey-patch for test
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    };
    try {
      assert.equal(getApiBase(), "https://api.run402.com");
    } finally {
      process.stderr.write = origWrite;
    }
    assert.match(captured, /RUN402_API_BASE/);
    assert.match(captured, /empty/i);
  });

  it("throws when RUN402_API_BASE has no scheme", () => {
    process.env.RUN402_API_BASE = "api.run402.com";
    assert.throws(
      () => getApiBase(),
      /RUN402_API_BASE.*not a valid URL.*api\.run402\.com/,
    );
  });

  it("throws when RUN402_API_BASE uses a non-http(s) scheme (javascript:)", () => {
    process.env.RUN402_API_BASE = "javascript:alert(1)";
    assert.throws(
      () => getApiBase(),
      /RUN402_API_BASE.*http\(s\).*javascript:/,
    );
  });

  it("throws when RUN402_API_BASE uses a non-http(s) scheme (file:)", () => {
    process.env.RUN402_API_BASE = "file:///etc/passwd";
    assert.throws(
      () => getApiBase(),
      /RUN402_API_BASE.*http\(s\).*file:/,
    );
  });

  it("getDeployApiBase falls back to getApiBase when not set", () => {
    delete process.env.RUN402_DEPLOY_API_BASE;
    process.env.RUN402_API_BASE = "https://custom.api.com";
    assert.equal(getDeployApiBase(), "https://custom.api.com");
  });

  it("getDeployApiBase validates its own value", () => {
    process.env.RUN402_DEPLOY_API_BASE = "javascript:alert(1)";
    assert.throws(
      () => getDeployApiBase(),
      /RUN402_DEPLOY_API_BASE.*http\(s\).*javascript:/,
    );
  });

  it("getDeployApiBase warns on empty string and falls back to getApiBase", () => {
    process.env.RUN402_DEPLOY_API_BASE = "";
    process.env.RUN402_API_BASE = "https://custom.api.com";
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    // @ts-expect-error monkey-patch for test
    process.stderr.write = (chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    };
    try {
      assert.equal(getDeployApiBase(), "https://custom.api.com");
    } finally {
      process.stderr.write = origWrite;
    }
    assert.match(captured, /RUN402_DEPLOY_API_BASE/);
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
    // Use path.join in the expected value so the test passes on both POSIX
    // and Windows (Windows produces backslashes via path.join).
    assert.equal(getKeystorePath(), join("/tmp/test-config", "projects.json"));
  });

  it("derives allowance path from config dir", () => {
    process.env.RUN402_CONFIG_DIR = "/tmp/test-config";
    delete process.env.RUN402_ALLOWANCE_PATH;
    assert.equal(getAllowancePath(), join("/tmp/test-config", "allowance.json"));
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
