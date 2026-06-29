import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  configureApiBase,
  getApiBase,
  getApiBaseSource,
  getApiTargetConfigPath,
  getApiTargetKind,
  getAllowancePath,
  getConfigBaseDir,
  getConfigDir,
  getDeployApiBase,
  getKeystorePath,
  getProfilesDir,
  getActiveProfile,
  isCoreApiTarget,
  isValidProfileName,
  readApiTargetConfig,
} from "./config.js";

const origApiBase = process.env.RUN402_API_BASE;
const origDeployApiBase = process.env.RUN402_DEPLOY_API_BASE;
const origConfigDir = process.env.RUN402_CONFIG_DIR;
const origAllowancePath = process.env.RUN402_ALLOWANCE_PATH;
const origWallet = process.env.RUN402_WALLET;
const origProfile = process.env.RUN402_PROFILE;

function withTempConfig<T>(fn: (dir: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "config-test-"));
  const prev = process.env.RUN402_CONFIG_DIR;
  process.env.RUN402_CONFIG_DIR = tmp;
  try {
    return fn(tmp);
  } finally {
    if (prev !== undefined) process.env.RUN402_CONFIG_DIR = prev;
    else delete process.env.RUN402_CONFIG_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
}

afterEach(() => {
  if (origApiBase !== undefined) process.env.RUN402_API_BASE = origApiBase;
  else delete process.env.RUN402_API_BASE;
  if (origDeployApiBase !== undefined) process.env.RUN402_DEPLOY_API_BASE = origDeployApiBase;
  else delete process.env.RUN402_DEPLOY_API_BASE;
  if (origConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = origConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  if (origAllowancePath !== undefined) process.env.RUN402_ALLOWANCE_PATH = origAllowancePath;
  else delete process.env.RUN402_ALLOWANCE_PATH;
  if (origWallet !== undefined) process.env.RUN402_WALLET = origWallet;
  else delete process.env.RUN402_WALLET;
  if (origProfile !== undefined) process.env.RUN402_PROFILE = origProfile;
  else delete process.env.RUN402_PROFILE;
});

describe("config", () => {
  it("returns default API base", () => {
    delete process.env.RUN402_API_BASE;
    withTempConfig(() => {
      assert.equal(getApiBase(), "https://api.run402.com");
      assert.equal(getApiBaseSource(), "default");
    });
  });

  it("returns custom API base from env", () => {
    withTempConfig(() => {
      process.env.RUN402_API_BASE = "https://custom.api.com";
      assert.equal(getApiBase(), "https://custom.api.com");
      assert.equal(getApiBaseSource(), "env");
    });
  });

  it("accepts http:// API base (local dev / staging)", () => {
    withTempConfig(() => {
      process.env.RUN402_API_BASE = "http://localhost:8080";
      assert.equal(getApiBase(), "http://localhost:8080");
    });
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
      withTempConfig(() => {
        assert.equal(getApiBase(), "https://api.run402.com");
      });
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
    withTempConfig(() => {
      delete process.env.RUN402_DEPLOY_API_BASE;
      process.env.RUN402_API_BASE = "https://custom.api.com";
      assert.equal(getDeployApiBase(), "https://custom.api.com");
    });
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
      withTempConfig(() => {
        assert.equal(getDeployApiBase(), "https://custom.api.com");
      });
    } finally {
      process.stderr.write = origWrite;
    }
    assert.match(captured, /RUN402_DEPLOY_API_BASE/);
  });

  it("uses persisted profile API base when env is unset", () => {
    withTempConfig(() => {
      delete process.env.RUN402_API_BASE;
      const cfg = configureApiBase("http://127.0.0.1:4020/", {
        target_kind: "core",
        health_status: "ok",
      });
      assert.equal(cfg.api_base, "http://127.0.0.1:4020");
      assert.equal(getApiBase(), "http://127.0.0.1:4020");
      assert.equal(getApiBaseSource(), "profile");
      assert.equal(getApiTargetKind(), "core");
      assert.equal(isCoreApiTarget(), true);
      assert.equal(readApiTargetConfig()?.health_status, "ok");
      assert.equal(getApiTargetConfigPath(), join(process.env.RUN402_CONFIG_DIR!, "target.json"));
    });
  });

  it("env API base overrides persisted profile API base", () => {
    withTempConfig(() => {
      configureApiBase("http://127.0.0.1:4020", { target_kind: "core" });
      process.env.RUN402_API_BASE = "https://custom.api.com";
      assert.equal(getApiBase(), "https://custom.api.com");
      assert.equal(getApiBaseSource(), "env");
      assert.equal(isCoreApiTarget(), false);
    });
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

describe("config — wallet profiles", () => {
  beforeEach(() => {
    process.env.RUN402_CONFIG_DIR = "/tmp/test-config";
    delete process.env.RUN402_WALLET;
    delete process.env.RUN402_PROFILE;
    delete process.env.RUN402_ALLOWANCE_PATH;
  });

  it("default profile resolves to the base config dir (zero migration)", () => {
    assert.equal(getActiveProfile(), "default");
    assert.equal(getConfigDir(), "/tmp/test-config");
    assert.equal(getConfigBaseDir(), "/tmp/test-config");
    assert.equal(getKeystorePath(), join("/tmp/test-config", "projects.json"));
    assert.equal(getAllowancePath(), join("/tmp/test-config", "allowance.json"));
  });

  it("RUN402_WALLET nests the config dir under profiles/<name>", () => {
    process.env.RUN402_WALLET = "kychon";
    assert.equal(getActiveProfile(), "kychon");
    assert.equal(getConfigDir(), join("/tmp/test-config", "profiles", "kychon"));
    assert.equal(getKeystorePath(), join("/tmp/test-config", "profiles", "kychon", "projects.json"));
    assert.equal(getAllowancePath(), join("/tmp/test-config", "profiles", "kychon", "allowance.json"));
    // base dir + profiles dir are unaffected by the active profile
    assert.equal(getConfigBaseDir(), "/tmp/test-config");
    assert.equal(getProfilesDir(), join("/tmp/test-config", "profiles"));
  });

  it("RUN402_PROFILE is accepted as an alias", () => {
    process.env.RUN402_PROFILE = "client-a";
    assert.equal(getActiveProfile(), "client-a");
    assert.equal(getConfigDir(), join("/tmp/test-config", "profiles", "client-a"));
  });

  it("RUN402_WALLET takes precedence over RUN402_PROFILE", () => {
    process.env.RUN402_WALLET = "wins";
    process.env.RUN402_PROFILE = "loses";
    assert.equal(getActiveProfile(), "wins");
  });

  it("empty/whitespace profile env falls back to default", () => {
    process.env.RUN402_WALLET = "   ";
    assert.equal(getActiveProfile(), "default");
    assert.equal(getConfigDir(), "/tmp/test-config");
  });

  it("rejects path-traversal profile names (defense in depth)", () => {
    for (const evil of ["../evil", "a/b", "..", "Foo", "with space", "/abs"]) {
      process.env.RUN402_WALLET = evil;
      assert.throws(() => getConfigDir(), /Invalid wallet\/profile name/, `expected ${evil} to throw`);
    }
  });

  it("isValidProfileName enforces the filesystem-safe pattern", () => {
    assert.ok(isValidProfileName("kychon"));
    assert.ok(isValidProfileName("client-a"));
    assert.ok(isValidProfileName("a1_b-2"));
    assert.ok(!isValidProfileName("Foo"));
    assert.ok(!isValidProfileName("-leading"));
    assert.ok(!isValidProfileName(""));
    assert.ok(!isValidProfileName("../x"));
  });
});
