/**
 * End-to-end tests for explicit local project-key credential-cache commands.
 * These commands are local-only and safe to exercise without network access.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(repoRoot, "cli/cli.mjs");
const API = "https://test-api.run402.com";
const PROJECT_ID = "prj_redact";
const SERVICE_KEY = "svc_live_secret_value_that_must_not_leak";
const ANON_KEY = "anon_live_secret_value_that_must_not_leak";

let configDir;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "run402-credentials-cfg-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function run(args, { env = {}, input } = {}) {
  const base = {
    ...process.env,
    RUN402_CONFIG_DIR: configDir,
    RUN402_API_BASE: API,
    RUN402_WALLET_LABEL_SYNC: "0",
  };
  delete base.RUN402_WALLET;
  delete base.RUN402_PROFILE;
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...base, ...env },
    input,
    encoding: "utf-8",
    timeout: 10_000,
  });
}

function jsonOut(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`stdout not JSON: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

function errEnvelope(result) {
  const line = result.stderr.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

function importDefaultKey() {
  const result = run([
    "credentials",
    "project-keys",
    "import",
    "--project",
    PROJECT_ID,
    "--service-key-env",
    "TEST_RUN402_SERVICE_KEY",
    "--anon-key-env",
    "TEST_RUN402_ANON_KEY",
  ], {
    env: {
      TEST_RUN402_SERVICE_KEY: SERVICE_KEY,
      TEST_RUN402_ANON_KEY: ANON_KEY,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return jsonOut(result);
}

describe("credentials project-keys", () => {
  it("redacts list/status output and requires explicit reveal for secret export", () => {
    const imported = importDefaultKey();
    assert.equal(imported.source, "local_cache");
    assert.equal(imported.has_service_key, true);
    assert.equal(imported.has_anon_key, true);
    assert.ok(!imported.service_key);
    assert.ok(!imported.anon_key);

    const listResult = run(["credentials", "project-keys", "list"]);
    assert.equal(listResult.status, 0, listResult.stderr);
    assert.ok(!listResult.stdout.includes(SERVICE_KEY), "list must not print full service_key");
    assert.ok(!listResult.stdout.includes(ANON_KEY), "list must not print full anon_key");
    const list = jsonOut(listResult);
    assert.equal(list.source, "local_cache");
    assert.equal(list.projects[0].project_id, PROJECT_ID);
    assert.equal(list.projects[0].has_service_key, true);
    assert.match(list.projects[0].service_key_prefix, /^svc_live/);
    assert.ok(list.projects[0].service_key_fingerprint);

    const statusResult = run(["credentials", "project-keys", "status", "--project", PROJECT_ID]);
    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.ok(!statusResult.stdout.includes(SERVICE_KEY), "status must not print full service_key");
    assert.ok(!statusResult.stdout.includes(ANON_KEY), "status must not print full anon_key");
    const status = jsonOut(statusResult);
    assert.equal(status.configured, true);
    assert.equal(status.source, "local_cache");

    const noReveal = run(["credentials", "project-keys", "export", "--project", PROJECT_ID]);
    assert.notEqual(noReveal.status, 0);
    assert.equal(errEnvelope(noReveal).code, "REVEAL_REQUIRED");

    const reveal = run(["credentials", "project-keys", "export", "--project", PROJECT_ID, "--reveal"]);
    assert.equal(reveal.status, 0, reveal.stderr);
    const exported = jsonOut(reveal);
    assert.equal(exported.service_key, SERVICE_KEY);
    assert.equal(exported.anon_key, ANON_KEY);
    assert.equal(exported.revealed, true);
  });

  // A missing service key used to be reported before --anon-key-env was read, so
  // passing --anon-key-env alone produced an error naming only the service-key
  // flags — which reads as "--anon-key-env is not a flag in this version".
  it("names --anon-key-env when it is passed without a service key", () => {
    const result = run([
      "credentials", "project-keys", "import",
      "--project", PROJECT_ID,
      "--anon-key-env", "TEST_RUN402_ANON_KEY",
    ], { env: { TEST_RUN402_ANON_KEY: ANON_KEY } });

    assert.notEqual(result.status, 0);
    const err = errEnvelope(result);
    assert.equal(err.code, "BAD_USAGE");
    assert.match(err.message, /anon key also requires a service key/);
    assert.equal(err.details.anon_key_env, "TEST_RUN402_ANON_KEY");
    assert.equal(err.details.project_id, PROJECT_ID);

    // The generic error must survive for the case it actually describes.
    const bare = run(["credentials", "project-keys", "import", "--project", PROJECT_ID]);
    assert.notEqual(bare.status, 0);
    assert.match(errEnvelope(bare).message, /^Import requires --service-key-stdin/);
  });

  // Rotating only the anon key must not force the caller to export their service
  // key with --reveal and hand it back through a shell.
  it("rotates the anon key alone and keeps the cached service key", () => {
    importDefaultKey();
    const rotated = "anon_rotated_secret_value";

    const result = run([
      "credentials", "project-keys", "import",
      "--project", PROJECT_ID,
      "--anon-key-env", "TEST_RUN402_ANON_KEY",
    ], { env: { TEST_RUN402_ANON_KEY: rotated } });
    assert.equal(result.status, 0, result.stderr);

    const exported = jsonOut(run(["credentials", "project-keys", "export", "--project", PROJECT_ID, "--reveal"]));
    assert.equal(exported.anon_key, rotated);
    assert.equal(exported.service_key, SERVICE_KEY, "service key must survive an anon-only import");
  });

  it("keeps project-key cache scoped by wallet/profile and reports cache misses distinctly", () => {
    importDefaultKey();
    assert.equal(run(["wallets", "new", "kychon"]).status, 0);

    const defaultStatus = jsonOut(run(["--wallet", "default", "credentials", "project-keys", "status", "--project", PROJECT_ID]));
    assert.equal(defaultStatus.configured, true);
    assert.equal(defaultStatus.profile, "default");

    const namedStatus = jsonOut(run(["--wallet", "kychon", "credentials", "project-keys", "status", "--project", PROJECT_ID]));
    assert.equal(namedStatus.configured, false);
    assert.equal(namedStatus.profile, "kychon");

    const namedServiceKeyDomain = run(["--wallet", "kychon", "domains", "list", "--project", PROJECT_ID, "--auth", "service-key"]);
    assert.notEqual(namedServiceKeyDomain.status, 0);
    const err = errEnvelope(namedServiceKeyDomain);
    assert.equal(err.code, "PROJECT_CREDENTIAL_NOT_FOUND");
    assert.equal(err.details.project_id, PROJECT_ID);
    assert.equal(err.details.source, "local_cache");
    assert.equal(err.details.profile, "kychon");
  });
});
