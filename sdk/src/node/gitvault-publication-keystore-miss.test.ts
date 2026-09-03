/**
 * `GitvaultVault.repoFile()` keystore-miss refusals, enriched with the
 * cross-profile hint: `KEYSTORE_MISSING` (no local
 * identity at all) and `GITVAULT_REPO_STATE_MISSING` (identity present, but
 * no repo file for this repo_id) both point at whichever OTHER local wallet
 * profile actually holds the key, when the scan finds one — and carry their
 * pre-existing remedy unchanged when it does not.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalError } from "../errors.js";
import { ensureProfileDir } from "../../../core/src/profiles.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { GitvaultVault, type GitvaultTransport } from "./gitvault-publication.js";

const REPO_ID = `src_${"c".repeat(32)}`;

// `repoFile()` never touches the transport — a stub that throws if called is
// the strongest proof of that.
const untouchedTransport = new Proxy(
  {},
  {
    get() {
      throw new Error("repoFile() must not touch the transport");
    },
  },
) as GitvaultTransport;

const origConfigDir = process.env.RUN402_CONFIG_DIR;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "run402-gitvault-repofile-"));
  process.env.RUN402_CONFIG_DIR = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (origConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = origConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
});

function dropRepoFileUnderProfile(profile: string, repoId: string): void {
  const dir = join(ensureProfileDir(profile), "gitvault", "repos");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${repoId}.json`), "{}");
}

function nextActionsOf(e: unknown): { action: string }[] {
  assert.ok(e instanceof LocalError);
  return ((e as LocalError).nextActions ?? []) as { action: string }[];
}

describe("KEYSTORE_MISSING (no local identity)", () => {
  it("carries the pre-existing remedy when no other local profile holds the key", () => {
    const ks = GitvaultKeystore.open({ rootDir: join(tmp, "active-keystore") });
    let caught: unknown;
    try {
      GitvaultVault.open({ keystore: ks, transport: untouchedTransport, repo_id: REPO_ID });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof LocalError);
    assert.equal((caught as LocalError).code, "KEYSTORE_MISSING");
    const actions = nextActionsOf(caught);
    assert.ok(actions.some((a) => /restore ~\/.config\/run402\/gitvault/.test(a.action)));
    assert.equal(actions.length, 1, "no cross-profile hint appended when the scan finds nothing");
  });

  it("appends the cross-profile hint when another local profile holds this repo's key", () => {
    dropRepoFileUnderProfile("platform-deploy", REPO_ID);
    const ks = GitvaultKeystore.open({ rootDir: join(tmp, "active-keystore") });
    let caught: unknown;
    try {
      GitvaultVault.open({ keystore: ks, transport: untouchedTransport, repo_id: REPO_ID });
    } catch (e) {
      caught = e;
    }
    const actions = nextActionsOf(caught);
    assert.equal(actions.length, 2, "the existing remedy PLUS the cross-profile hint, never a replacement");
    assert.ok(actions.some((a) => /restore ~\/.config\/run402\/gitvault/.test(a.action)));
    assert.ok(actions.some((a) => /'platform-deploy'/.test(a.action) && /--wallet/.test(a.action) && /RUN402_WALLET/.test(a.action)));
  });
});

describe("GITVAULT_REPO_STATE_MISSING (identity present, no repo file)", () => {
  it("carries no next_actions when no other local profile holds the key — unchanged from before #564", () => {
    const ks = GitvaultKeystore.open({ rootDir: join(tmp, "active-keystore") });
    ks.ensureIdentity();
    let caught: unknown;
    try {
      GitvaultVault.open({ keystore: ks, transport: untouchedTransport, repo_id: REPO_ID });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof LocalError);
    assert.equal((caught as LocalError).code, "GITVAULT_REPO_STATE_MISSING");
    assert.deepEqual(nextActionsOf(caught), []);
  });

  it("gets the cross-profile hint when another local profile holds this repo's key", () => {
    dropRepoFileUnderProfile("staging", REPO_ID);
    const ks = GitvaultKeystore.open({ rootDir: join(tmp, "active-keystore") });
    ks.ensureIdentity();
    let caught: unknown;
    try {
      GitvaultVault.open({ keystore: ks, transport: untouchedTransport, repo_id: REPO_ID });
    } catch (e) {
      caught = e;
    }
    const actions = nextActionsOf(caught);
    assert.equal(actions.length, 1);
    assert.ok(/'staging'/.test(actions[0]!.action) && /--wallet/.test(actions[0]!.action) && /RUN402_WALLET/.test(actions[0]!.action));
  });
});
