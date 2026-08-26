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
import { mirrorPushForGeneration, mirrorSync, planMirrorWrite, type GitvaultObjectEntry } from "./gitvault-mirror.js";
import { adjudicateAbsences, discoverAndVerifyChain, recoverGitvaultMirror, verifyGitvaultMirror } from "./gitvault-recover.js";

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Every entry the fixture's transport holds for one vault, keyed relative to the vault root (§3 layout) — exactly the shape `GET .../objects` returns. */
function transportEntries(transport: { objects: Map<string, Uint8Array> }, repoId: string): Array<{ key: string; bytes: Uint8Array }> {
  const out: Array<{ key: string; bytes: Uint8Array }> = [];
  const prefix = `${repoId}/`;
  for (const [k, bytes] of transport.objects) {
    if (k.startsWith(prefix)) out.push({ key: k.slice(prefix.length), bytes });
  }
  return out;
}

async function seedBackend(backend: GitvaultMirrorBackend, entries: readonly { key: string; bytes: Uint8Array }[]): Promise<void> {
  for (const e of entries) await backend.putCreateOnly(e.key, e.bytes);
}

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

function keyKindFor(key: string): string {
  if (key.startsWith("wal/")) return "wal_pack";
  if (key.startsWith("refs/")) return "ref_state";
  if (key.startsWith("retention/") && key.endsWith(".enc")) return "retention_roots";
  if (key.startsWith("checkpoints/") && key.endsWith(".manifest.enc")) return "checkpoint_manifest";
  if (key.startsWith("checkpoints/") && key.endsWith(".pack.enc")) return "checkpoint_pack";
  if (key.startsWith("checkpoints/") && key.endsWith(".claims.json")) return "checkpoint_claim_set";
  if (key.startsWith("envelopes/")) return "key_envelope";
  return "unknown";
}

function keyForRead(read: Record<string, string>): string {
  if (read.object_kind === "key_envelope") return `envelopes/${read.epoch}/${read.recipient_fingerprint}`;
  const id = read.object_id!;
  if (read.object_kind === "wal_pack") return gitvaultPaths.wal(id);
  if (read.object_kind === "ref_state") return gitvaultPaths.refState(id);
  if (read.object_kind === "retention_roots") return gitvaultPaths.retentionRoots(id);
  if (read.object_kind === "checkpoint_manifest") return gitvaultPaths.checkpointManifest(id);
  if (read.object_kind === "checkpoint_pack") return gitvaultPaths.checkpointPack(id);
  if (read.object_kind === "checkpoint_claim_set") return gitvaultPaths.claimSet(id);
  throw new Error(`unhandled object_kind ${read.object_kind}`);
}
