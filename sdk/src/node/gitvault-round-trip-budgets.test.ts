/**
 * gitvault-client-round-trips — the counted budget contract (client-surface
 * spec's "Per-verb transport-operation budgets are a counted contract";
 * tasks 1.2 + 7.1).
 *
 * Each scenario below is the spec's DEFINED shape, measured through
 * {@link countingGitvaultTransport} (task 1.1's counting wrapper) against
 * `GitvaultMemoryTransport` — deterministic, geography-independent, and
 * immune to real network jitter. A warm-up phase runs UNCOUNTED (a fresh
 * `GitvaultOpCounter`, reset after it) so each measured call starts from
 * the realistic state its scenario names ("authenticated pin current" for
 * push, "already restored once" for the two fetch shapes) rather than a
 * cold vault's first-ever contact — the SAME distinction the design's own
 * phase table draws between a first push (allocation + first materialize)
 * and a REPEAT one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitvaultVault } from "./gitvault-publication.js";
import { commitFile, git, makeVault } from "./gitvault-memory-transport.test.js";
import { GitvaultOpCounter, assertOpBudget, countingGitvaultTransport } from "./gitvault-transport-counter.test-helper.js";

/** A vault handle bound to the SAME keystore/repo (so it shares local pins and the D3 object cache) as `f.vault`, but whose network calls are counted. */
function countedVaultFor(f: Awaited<ReturnType<typeof makeVault>>, counter: GitvaultOpCounter): GitvaultVault {
  return GitvaultVault.open({ keystore: f.keystore, transport: countingGitvaultTransport(f.transport, counter), repo_id: f.repoId, repo_dir: f.repoDir });
}

describe("gitvault round-trip budgets (client-surface spec's counted contract)", () => {
  it("small push: one branch, pin current, allocated vault, WAL form, ≤3 objects — budget 12", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    // Warm-up push (uncounted): establishes "pin current" — a vault that
    // has already been pushed to once, not the first-ever push (which pays
    // allocation and a cold materialize the spec's budget explicitly
    // excludes — see the design's own phase table split).
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });

    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    const counter = new GitvaultOpCounter();
    const vault = countedVaultFor(f, counter);
    const published = await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    assert.equal(published.form, "wal");
    assertOpBudget(counter, 12, "small push");
  });

  it("fetch/pull: exactly one new WAL generation above the materialized pin — budget 8", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-budget-pull-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    mkdirSync(target, { recursive: true });
    await git(target, ["init", "-q", "--bare", "."]);
    await f.vault.restoreObjectsInto(target); // warm-up: establishes restored_through at generation 1

    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });

    const counter = new GitvaultOpCounter();
    const vault = countedVaultFor(f, counter);
    const restored = await vault.restoreObjectsInto(target);
    assert.deepEqual(restored.refs, { "refs/heads/main": c2 });
    assertOpBudget(counter, 8, "one-generation pull");
  });

  it("fetch: already up to date — budget 3", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-budget-uptodate-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    mkdirSync(target, { recursive: true });
    await git(target, ["init", "-q", "--bare", "."]);
    await f.vault.restoreObjectsInto(target); // warm-up

    const counter = new GitvaultOpCounter();
    const vault = countedVaultFor(f, counter);
    const restored = await vault.restoreObjectsInto(target);
    assert.deepEqual(restored.refs, { "refs/heads/main": c1 });
    assertOpBudget(counter, 3, "up-to-date fetch");
  });
});
