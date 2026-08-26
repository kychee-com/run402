/**
 * gitvault cross-profile repo-key scan (kychee-com/run402#564) — a purely
 * local directory/filename read: which OTHER wallet profiles on this
 * machine hold a `repos/<repo_id>.json` file for a given repo_id. Never
 * touches file CONTENTS.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureProfileDir, profileDir } from "../../../core/src/profiles.js";
import { findLocalProfilesHoldingGitvaultRepo, crossProfileGitvaultHint } from "./gitvault-profile-scan.js";

const REPO_A = `src_${"a".repeat(32)}`;
const REPO_B = `src_${"b".repeat(32)}`;

const origConfigDir = process.env.RUN402_CONFIG_DIR;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "run402-gitvault-profile-scan-"));
  process.env.RUN402_CONFIG_DIR = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (origConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = origConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
});

/** Drop an (empty-content — filenames only matter) repo-key file under a profile's gitvault keystore. */
function dropRepoFile(profile: string, repoId: string): void {
  const dir = join(ensureProfileDir(profile), "gitvault", "repos");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${repoId}.json`), "{}");
}

describe("findLocalProfilesHoldingGitvaultRepo", () => {
  it("finds nothing when no local profile holds the key", () => {
    ensureProfileDir("platform-deploy");
    assert.deepEqual(findLocalProfilesHoldingGitvaultRepo(REPO_A), []);
  });

  it("finds a NAMED profile holding the key", () => {
    dropRepoFile("platform-deploy", REPO_A);
    assert.deepEqual(findLocalProfilesHoldingGitvaultRepo(REPO_A), ["platform-deploy"]);
  });

  it("finds the default profile holding the key — requires default/allowance.json to exist, matching listProfileNames' own convention", () => {
    writeFileSync(join(tmp, "allowance.json"), "{}");
    const dir = join(profileDir("default"), "gitvault", "repos");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${REPO_A}.json`), "{}");
    assert.deepEqual(findLocalProfilesHoldingGitvaultRepo(REPO_A), ["default"]);
  });

  it("does not match a DIFFERENT repo_id", () => {
    dropRepoFile("platform-deploy", REPO_A);
    assert.deepEqual(findLocalProfilesHoldingGitvaultRepo(REPO_B), []);
  });

  it("reports every matching profile when more than one holds the same key (a restored/shared keystore)", () => {
    dropRepoFile("platform-deploy", REPO_A);
    dropRepoFile("staging", REPO_A);
    assert.deepEqual(findLocalProfilesHoldingGitvaultRepo(REPO_A).sort(), ["platform-deploy", "staging"]);
  });

  it("excludes the caller's own profile via excludeProfile", () => {
    dropRepoFile("platform-deploy", REPO_A);
    dropRepoFile("staging", REPO_A);
    assert.deepEqual(findLocalProfilesHoldingGitvaultRepo(REPO_A, { excludeProfile: "platform-deploy" }), ["staging"]);
  });

  it("never throws on a malformed repo_id — resolves to no match", () => {
    dropRepoFile("platform-deploy", REPO_A);
    assert.deepEqual(findLocalProfilesHoldingGitvaultRepo("../../../etc/passwd"), []);
    assert.deepEqual(findLocalProfilesHoldingGitvaultRepo("not-a-src-id"), []);
  });

  it("never throws when profiles/ does not exist at all", () => {
    assert.deepEqual(findLocalProfilesHoldingGitvaultRepo(REPO_A), []);
  });
});

describe("crossProfileGitvaultHint", () => {
  it("names the wallet and both selection mechanisms when a key is found", () => {
    dropRepoFile("platform-deploy", REPO_A);
    const hint = crossProfileGitvaultHint(REPO_A);
    assert.equal(hint.length, 1);
    assert.match(hint[0]!.action, /'platform-deploy'/);
    assert.match(hint[0]!.action, /--wallet/);
    assert.match(hint[0]!.action, /RUN402_WALLET/);
  });

  it("is empty when the key exists nowhere locally — never a hint pointing at nothing", () => {
    ensureProfileDir("platform-deploy");
    assert.deepEqual(crossProfileGitvaultHint(REPO_A), []);
  });
});
