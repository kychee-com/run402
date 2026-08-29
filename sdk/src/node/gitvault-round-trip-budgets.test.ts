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
 * Budgets tightened per design D3's phase table, then again by
 * gitvault-force-spelling-and-pin-fold (the resolution fold: an
 * id-carrying pin resolves OFFLINE, so the budgets now count across every
 * transport session a verb spawns — address resolution included — and
 * each network-verb budget dropped by the one folded read): push `state 1
 * → inline-upload 1 → admit 1 → readback 1 = 4` (budget ≤ 6),
 * one-generation pull `state 1 → WAL presign+GET 2 = 3` (budget ≤ 4),
 * up-to-date fetch `state 1 = 1` (budget ≤ 2). Headroom in each budget
 * covers the `GET …/state` carrier URL arm (a carrier over the inline
 * cap) that this fixture's `getState` never takes (see the counting
 * helper's own doc comment) — a genuinely tighter equality assertion
 * would overfit to that fixture limitation.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITVAULT_TRANSPORT_CONCURRENCY, GitvaultVault } from "./gitvault-publication.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { pinGitvaultRepo, resolveGitvaultAddress } from "./gitvault-address.js";
import { commitFile, git, makeVault } from "./gitvault-memory-transport.test.js";
import { GitvaultOpCounter, assertOpBudget, countingGitvaultTransport } from "./gitvault-transport-counter.test-helper.js";

/**
 * gitvault-clone-scaling: an overlap gauge on `getObject` — the honest
 * instrument for the catch-up contract, which is stated in SEQUENCED DEPTH.
 * The op counter cannot see concurrency (six overlapped GETs count 6 either
 * way); this proxy records the maximum number of simultaneously in-flight
 * head reads, with a 2ms delay so genuinely-concurrent calls provably pile
 * up. Head bytes CANNOT batch through `getObjects` — the object-reads
 * presign is carrier-only by wire design — so concurrency of the direct
 * reads IS the mechanism under test.
 */
function gaugedTransport(inner: ReturnType<typeof countingGitvaultTransport>): { transport: ReturnType<typeof countingGitvaultTransport>; gauge: { max: number } } {
  const state = { inflight: 0, max: 0 };
  const transport = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "getObject" || typeof value !== "function") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return async (...args: unknown[]) => {
        state.inflight += 1;
        state.max = Math.max(state.max, state.inflight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return await Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
        } finally {
          state.inflight -= 1;
        }
      };
    },
  });
  return { transport, gauge: state };
}

/** A vault handle bound to the SAME keystore/repo (so it shares local pins and the D3 object cache) as `f.vault`, but whose network calls are counted. */
function countedVaultFor(f: Awaited<ReturnType<typeof makeVault>>, counter: GitvaultOpCounter): GitvaultVault {
  return GitvaultVault.open({ keystore: f.keystore, transport: countingGitvaultTransport(f.transport, counter), repo_id: f.repoId, repo_dir: f.repoDir });
}

describe("gitvault round-trip budgets (client-surface spec's counted contract)", () => {
  it("small push: one branch, pin current, allocated vault, WAL form, ≤3 objects — budget 6", async (t) => {
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
    assertOpBudget(counter, 6, "small push");
  });

  it("address resolution on an id-carrying pin adds ZERO operations; a legacy pin adds exactly one (gitvault-force-spelling-and-pin-fold)", async (t) => {
    const f = await makeVault();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const address = { org_id: "11111111-1111-4111-8111-111111111111", project_id: "prj_1" };

    // Legacy (pre-fold) pin shape — repo_id only: the ONE self-upgrading
    // validation read, which also rewrites the pin with the resolved ids.
    await pinGitvaultRepo(f.repoDir, f.repoId);
    const legacyCounter = new GitvaultOpCounter();
    const legacy = await resolveGitvaultAddress({ keystore: f.keystore, transport: countingGitvaultTransport(f.transport, legacyCounter), address, repo_dir: f.repoDir });
    assert.equal(legacy.offline, false);
    assertOpBudget(legacyCounter, 1, "legacy-pin self-upgrade");

    // The id-carrying pin the upgrade just wrote: resolution is OFFLINE, and
    // the WHOLE verb — resolution + push — fits the end-to-end budget with
    // resolution contributing nothing (the spec's "counted across every
    // transport session a single verb spawns, address resolution included").
    const counter = new GitvaultOpCounter();
    const countedTransport = countingGitvaultTransport(f.transport, counter);
    const resolution = await resolveGitvaultAddress({ keystore: f.keystore, transport: countedTransport, address, repo_dir: f.repoDir });
    assert.equal(resolution.offline, true);
    assert.equal(counter.total, 0, "an id-carrying pin resolves with zero transport operations");
    const c2 = await commitFile(f.repoDir, "r.txt", "r\n");
    const vault = GitvaultVault.open({ keystore: f.keystore, transport: countedTransport, repo_id: resolution.repo_id, repo_dir: f.repoDir });
    await vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    assertOpBudget(counter, 6, "end-to-end push (resolution + verb, one counter)");
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

  it("fetch/pull: exactly one new WAL generation above the materialized pin — budget 4", async (t) => {
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
    assertOpBudget(counter, 4, "one-generation pull");
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

// ─── gitvault-clone-scaling (bench P2): the catch-up walk is page-bounded ────

describe("gitvault chain catch-up budget (gitvault-clone-scaling)", () => {
  /** One shared 251-generation vault (main + 250 ref-only branches — empty object deltas, so generation count is the ONLY thing growing). Built once; both scenarios below read it without mutating vault state. */
  let f: Awaited<ReturnType<typeof makeVault>>;
  before(async () => {
    f = await makeVault();
    const c1 = await git(f.repoDir, ["rev-parse", "HEAD"]);
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    for (let i = 1; i <= 250; i++) {
      const ref = `refs/heads/b${String(i).padStart(3, "0")}`;
      await f.vault.push({ transaction: { updates: [{ ref, expected_old_oid: null, new_oid: c1, force: false }] } });
    }
  });
  after(() => rmSync(f.root, { recursive: true, force: true }));

  it("a 251-generation cold-cache catch-up batches each page's head bytes and carrier frames: singles do not scale with G", async () => {
    // A cold checkout: the repo keys without any pin or cached heads — the
    // clone shape (same seeding the epoch-reader fixture uses).
    const repo = f.keystore.readRepo(f.repoId)!;
    const coldKeystore = GitvaultKeystore.open({ rootDir: join(f.root, "ks-cold") });
    coldKeystore.ensureIdentity();
    coldKeystore.saveRepo({
      repo_id: f.repoId, org_id: repo.org_id, project_id: repo.project_id,
      k_repo_hex: repo.k_repo_hex, epoch: repo.epoch, genesis_sha256: repo.genesis_sha256,
      head_pin: null, last_ref_transaction: null, provenance: "restored_from_envelope",
    });
    const counter = new GitvaultOpCounter();
    const { transport, gauge } = gaugedTransport(countingGitvaultTransport(f.transport, counter));
    const cold = GitvaultVault.open({ keystore: coldKeystore, transport, repo_id: f.repoId, repo_dir: null });
    const m = await cold.materialize();
    assert.equal(Object.keys(m.refs).length, 251, "the walk really covered all 251 generations");

    const byKind = counter.byKind();
    // The page-bounded contract: ⌈251/1000⌉ = 1 listing page → head bytes as
    // OVERLAPPED direct reads (the object-reads presign is carrier-only by
    // wire design, so heads cannot batch — the gauge below is the depth
    // instrument), plus ONE batched carrier-frame presign. The pre-P2 walk
    // paid ~251 STRICTLY SEQUENTIAL head reads plus ~251 sequenced per-head
    // carrier presigns; op COUNT stays ~3·G either way — depth is what
    // changed.
    assert.equal(byKind["object-reads-batch(presign)"] ?? 0, 1, `one batched carrier presign per page — breakdown: ${JSON.stringify(byKind)}`);
    assert.equal(byKind["object-reads-batch(get)"] ?? 0, 2 * 251, "every carrier frame rides the one batch");
    assert.ok((byKind["generation-read"] ?? 0) <= 255, `each head read exactly once — breakdown: ${JSON.stringify(byKind)}`);
    assert.ok((byKind["listHeads"] ?? 0) <= 2, `listing reads are page-bounded — breakdown: ${JSON.stringify(byKind)}`);
    assert.ok(gauge.max >= 4, `head reads must overlap (bounded concurrency ${GITVAULT_TRANSPORT_CONCURRENCY}), observed max in-flight ${gauge.max}`);
    assertOpBudget(counter, 3 * 251 + 15, "cold 251-generation catch-up");
  });

  it("a fresh-target restore batches the backward head walk the same way: singles do not scale with G", async (t) => {
    // The OTHER cold-clone shape: the keystore is current (pin at newest),
    // the TARGET repository is empty — `git clone` with a standing profile.
    // restoreObjectsInto's backward walk derives every predecessor path
    // locally, so its bytes batch in page windows while hash-chaining stays
    // strictly ordered.
    const target = mkdtempSync(join(tmpdir(), "run402-gitvault-budget-coldclone-"));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    await git(target, ["init", "-q", "--bare", "."]);
    const counter = new GitvaultOpCounter();
    const { transport, gauge } = gaugedTransport(countingGitvaultTransport(f.transport, counter));
    const vault = GitvaultVault.open({ keystore: f.keystore, transport, repo_id: f.repoId, repo_dir: f.repoDir });
    const restored = await vault.restoreObjectsInto(target);
    assert.equal(Object.keys(restored.refs).length, 251, "the restore really spans all 251 generations");

    const byKind = counter.byKind();
    assert.ok(gauge.max >= 4, `backward-walk head reads must overlap (bounded concurrency ${GITVAULT_TRANSPORT_CONCURRENCY}), observed max in-flight ${gauge.max}`);
    assert.ok((byKind["object-reads-batch(presign)"] ?? 0) <= 6, `carrier/WAL batches only — breakdown: ${JSON.stringify(byKind)}`);
  });
});
