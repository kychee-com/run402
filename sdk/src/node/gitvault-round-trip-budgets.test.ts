/**
 * gitvault-client-round-trips / gitvault-composite-state-read — the counted
 * budget contract (client-surface spec's "Per-verb transport-operation
 * budgets are a counted contract"; tasks 1.2 + 7.1, tightened by
 * gitvault-composite-state-read design D3 + task 4.3).
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
 *
 * Budgets tightened per design D3's phase table: push `state 1 → inline-
 * upload 1 → admit 1 → readback 1 = 4` (budget ≤ 7), one-generation pull
 * `state 1 → WAL presign+GET 2 = 3` (budget ≤ 5), up-to-date fetch
 * `state 1 = 1` (budget ≤ 2). Headroom in each budget covers the
 * `GET …/state` carrier URL arm (a carrier over the inline cap) that this
 * fixture's `getState` never takes (see the counting helper's own doc
 * comment) — a genuinely tighter equality assertion would overfit to that
 * fixture limitation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
  it("small push: one branch, pin current, allocated vault, WAL form, ≤3 objects — budget 7", async (t) => {
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
    assertOpBudget(counter, 7, "small push");
  });

  it("small push with one object above the 256 KiB inline cap: presigned upload path — budget 12", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });

    // Random (incompressible) content, comfortably above the 256 KiB inline
    // cap even after git's own pack compression — proves the WAL PACK
    // itself, not just the source file, crosses
    // GITVAULT_INLINE_UPLOAD_MAX_OBJECT_BYTES, forcing the upload back onto
    // the presigned session+PUT+finalize shape design D2 defines for it.
    const big = randomBytes(500_000).toString("base64");
    const c2 = await commitFile(f.repoDir, "big.bin", big);

    const counter = new GitvaultOpCounter();
    const vault = countedVaultFor(f, counter);
    await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    const byKind = counter.byKind();
    assert.equal(byKind["upload-inline"], undefined, "an oversize object must take the presigned path, never inline");
    assert.ok((byKind["upload-session"] ?? 0) >= 1, "the presigned session was opened");
    // Budget 12 pins the ORIGINAL (pre-composite-state-read) small-push
    // ceiling — the state-read savings the other scenarios rely on do not
    // apply to the object itself here, but `materialize()`'s own chain
    // verification still rides the D1 fast path, so this stays well inside
    // the old budget rather than needing a new, wider one.
    assertOpBudget(counter, 12, "small push with an oversize object");
  });

  it("fetch/pull: exactly one new WAL generation above the materialized pin — budget 5", async (t) => {
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
    assertOpBudget(counter, 5, "one-generation pull");
  });

  it("fetch: already up to date — budget 2", async (t) => {
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
    assertOpBudget(counter, 2, "up-to-date fetch");
  });
});
