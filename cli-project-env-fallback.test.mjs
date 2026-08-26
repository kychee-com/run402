/**
 * cli-project-env-fallback.test.mjs — RUN402_PROJECT_ID is the canonical
 * project-selection env var everywhere in the CLI; RUN402_PROJECT is a
 * deprecated, read-aliased fallback (decision 3.13).
 *
 * Bug: `cli/lib/cdn.mjs` and `cli/lib/assets.mjs` historically read ONLY
 * `RUN402_PROJECT` — a different, undocumented name from the canonical
 * `RUN402_PROJECT_ID` every other project-scoped command reads (`config.mjs`
 * `resolveProject`/`resolveProjectId`, `org-context.mjs`, `gitvault-target.mjs`,
 * `logs.mjs`, `dev.mjs`, `deploy-v2.mjs`, …). A user who exported the
 * canonical `RUN402_PROJECT_ID` and ran `run402 assets ls` or
 * `run402 cdn wait-fresh` got a silent no-op: the export did nothing, and
 * resolution quietly fell through to the active project instead.
 *
 * The fix, `resolveProjectIdAllowingLegacyEnv` in `cli/lib/config.mjs`,
 * checks `RUN402_PROJECT_ID` first and only ever falls back to the
 * deprecated `RUN402_PROJECT` alias when `RUN402_PROJECT_ID` is unset AND no
 * explicit id (e.g. `--project`) was given. When the alias is what actually
 * resolves the project, exactly one deprecation line goes to stderr —
 * stdout stays pure JSON per the CLI's pipe contract.
 *
 * This module is tested directly (in-process, no subprocess, no network) —
 * `resolveProjectIdAllowingLegacyEnv` is pure env-var resolution plus a
 * stderr side effect, so a unit test against the exported function is more
 * direct and less flaky than driving it through the full `assets`/`cdn`
 * subcommand dispatch.
 *
 * Run:  node --test cli-project-env-fallback.test.mjs
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-project-env-fallback-"));
process.env.RUN402_CONFIG_DIR = tempDir;

const originalProjectId = process.env.RUN402_PROJECT_ID;
const originalProjectAlias = process.env.RUN402_PROJECT;
const originalStderrWrite = process.stderr.write;

let stderrChunks = [];

function captureStderr() {
  stderrChunks = [];
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
}

function restoreStderr() {
  process.stderr.write = originalStderrWrite;
}

let resolveProjectIdAllowingLegacyEnv;

before(async () => {
  ({ resolveProjectIdAllowingLegacyEnv } = await import("./cli/lib/config.mjs"));
});

after(() => {
  restoreStderr();
  if (originalProjectId === undefined) delete process.env.RUN402_PROJECT_ID;
  else process.env.RUN402_PROJECT_ID = originalProjectId;
  if (originalProjectAlias === undefined) delete process.env.RUN402_PROJECT;
  else process.env.RUN402_PROJECT = originalProjectAlias;
  delete process.env.RUN402_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.RUN402_PROJECT_ID;
  delete process.env.RUN402_PROJECT;
  captureStderr();
});

afterEach(() => {
  restoreStderr();
});

describe("resolveProjectIdAllowingLegacyEnv — RUN402_PROJECT_ID canonical, RUN402_PROJECT deprecated alias", () => {
  it("RUN402_PROJECT_ID wins when both env vars are set, with no deprecation note", () => {
    process.env.RUN402_PROJECT_ID = "prj_canonical";
    process.env.RUN402_PROJECT = "prj_legacy";

    const id = resolveProjectIdAllowingLegacyEnv(undefined);

    assert.equal(id, "prj_canonical");
    assert.equal(
      stderrChunks.join(""),
      "",
      `must not print a deprecation note when RUN402_PROJECT_ID resolved; got: ${JSON.stringify(stderrChunks)}`,
    );
  });

  it("RUN402_PROJECT resolves as a fallback when RUN402_PROJECT_ID is unset, printing exactly one deprecation note", () => {
    process.env.RUN402_PROJECT = "prj_legacy_only";

    const id = resolveProjectIdAllowingLegacyEnv(undefined);

    assert.equal(id, "prj_legacy_only");
    assert.equal(
      stderrChunks.length,
      1,
      `expected exactly one stderr write, got: ${JSON.stringify(stderrChunks)}`,
    );
    assert.match(stderrChunks[0], /RUN402_PROJECT is deprecated/);
    assert.match(stderrChunks[0], /RUN402_PROJECT_ID/);
    // The note must land on stderr, never stdout — verified structurally:
    // resolveProjectIdAllowingLegacyEnv calls process.stderr.write, and this
    // test only intercepts that stream, so any note at all proves the point.
  });

  it("RUN402_PROJECT_ID alone resolves the project, with no deprecation note", () => {
    process.env.RUN402_PROJECT_ID = "prj_only_canonical";

    const id = resolveProjectIdAllowingLegacyEnv(undefined);

    assert.equal(id, "prj_only_canonical");
    assert.equal(stderrChunks.length, 0, `expected no stderr output, got: ${JSON.stringify(stderrChunks)}`);
  });

  it("an explicit id (e.g. --project) wins over both env vars, with no deprecation note", () => {
    process.env.RUN402_PROJECT = "prj_legacy_ignored";
    process.env.RUN402_PROJECT_ID = "prj_canonical_ignored";

    const id = resolveProjectIdAllowingLegacyEnv("prj_explicit_flag");

    assert.equal(id, "prj_explicit_flag");
    assert.equal(
      stderrChunks.length,
      0,
      `an explicit id must win silently over both env vars; got: ${JSON.stringify(stderrChunks)}`,
    );
  });

  it("an explicit id wins over RUN402_PROJECT alone, with no deprecation note", () => {
    process.env.RUN402_PROJECT = "prj_legacy_ignored_too";

    const id = resolveProjectIdAllowingLegacyEnv("prj_explicit_flag_2");

    assert.equal(id, "prj_explicit_flag_2");
    assert.equal(
      stderrChunks.length,
      0,
      `an explicit id must not trigger the legacy-env deprecation note even when RUN402_PROJECT is set; got: ${JSON.stringify(stderrChunks)}`,
    );
  });
});
