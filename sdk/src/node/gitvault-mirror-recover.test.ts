/**
 * gitvault-mirror-and-recover — behavioral tests for groups 2 (mirror) and 3
 * (recovery), tasks 2.5 and 3.6.
 *
 * Reuses the project's own `GitvaultMemoryTransport` fixture (`makeVault` /
 * `commitFile` / `git`) to build REAL, protocol-valid vaults — real signed
 * heads, real encrypted WAL/checkpoint objects — rather than hand-rolling
 * fixture bytes. The mirror is then a `DirectoryMirrorBackend` seeded
 * directly from the fixture's in-memory object store (a raw copy of stored
 * bytes is exactly what a completed `mirror sync` produces, and testing the
 * torn-mirror property is about WRITE ORDER on the destination, not about
 * how the bytes were fetched — see `gitvault-mirror.ts`'s own module doc).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcs, sha256Hex } from "../namespaces/gitvault.crypto.js";
import { gitvaultPaths } from "./gitvault-publication.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { commitFile, git, makeVault } from "./gitvault-memory-transport.test.js";
import { DirectoryMirrorBackend, type GitvaultMirrorBackend } from "./gitvault-mirror-backend.js";
import { generationRouteForKey, mirrorPushForGeneration, mirrorSync, objectReadRequestForEntry, planMirrorWrite, type GitvaultObjectEntry } from "./gitvault-mirror.js";
import { adjudicateAbsences, discoverAndVerifyChain, recoverGitvaultMirror, verifyGitvaultMirror } from "./gitvault-recover.js";

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * `GitvaultMemoryTransport` stores every upload at the SDK's OWN client-local
 * `path` string (`gitvault-memory-transport.test.ts` `uploadObjects`: `this.key(repo_id,
 * o.path)`), never re-deriving the gateway's independent §3 key the way the
 * real gateway does. For every kind except `key_envelope` those two
 * spellings happen to be byte-identical (`wal/<id>.pack.enc`,
 * `refs/<id>.enc`, …) — but for `key_envelope` they are NOT: the SDK's
 * `gitvault-creation-journal.ts` labels its upload manifest entry
 * `envelopes/<epoch>/<fp>` (client-local addressing, "never rides the wire" —
 * its own doc comment), while the GATEWAY's real key (`upload-sessions.ts`
 * `UPLOADABLE_KINDS.key_envelope.key()`, mirrored in `storage-keys.ts`
 * `objectKeyFor`) is `key-envelopes/<epoch>/<fp>.env`, matching protocol §3
 * exactly. Trusting the fixture's raw key verbatim would validate
 * `gitvault-mirror.ts`/`gitvault-recover.ts` against a spelling no REAL
 * mirror (synced from the REAL objects listing) would ever contain — the
 * "self-consistent fiction" this translation exists to close. Every OTHER
 * consumer of this helper below therefore sees gateway-true keys, the same
 * as a real `mirror sync` would produce.
 */
function toGatewayTrueKey(key: string): string {
  const m = /^envelopes\/([0-9a-f]{16})\/(ek_[0-9a-f]{32})$/.exec(key);
  return m ? `key-envelopes/${m[1]}/${m[2]}.env` : key;
}

/** Every entry the fixture's transport holds for one vault, keyed relative to the vault root (§3 layout) — exactly the shape `GET .../objects` returns (gateway-true keys — see {@link toGatewayTrueKey}). */
function transportEntries(transport: { objects: Map<string, Uint8Array> }, repoId: string): Array<{ key: string; bytes: Uint8Array }> {
  const out: Array<{ key: string; bytes: Uint8Array }> = [];
  const prefix = `${repoId}/`;
  for (const [k, bytes] of transport.objects) {
    if (k.startsWith(prefix)) out.push({ key: toGatewayTrueKey(k.slice(prefix.length)), bytes });
  }
  return out;
}

async function seedBackend(backend: GitvaultMirrorBackend, entries: readonly { key: string; bytes: Uint8Array }[]): Promise<void> {
  for (const e of entries) await backend.putCreateOnly(e.key, e.bytes);
}

// ─── Key-shape conformance (protocol §3) ──────────────────────────────────────
//
// Pins the mirror/recover addressing logic against the GATEWAY's real §3 key
// builders for every stored kind — `packages/gateway/src/services/gitvault/
// storage-keys.ts` (`objectKeyFor`, `headKey`, `admissionRecordKey`) and
// `upload-sessions.ts` (`UPLOADABLE_KINDS.key_envelope.key`), read directly
// from the run402-private worktree named in the gitvault-mirror-and-recover
// brief. This is the standing guard against the exact bug this test file
// once carried: an SDK-internal label (`gitvault-creation-journal.ts`'s
// client-local `envelopes/<epoch>/<fp>` upload-manifest path) silently
// substituting for the real wire key (`key-envelopes/<epoch>/<fp>.env`) in
// mirror/recovery addressing. Every row below is the REPO-RELATIVE key (the
// full gateway key with `source/<repo_id>/` stripped — exactly what a synced
// mirror and the objects listing both use).
const SAMPLE_ID = "0".repeat(31) + "1"; // a syntactically valid 32-hex id body
const KEY_SHAPE_TABLE: ReadonlyArray<{
  kind: string;
  key: string;
  expectRead: { object_kind: string; object_id?: string; epoch?: string; recipient_fingerprint?: string };
}> = [
  { kind: "wal_pack", key: `wal/wal_${SAMPLE_ID}.pack.enc`, expectRead: { object_kind: "wal_pack", object_id: `wal_${SAMPLE_ID}` } },
  { kind: "ref_state", key: `refs/refs_${SAMPLE_ID}.enc`, expectRead: { object_kind: "ref_state", object_id: `refs_${SAMPLE_ID}` } },
  { kind: "retention_roots", key: `retention/rr_${SAMPLE_ID}.enc`, expectRead: { object_kind: "retention_roots", object_id: `rr_${SAMPLE_ID}` } },
  { kind: "checkpoint_manifest", key: `checkpoints/chk_${SAMPLE_ID}.manifest.enc`, expectRead: { object_kind: "checkpoint_manifest", object_id: `chk_${SAMPLE_ID}` } },
  { kind: "checkpoint_pack", key: `checkpoints/ckp_${SAMPLE_ID}.pack.enc`, expectRead: { object_kind: "checkpoint_pack", object_id: `ckp_${SAMPLE_ID}` } },
  { kind: "checkpoint_claim_set", key: `checkpoints/ccs_${SAMPLE_ID}.claims.json`, expectRead: { object_kind: "checkpoint_claim_set", object_id: `ccs_${SAMPLE_ID}` } },
  { kind: "maintenance_stage_claim_set", key: `maintenance/msc_${SAMPLE_ID}.stage.json`, expectRead: { object_kind: "maintenance_stage_claim_set", object_id: `msc_${SAMPLE_ID}` } },
  { kind: "maintenance_stage_page", key: `maintenance/msp_${SAMPLE_ID}.page.json`, expectRead: { object_kind: "maintenance_stage_page", object_id: `msp_${SAMPLE_ID}` } },
  { kind: "verifier_receipt", key: `verifier-receipts/vr_${SAMPLE_ID}.json`, expectRead: { object_kind: "verifier_receipt", object_id: `vr_${SAMPLE_ID}` } },
  { kind: "retention_cutoff", key: `retention/rc_${SAMPLE_ID}.ticket.json`, expectRead: { object_kind: "retention_cutoff", object_id: `rc_${SAMPLE_ID}` } },
  { kind: "maintenance_completion_cut", key: `maintenance/cuts/adm_${SAMPLE_ID}.json`, expectRead: { object_kind: "maintenance_completion_cut", object_id: `adm_${SAMPLE_ID}` } },
  { kind: "prune_intent", key: `prune/pi_${SAMPLE_ID}.intent.json`, expectRead: { object_kind: "prune_intent", object_id: `pi_${SAMPLE_ID}` } },
  { kind: "prune_completion", key: `prune/pi_${SAMPLE_ID}.completion.json`, expectRead: { object_kind: "prune_completion", object_id: `pi_${SAMPLE_ID}` } },
  { kind: "maintenance_cycle_issuance", key: `maintenance/issued/mc_${SAMPLE_ID}.json`, expectRead: { object_kind: "maintenance_cycle_issuance", object_id: `mc_${SAMPLE_ID}` } },
  { kind: "maintenance_cycle_terminal", key: `maintenance/terminals/mc_${SAMPLE_ID}.terminal.json`, expectRead: { object_kind: "maintenance_cycle_terminal", object_id: `mc_${SAMPLE_ID}` } },
  // key_envelope: path-addressed by (epoch, recipient_fingerprint), NOT the
  // SDK's own client-local `envelopes/<epoch>/<fp>` upload-manifest label —
  // see `toGatewayTrueKey`'s doc comment above.
  { kind: "key_envelope", key: `key-envelopes/0000000000000001/ek_${SAMPLE_ID}.env`, expectRead: { object_kind: "key_envelope", epoch: "0000000000000001", recipient_fingerprint: `ek_${SAMPLE_ID}` } },
];

describe("gitvault mirror/recover key-shape conformance (protocol §3)", () => {
  for (const row of KEY_SHAPE_TABLE) {
    it(`${row.kind}: ${row.key}`, () => {
      const entry: GitvaultObjectEntry = { key: row.key, object_kind: row.kind, sha256: "0".repeat(64), size_bytes: "1" };
      assert.deepEqual(objectReadRequestForEntry(entry), row.expectRead, `object-reads request built for ${row.kind} does not match the gateway's real §3 key shape`);
      // Every non-generation kind must NOT be misidentified as a head/admissions route.
      assert.equal(generationRouteForKey(row.key), null, `${row.key} was misidentified as a generation-addressed (head/admissions) route`);
    });
  }

  it("head/admissions: generation-addressed, never routed through object-reads", () => {
    assert.deepEqual(generationRouteForKey("head/0000000000000005"), { route: "heads", generation: "0000000000000005" });
    assert.deepEqual(generationRouteForKey("admissions/0000000000000005"), { route: "admissions", generation: "0000000000000005" });
  });

  it("a mirror seeded from the fixture's transport carries ONLY gateway-true key_envelope keys — the fixture's own client-local spelling never leaks through", async () => {
    const f = await makeVault();
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: await commitFile(f.repoDir, "a.txt", "a\n"), force: false }] } });
    const entries = transportEntries(f.transport, f.repoId);
    const envelopeEntries = entries.filter((e) => e.key.includes("envelope"));
    assert.ok(envelopeEntries.length > 0, "the fixture must have written at least one key_envelope object for this assertion to mean anything");
    for (const e of envelopeEntries) {
      assert.match(e.key, /^key-envelopes\/[0-9a-f]{16}\/ek_[0-9a-f]{32}\.env$/, `${e.key} is not the gateway-true key_envelope shape`);
    }
  });
});

// ─── Group 3 — recovery engine (task 3.6) ─────────────────────────────────────

describe("gitvault recovery engine (task 3.6)", () => {
  it("golden-vault fixture: recovered byte-exact — refs, HEAD, and generation all match the live vault", async () => {
    const f = await makeVault();
    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });

    const mirrorRoot = scratchDir("run402-mirror-golden-");
    const backend = new DirectoryMirrorBackend(mirrorRoot);
    await seedBackend(backend, transportEntries(f.transport, f.repoId));

    const outDir = scratchDir("run402-recovered-golden-");
    const result = await recoverGitvaultMirror({ backend, out_dir: outDir, keystore: f.keystore });

    assert.equal(result.mode, "recovered");
    assert.equal(result.repo_id, f.repoId);
    assert.equal(result.chain_break, null);
    assert.equal(result.data_loss_detected, false);
    assert.equal(result.recovered_generation, "0000000000000002");
    assert.equal(result.refs["refs/heads/main"], c2);
    assert.equal(result.head_target.kind, "symref");
    assert.match(result.validity_not_freshness, /validity, never freshness/);
    assert.match(result.keystore_still_required, /recovers nothing/);

    const head = (await git(outDir, ["rev-parse", "HEAD"])).trim();
    assert.equal(head, c2);
    const symref = (await git(outDir, ["symbolic-ref", "HEAD"])).trim();
    assert.equal(symref, "refs/heads/main");

    rmSync(mirrorRoot, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it("keyless mode never touches key material and still reports a recoverable generation + inventory", async () => {
    const f = await makeVault();
    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });

    const mirrorRoot = scratchDir("run402-mirror-keyless-");
    const backend = new DirectoryMirrorBackend(mirrorRoot);
    await seedBackend(backend, transportEntries(f.transport, f.repoId));

    // A FRESH keystore with no identity and no receipt at all — proves the
    // walk never needed one; the recovery receipt is passed explicitly
    // instead, exercising the "receipt" pin trust path independent of any
    // keystore-resident copy.
    const bareKeystoreRoot = scratchDir("run402-bare-keystore-");
    const bareKeystore = GitvaultKeystore.open({ rootDir: bareKeystoreRoot });
    const receipt = f.keystore.readRecoveryReceipt(f.repoId);
    assert.ok(receipt, "the creating keystore must hold a recovery receipt to pin against");

    const report = await verifyGitvaultMirror(backend, { keystore: bareKeystore, recovery_receipt: receipt! });
    assert.equal(report.mode, "keyless_verify");
    assert.equal(report.recovered_generation, "0000000000000001");
    assert.equal(report.pin_trust, "receipt");
    assert.equal(report.data_loss_detected, false);
    assert.ok(report.inventory.ref_state >= 1);

    rmSync(mirrorRoot, { recursive: true, force: true });
    rmSync(bareKeystoreRoot, { recursive: true, force: true });
  });

  it("substituted-vault pin refusal: a recovery receipt from a DIFFERENT vault refuses outright, never falling back to 'whatever verifies'", async () => {
    const f = await makeVault();
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: await commitFile(f.repoDir, "a.txt", "a\n"), force: false }] } });
    const other = await makeVault();

    const mirrorRoot = scratchDir("run402-mirror-substituted-");
    const backend = new DirectoryMirrorBackend(mirrorRoot);
    await seedBackend(backend, transportEntries(f.transport, f.repoId));

    const foreignReceipt = other.keystore.readRecoveryReceipt(other.repoId);
    assert.ok(foreignReceipt);

    await assert.rejects(
      discoverAndVerifyChain({ backend, recovery_receipt: foreignReceipt! }),
      (e: unknown) => (e as { code?: string }).code === "VAULT_CREATION_CONFLICT",
    );

    rmSync(mirrorRoot, { recursive: true, force: true });
  });

  it("pruned-object adjudication: an absence covered by a stored prune_intent is named 'intentionally_pruned', never treated as a chain-verified gap", async () => {
    const backend = new DirectoryMirrorBackend(scratchDir("run402-mirror-prune-"));
    const pruneCore = { object_id: "pi_" + "a".repeat(32), delete_set: [{ object_id: "wal_" + "b".repeat(32) }] };
    await backend.putCreateOnly("prune/pi_test.intent.json", jcs({ object_id: pruneCore.object_id, core: pruneCore }));
    const required = [
      { key: gitvaultPaths.wal("wal_" + "b".repeat(32)), object_id: "wal_" + "b".repeat(32), kind: "wal_pack" as const },
      { key: gitvaultPaths.wal("wal_" + "c".repeat(32)), object_id: "wal_" + "c".repeat(32), kind: "wal_pack" as const },
    ];
    const absences = await adjudicateAbsences(backend, required);
    assert.equal(absences.length, 2);
    const pruned = absences.find((a) => a.object_id === "wal_" + "b".repeat(32));
    const unexplained = absences.find((a) => a.object_id === "wal_" + "c".repeat(32));
    assert.equal(pruned?.adjudication, "intentionally_pruned");
    assert.equal(pruned?.prune_intent_object_id, pruneCore.object_id);
    assert.equal(unexplained?.adjudication, "unexplained_absence");
    assert.equal(unexplained?.prune_intent_object_id, null);
  });

  it("unexplained-absence fallback: a genuinely missing object with NO covering prune intent falls back one generation and NAMES the loss — never a silent skip", async () => {
    const f = await makeVault();
    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    const gen2 = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });
    assert.equal(gen2.form, "wal");

    const mirrorRoot = scratchDir("run402-mirror-loss-");
    const backend = new DirectoryMirrorBackend(mirrorRoot);
    const entries = transportEntries(f.transport, f.repoId);
    // Drop generation 2's OWN wal pack — present in gen2's head.wal_entries — with NO prune intent covering it.
    const gen2WalId = gen2.head.wal_entries[0]!.object_id;
    const gen2WalKey = gitvaultPaths.wal(gen2WalId);
    await seedBackend(backend, entries.filter((e) => e.key !== gen2WalKey));

    const outDir = scratchDir("run402-recovered-loss-");
    const result = await recoverGitvaultMirror({ backend, out_dir: outDir, keystore: f.keystore });
    assert.equal(result.recovered_generation, "0000000000000001", "must fall back to the last generation that fully materializes");
    assert.equal(result.data_loss_detected, true);
    const named = result.absences.find((a) => a.object_id === gen2WalId);
    assert.ok(named, "the missing object must be NAMED in the report, never silently dropped");
    assert.equal(named!.adjudication, "unexplained_absence");
    assert.equal(result.refs["refs/heads/main"], c1, "recovered at the fallback generation, not the (unmaterializable) newest one");

    rmSync(mirrorRoot, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });
});

// ─── Group 2 — mirror writer / sync / dual-push (task 2.5) ────────────────────

describe("gitvault mirror writer + sync engine (task 2.5)", () => {
  it("planMirrorWrite: every plain object precedes every admission/head; admissions/heads are strictly ascending with admission before its own head", () => {
    const entries: GitvaultObjectEntry[] = [
      { key: "head/0000000000000002", object_kind: "head", sha256: "", size_bytes: "1" },
      { key: "wal/wal_z.pack.enc", object_kind: "wal_pack", sha256: "", size_bytes: "1" },
      { key: "admissions/0000000000000002", object_kind: "admission_record", sha256: "", size_bytes: "1" },
      { key: "head/0000000000000001", object_kind: "head", sha256: "", size_bytes: "1" },
      { key: "admissions/0000000000000001", object_kind: "admission_record", sha256: "", size_bytes: "1" },
      { key: "refs/refs_a.enc", object_kind: "ref_state", sha256: "", size_bytes: "1" },
    ];
    const plan = planMirrorWrite(entries);
    assert.deepEqual(new Set(plan.objects.map((e) => e.key)), new Set(["wal/wal_z.pack.enc", "refs/refs_a.enc"]));
    assert.deepEqual(plan.admissionsAndHeads.map((e) => e.key), [
      "admissions/0000000000000001", "head/0000000000000001", "admissions/0000000000000002", "head/0000000000000002",
    ]);
  });

  it("torn-mirror property: interrupted at every write boundary recovers at exactly the expected earlier generation", async () => {
    const f = await makeVault();
    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });

    const entries = transportEntries(f.transport, f.repoId);
    const listing: GitvaultObjectEntry[] = entries.map((e) => ({ key: e.key, object_kind: "x", sha256: sha256Hex(e.bytes), size_bytes: String(e.bytes.length) }));
    const plan = planMirrorWrite(listing);
    const ordered = [...plan.objects, ...plan.admissionsAndHeads];
    const byKey = new Map(entries.map((e) => [e.key, e.bytes]));

    const genesisHeadIdx = ordered.findIndex((e) => e.key === "head/0000000000000000");
    const gen1HeadIdx = ordered.findIndex((e) => e.key === "head/0000000000000001");
    const gen2HeadIdx = ordered.findIndex((e) => e.key === "head/0000000000000002");
    assert.ok(genesisHeadIdx >= 0 && gen1HeadIdx >= 0 && gen2HeadIdx >= 0);

    const boundaries: Array<{ cut: number; expect: string }> = [
      { cut: genesisHeadIdx + 1, expect: "0000000000000000" },
      { cut: gen1HeadIdx, expect: "0000000000000000" }, // gen1's admission may have landed, but not its head yet
      { cut: gen1HeadIdx + 1, expect: "0000000000000001" },
      { cut: gen2HeadIdx, expect: "0000000000000001" },
      { cut: ordered.length, expect: "0000000000000002" },
    ];

    for (const { cut, expect } of boundaries) {
      const mirrorRoot = scratchDir("run402-torn-");
      const backend = new DirectoryMirrorBackend(mirrorRoot);
      for (const e of ordered.slice(0, cut)) await backend.putCreateOnly(e.key, byKey.get(e.key)!);
      const discovery = await discoverAndVerifyChain({ backend, keystore: f.keystore });
      assert.equal(discovery.newest_generation, expect, `cut=${cut} (of ${ordered.length})`);
      assert.equal(discovery.chain_break, null, "a torn mirror is an earlier VALID state, never a reported chain break");
      rmSync(mirrorRoot, { recursive: true, force: true });
    }

    // Before the genesis head itself has landed, discovery has nothing to
    // anchor on at all — a real, honest refusal, not a fabricated "generation
    // zero" for a mirror that has not yet reached a self-consistent state.
    const emptyRoot = scratchDir("run402-torn-empty-");
    const emptyBackend = new DirectoryMirrorBackend(emptyRoot);
    for (const e of ordered.slice(0, Math.max(1, genesisHeadIdx))) {
      if (e.key === "head/0000000000000000") continue;
      await emptyBackend.putCreateOnly(e.key, byKey.get(e.key)!);
    }
    await assert.rejects(discoverAndVerifyChain({ backend: emptyBackend, keystore: f.keystore }), (e: unknown) => (e as { code?: string }).code === "CHAIN_BROKEN");
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  it("DirectoryMirrorBackend.putCreateOnly is real create-only: a second write to the same key never overwrites", async () => {
    const root = scratchDir("run402-backend-createonly-");
    const backend = new DirectoryMirrorBackend(root);
    const first = await backend.putCreateOnly("wal/wal_x.pack.enc", new Uint8Array([1, 2, 3]));
    assert.equal(first.created, true);
    const second = await backend.putCreateOnly("wal/wal_x.pack.enc", new Uint8Array([9, 9, 9, 9]));
    assert.equal(second.created, false);
    const stored = await backend.get("wal/wal_x.pack.enc");
    assert.deepEqual([...stored!], [1, 2, 3]);
    rmSync(root, { recursive: true, force: true });
  });

  it("mirrorPushForGeneration NEVER throws — a broken backend surfaces as outcome:'failed', isolated from any caller's own control flow (design D6)", async () => {
    const f = await makeVault();
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: await commitFile(f.repoDir, "a.txt", "a\n"), force: false }] } });

    const brokenBackend: GitvaultMirrorBackend = {
      describe: () => "broken://backend",
      head: async () => null,
      get: async () => null,
      putCreateOnly: async () => {
        throw new Error("simulated destination outage");
      },
      list: async () => [],
    };
    // A minimal fake `Client` whose `request` answers the objects listing
    // with one entry the broken backend will fail to write — enough to
    // exercise the isolation property without a full HTTP fixture.
    const fakeClient = {
      apiBase: "https://fake.test",
      credentials: { getAuth: async () => ({}) },
      async request(path: string) {
        if (path.includes("/objects")) {
          return { repo_id: f.repoId, objects: [{ key: "wal/wal_does_not_matter.pack.enc", object_kind: "wal_pack", sha256: "0".repeat(64), size_bytes: "3" }], has_more: false, next_cursor: null };
        }
        throw new Error(`unexpected request: ${path}`);
      },
      async fetch() {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await mirrorPushForGeneration(fakeClient, f.repoId, { keystore: f.keystore, backend: brokenBackend });
    assert.equal(result.attempted, true);
    assert.equal(result.outcome, "failed");
    assert.equal(result.summary?.objects_failed, 1);
  });

  it("mirror sync is idempotent: a second pass over an already-current mirror copies nothing", async () => {
    const f = await makeVault();
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: await commitFile(f.repoDir, "a.txt", "a\n"), force: false }] } });

    const entries = transportEntries(f.transport, f.repoId);
    const mirrorRoot = scratchDir("run402-mirror-idempotent-");
    const backend = new DirectoryMirrorBackend(mirrorRoot);

    const fakeClient = {
      apiBase: "https://fake.test",
      credentials: { getAuth: async () => ({}) },
      async request(path: string, init?: { body?: { objects?: Array<Record<string, string>> } }) {
        if (path.includes("/objects")) {
          return {
            repo_id: f.repoId,
            objects: entries.map((e) => ({ key: e.key, object_kind: keyKindFor(e.key), sha256: sha256Hex(e.bytes), size_bytes: String(e.bytes.length) })),
            has_more: false, next_cursor: null,
          };
        }
        if (path.includes("/object-reads")) {
          const requested = init?.body?.objects?.[0];
          const key = keyForRead(requested!);
          return { reads: [{ url: `mem://${key}` }] };
        }
        throw new Error(`unexpected request: ${path}`);
      },
      async fetch(url: string) {
        if (typeof url === "string" && url.startsWith("mem://")) {
          const key = url.slice("mem://".length);
          const bytes = entries.find((e) => e.key === key)?.bytes;
          return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 });
        }
        const path = url.replace("https://fake.test", "");
        const m = /\/(heads|admissions)\/([0-9a-f]{16})$/.exec(path);
        if (m) {
          const key = m[1] === "heads" ? `head/${m[2]}` : `admissions/${m[2]}`;
          const bytes = entries.find((e) => e.key === key)?.bytes;
          return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 });
        }
        return new Response(null, { status: 404 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const first = await mirrorSync(fakeClient, f.repoId, { keystore: f.keystore, backend });
    assert.equal(first.objects_failed, 0);
    assert.ok(first.objects_copied > 0, "the first sync must copy something");
    assert.equal(first.objects_copied + first.objects_already_present, first.objects_listed);

    const second = await mirrorSync(fakeClient, f.repoId, { keystore: f.keystore, backend });
    assert.equal(second.objects_copied, 0, "a second sync over an already-current mirror must copy nothing");
    assert.equal(second.objects_already_present, second.objects_listed);
    assert.equal(second.objects_failed, 0);

    rmSync(mirrorRoot, { recursive: true, force: true });
  });
});

// ─── request/response fixture helpers for the sync-idempotency test ──────────
// Gateway-true key shapes throughout (§3 / storage-keys.ts) — see
// `toGatewayTrueKey`'s doc comment above for why `key_envelope` is NOT the
// SDK's own upload-manifest `path` spelling.

function keyKindFor(key: string): string {
  if (key.startsWith("wal/")) return "wal_pack";
  if (key.startsWith("refs/")) return "ref_state";
  if (key.startsWith("retention/") && key.endsWith(".enc")) return "retention_roots";
  if (key.startsWith("checkpoints/") && key.endsWith(".manifest.enc")) return "checkpoint_manifest";
  if (key.startsWith("checkpoints/") && key.endsWith(".pack.enc")) return "checkpoint_pack";
  if (key.startsWith("checkpoints/") && key.endsWith(".claims.json")) return "checkpoint_claim_set";
  if (key.startsWith("key-envelopes/") && key.endsWith(".env")) return "key_envelope";
  return "unknown";
}

function keyForRead(read: Record<string, string>): string {
  if (read.object_kind === "key_envelope") return `key-envelopes/${read.epoch}/${read.recipient_fingerprint}.env`;
  const id = read.object_id!;
  if (read.object_kind === "wal_pack") return gitvaultPaths.wal(id);
  if (read.object_kind === "ref_state") return gitvaultPaths.refState(id);
  if (read.object_kind === "retention_roots") return gitvaultPaths.retentionRoots(id);
  if (read.object_kind === "checkpoint_manifest") return gitvaultPaths.checkpointManifest(id);
  if (read.object_kind === "checkpoint_pack") return gitvaultPaths.checkpointPack(id);
  if (read.object_kind === "checkpoint_claim_set") return gitvaultPaths.claimSet(id);
  throw new Error(`unhandled object_kind ${read.object_kind}`);
}
