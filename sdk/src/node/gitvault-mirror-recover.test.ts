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
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcs, sha256Hex } from "../namespaces/gitvault.crypto.js";
import { gitvaultPaths, gitvaultRetainedRefName } from "./gitvault-publication.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { hardenedGit } from "./gitvault-snapshot.js";
import { commitFile, git, makeVault } from "./gitvault-memory-transport.test.js";
import { DirectoryMirrorBackend, type GitvaultMirrorBackend } from "./gitvault-mirror-backend.js";
import {
  generationRouteForKey,
  listGitvaultObjectsAll,
  mirrorPushForGeneration,
  mirrorSync,
  objectReadRequestForEntry,
  planMirrorWrite,
  readGitvaultObjectBytes,
  type GitvaultObjectEntry,
} from "./gitvault-mirror.js";
import { _resetGitvaultEdgeFetchStateForTest } from "./gitvault-edge-fetch.js";
import { adjudicateAbsences, discoverAndVerifyChain, recoverGitvaultMirror, verifyGitvaultMirror } from "./gitvault-recover.js";

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A root, unrelated commit — never an ancestor of anything else built this way (no `-p` parent). Mirrors `gitvault-publication.test.ts`'s own helper of the same name. */
async function orphanCommit(dir: string, label: string): Promise<string> {
  const blob = await git(dir, ["hash-object", "-w", "-t", "blob", "--stdin"], `${label}\n`);
  const tree = await git(dir, ["mktree"], `100644 blob ${blob}\t${label}.txt\n`);
  return git(dir, ["commit-tree", tree, "-m", `orphan ${label}`]);
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
 * consumer of this helper below therefore sees gateway-true, REPO-RELATIVE
 * keys — the exact shape the mirror BACKEND stores under (see
 * `gitvault-mirror.ts`'s module doc mirror-layout mapping), the same as a
 * real `mirror sync` would leave on disk/S3.
 */
function toRepoRelativeGatewayKey(key: string): string {
  const m = /^envelopes\/([0-9a-f]{16})\/(ek_[0-9a-f]{32})$/.exec(key);
  return m ? `key-envelopes/${m[1]}/${m[2]}.env` : key;
}

/** Every entry the fixture's transport holds for one vault, keyed REPO-RELATIVE to the vault root (§3 layout, `source/<repo_id>/` stripped) — the shape the mirror BACKEND stores under, and what `seedBackend` below writes verbatim. NOT the wire listing shape (see {@link toWireListingEntries} for that). */
function transportEntries(transport: { objects: Map<string, Uint8Array> }, repoId: string): Array<{ key: string; bytes: Uint8Array }> {
  const out: Array<{ key: string; bytes: Uint8Array }> = [];
  const prefix = `${repoId}/`;
  for (const [k, bytes] of transport.objects) {
    if (k.startsWith(prefix)) out.push({ key: toRepoRelativeGatewayKey(k.slice(prefix.length)), bytes });
  }
  return out;
}

async function seedBackend(backend: GitvaultMirrorBackend, entries: readonly { key: string; bytes: Uint8Array }[]): Promise<void> {
  for (const e of entries) await backend.putCreateOnly(e.key, e.bytes);
}

const GENESIS_GEN = "0".repeat(16);

/**
 * Classify a REPO-RELATIVE key (as {@link transportEntries} produces) by its
 * `object_kind`, matching the real gateway's `GET …/objects` listing
 * (task 5.3's live-confirmed contract) — including the two chain kinds and
 * the genesis/ordinary-generation `vault_genesis`/`head` split. The single
 * source of truth every WIRE-listing mock below builds from, so the mock
 * cannot drift kind-by-kind the way the pre-fix fixture did.
 */
function wireObjectKindFor(repoRelativeKey: string): string {
  if (repoRelativeKey === `head/${GENESIS_GEN}`) return "vault_genesis";
  if (repoRelativeKey.startsWith("head/")) return "head";
  if (repoRelativeKey.startsWith("admissions/")) return "admission_record";
  if (repoRelativeKey.startsWith("wal/")) return "wal_pack";
  if (repoRelativeKey.startsWith("refs/")) return "ref_state";
  if (repoRelativeKey.startsWith("retention/") && repoRelativeKey.endsWith(".enc")) return "retention_roots";
  if (repoRelativeKey.startsWith("checkpoints/") && repoRelativeKey.endsWith(".manifest.enc")) return "checkpoint_manifest";
  if (repoRelativeKey.startsWith("checkpoints/") && repoRelativeKey.endsWith(".pack.enc")) return "checkpoint_pack";
  if (repoRelativeKey.startsWith("checkpoints/") && repoRelativeKey.endsWith(".claims.json")) return "checkpoint_claim_set";
  if (repoRelativeKey.startsWith("key-envelopes/") && repoRelativeKey.endsWith(".env")) return "key_envelope";
  return "unknown";
}

/**
 * The WIRE shape of `GET /gitvault/v1/vaults/:vault_id/objects` — full
 * `source/<repo_id>/`-prefixed keys, `object_kind` per {@link
 * wireObjectKindFor}, exact `size_bytes` for every kind (including the two
 * chain kinds). This is the "mock IS the wire model" fixture task 5.3
 * demanded: no repo-relative shortcut, no omitted chain entries.
 */
function toWireListingEntries(entries: readonly { key: string; bytes: Uint8Array }[], repoId: string): Array<{ key: string; object_kind: string; sha256: string; size_bytes: string }> {
  return entries.map((e) => ({
    key: `source/${repoId}/${e.key}`,
    object_kind: wireObjectKindFor(e.key),
    sha256: sha256Hex(e.bytes),
    size_bytes: String(e.bytes.length),
  }));
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
  // see `toRepoRelativeGatewayKey`'s doc comment above.
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

  // ── chain kinds: head/vault_genesis/admission_record (task 5.3 findings (a)+(b)) ──
  //
  // Both fetch via the exact-bytes generation routes (`.../heads/:generation`,
  // `.../admissions/:generation`), NEVER through `object-reads` — and the
  // listed `object_kind` must match what that route/generation actually
  // means: `admission_record` at every generation (including genesis),
  // `vault_genesis` ONLY at generation zero, `head` at every later
  // generation. A mismatch is refused loudly rather than silently read under
  // the wrong assumption.
  it("chain kinds: correctly-labeled entries read via the generation route and never touch object-reads", async () => {
    const repoId = `src_${"3".repeat(32)}`;
    const fakeClient = {
      apiBase: "https://fake.test",
      credentials: { getAuth: async () => ({}) },
      async request() {
        throw new Error("a generation-addressed entry must never call /object-reads");
      },
      async fetch() {
        return new Response(new Uint8Array([9]), { status: 200 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const genesis = await readGitvaultObjectBytes(fakeClient, repoId, { key: `head/${GENESIS_GEN}`, object_kind: "vault_genesis", sha256: "", size_bytes: "1" });
    assert.deepEqual([...genesis!], [9]);
    const head = await readGitvaultObjectBytes(fakeClient, repoId, { key: "head/0000000000000005", object_kind: "head", sha256: "", size_bytes: "1" });
    assert.deepEqual([...head!], [9]);
    const genesisAdmission = await readGitvaultObjectBytes(fakeClient, repoId, { key: `admissions/${GENESIS_GEN}`, object_kind: "admission_record", sha256: "", size_bytes: "1" });
    assert.deepEqual([...genesisAdmission!], [9]);
    const admission = await readGitvaultObjectBytes(fakeClient, repoId, { key: "admissions/0000000000000005", object_kind: "admission_record", sha256: "", size_bytes: "1" });
    assert.deepEqual([...admission!], [9]);
  });

  it("chain kinds: a listed object_kind that does NOT match its generation-addressed key is refused, never silently read", async () => {
    const repoId = `src_${"4".repeat(32)}`;
    const fakeClient = {
      apiBase: "https://fake.test",
      credentials: { getAuth: async () => ({}) },
      async request() {
        throw new Error("must never be called");
      },
      async fetch() {
        return new Response(new Uint8Array([9]), { status: 200 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const isKeyUnrecognized = (e: unknown): boolean => (e as { code?: string }).code === "GITVAULT_MIRROR_KEY_UNRECOGNIZED";

    // genesis mislabeled as an ordinary head
    await assert.rejects(readGitvaultObjectBytes(fakeClient, repoId, { key: `head/${GENESIS_GEN}`, object_kind: "head", sha256: "", size_bytes: "1" }), isKeyUnrecognized);
    // an ordinary generation's head mislabeled as vault_genesis
    await assert.rejects(readGitvaultObjectBytes(fakeClient, repoId, { key: "head/0000000000000005", object_kind: "vault_genesis", sha256: "", size_bytes: "1" }), isKeyUnrecognized);
    // an admission record mislabeled as a head (at any generation, including genesis)
    await assert.rejects(readGitvaultObjectBytes(fakeClient, repoId, { key: `admissions/${GENESIS_GEN}`, object_kind: "vault_genesis", sha256: "", size_bytes: "1" }), isKeyUnrecognized);
    await assert.rejects(readGitvaultObjectBytes(fakeClient, repoId, { key: "admissions/0000000000000005", object_kind: "head", sha256: "", size_bytes: "1" }), isKeyUnrecognized);
  });
});

// ─── gitvault-read-edge-cache design D5: edge_url wiring in the mirror path ──
//
// The mirror/recover reader (`readGitvaultObjectBytes`) reimplements its own
// `object-reads` call site rather than depending on `gitvault-publication.ts`
// (see `gitvault-mirror.ts`'s own header comment on why) — but for a
// non-generation-addressed (object-reads) entry it still routes its GET
// through the SAME `fetchGitvaultObjectBytes` (`gitvault-edge-fetch.ts`) the
// live-push path uses, sharing its process-wide fallback state. Only the
// wiring is pinned here — every preference/fallback/stickiness scenario is
// unit-tested directly against `fetchGitvaultObjectBytes` itself in
// `gitvault-edge-fetch.test.ts`.
describe("gitvault mirror reader — edge_url from object-reads reaches a non-generation-addressed read (gitvault-read-edge-cache design D5)", () => {
  const WAL_ID = `wal_${"7".repeat(32)}`;

  beforeEach(() => {
    _resetGitvaultEdgeFetchStateForTest();
  });

  it("prefers `edge_url` over `url` when the object-reads response carries one", async () => {
    const repoId = `src_${"5".repeat(32)}`;
    const fakeClient = {
      apiBase: "https://fake.test",
      credentials: { getAuth: async () => ({}) },
      async request() {
        return { reads: [{ url: "https://origin.example/wal", edge_url: "https://edge.example/wal" }] };
      },
      async fetch(input: string | URL | Request) {
        const url = String(input);
        if (url === "https://edge.example/wal") return new Response(new Uint8Array([1, 2]), { status: 200 });
        throw new Error(`must not fetch url when edge_url succeeds: ${url}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const bytes = await readGitvaultObjectBytes(fakeClient, repoId, { key: `wal/${WAL_ID}.pack.enc`, object_kind: "wal_pack", sha256: "", size_bytes: "1" });
    assert.deepEqual([...bytes!], [1, 2]);
  });

  it("falls back to `url` when the object-reads response carries no `edge_url` — byte-identical to before this change", async () => {
    const repoId = `src_${"6".repeat(32)}`;
    const fakeClient = {
      apiBase: "https://fake.test",
      credentials: { getAuth: async () => ({}) },
      async request() {
        return { reads: [{ url: "https://origin.example/wal2" }] };
      },
      async fetch(input: string | URL | Request) {
        assert.equal(String(input), "https://origin.example/wal2");
        return new Response(new Uint8Array([3, 4]), { status: 200 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const bytes = await readGitvaultObjectBytes(fakeClient, repoId, { key: `wal/${WAL_ID}.pack.enc`, object_kind: "wal_pack", sha256: "", size_bytes: "1" });
    assert.deepEqual([...bytes!], [3, 4]);
  });
});

// ─── source/<repo_id>/ prefix handling (task 5.3 finding (b)) ────────────────
//
// The gateway's REAL objects listing always carries the full
// `source/<repo_id>/…` prefix (live-confirmed 2026-08-26). This is the
// standing guard against the exact bug that made `mirror sync` fail on every
// listed object against a real vault: the SDK previously assumed a
// repo-relative wire key and either rejected every entry outright
// (`key_envelope`) or mismatched the repo id itself out of the prefix as if
// it were the object id (every other kind, via an unanchored fallback
// regex — see `NON_GENERATION_KEY_SPECS`'s doc comment in gitvault-mirror.ts).
describe("gitvault mirror objects listing — source/<repo_id>/ prefix handling (task 5.3)", () => {
  const REPO_ID = `src_${"5".repeat(32)}`;

  function fakeListingClient(objects: ReadonlyArray<{ key: string; object_kind: string; sha256: string; size_bytes: string }>): unknown {
    return {
      apiBase: "https://fake.test",
      credentials: { getAuth: async () => ({}) },
      async request(path: string) {
        if (path.includes("/objects")) return { repo_id: REPO_ID, objects, has_more: false, next_cursor: null };
        throw new Error(`unexpected request: ${path}`);
      },
      async fetch() {
        throw new Error("unexpected fetch");
      },
    };
  }

  it("strips the exact source/<repo_id>/ prefix, leaving a repo-relative key", async () => {
    const walId = `wal_${"a".repeat(32)}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = fakeListingClient([{ key: `source/${REPO_ID}/wal/${walId}.pack.enc`, object_kind: "wal_pack", sha256: "0".repeat(64), size_bytes: "3" }]) as any;
    const entries = await listGitvaultObjectsAll(client, REPO_ID);
    assert.deepEqual(entries, [{ key: `wal/${walId}.pack.enc`, object_kind: "wal_pack", sha256: "0".repeat(64), size_bytes: "3" }]);
  });

  it("refuses (never silently drops or accepts) a listed key addressed to a DIFFERENT repo id", async () => {
    const foreignRepoId = `src_${"6".repeat(32)}`;
    const walId = `wal_${"a".repeat(32)}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = fakeListingClient([{ key: `source/${foreignRepoId}/wal/${walId}.pack.enc`, object_kind: "wal_pack", sha256: "0".repeat(64), size_bytes: "3" }]) as any;
    await assert.rejects(listGitvaultObjectsAll(client, REPO_ID), (e: unknown) => (e as { code?: string }).code === "GITVAULT_MIRROR_FOREIGN_REPO_KEY");
  });

  it("refuses a listed key with no source/<repo_id>/ prefix at all", async () => {
    const walId = `wal_${"a".repeat(32)}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = fakeListingClient([{ key: `wal/${walId}.pack.enc`, object_kind: "wal_pack", sha256: "0".repeat(64), size_bytes: "3" }]) as any;
    await assert.rejects(listGitvaultObjectsAll(client, REPO_ID), (e: unknown) => (e as { code?: string }).code === "GITVAULT_MIRROR_LISTING_INCONSISTENT");
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

    // dogfood item 3: a bare-repo recovery must say so and name exactly how
    // to get working files, rather than reading as a failed/empty recovery.
    assert.equal(result.layout, "bare");
    assert.ok(Array.isArray(result.next_actions) && result.next_actions.length > 0);
    assert.equal(result.next_actions[0].command, `git clone ${outDir} ${outDir}-worktree`);

    const head = (await git(outDir, ["rev-parse", "HEAD"])).trim();
    assert.equal(head, c2);
    const symref = (await git(outDir, ["symbolic-ref", "HEAD"])).trim();
    assert.equal(symref, "refs/heads/main");

    rmSync(mirrorRoot, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  // ── task 5.3 follow-up (found via the live drill 2026-08-26): `out_dir`
  // never got created before this fix, and the resulting Node `ENOENT`
  // (missing cwd) was indistinguishable from a missing `git` binary. Every
  // OTHER test in this file passes an already-`mkdtempSync`'d directory,
  // which is exactly why this was never caught — these two pin the fix at
  // both layers named in the coordinator's diagnosis. ──
  it("recover creates a non-pre-existing --out directory (the CLI's own documented usage) instead of crashing GIT_UNAVAILABLE", async () => {
    const f = await makeVault();
    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });

    const mirrorRoot = scratchDir("run402-mirror-mkdir-fix-");
    const backend = new DirectoryMirrorBackend(mirrorRoot);
    await seedBackend(backend, transportEntries(f.transport, f.repoId));

    // A NESTED path under a fresh scratch parent — deliberately never
    // mkdtempSync'd itself, matching `run402 gitvault recover s3://… --out
    // ./restored` against a directory that naturally does not exist yet.
    const parent = scratchDir("run402-recover-mkdir-parent-");
    const outDir = join(parent, "nested", "restored");
    assert.equal(existsSync(outDir), false, "sanity: out_dir must not pre-exist for this test to mean anything");

    const result = await recoverGitvaultMirror({ backend, out_dir: outDir, keystore: f.keystore });
    assert.equal(result.mode, "recovered");
    assert.equal(existsSync(outDir), true);
    const head = (await git(outDir, ["rev-parse", "HEAD"])).trim();
    assert.equal(head, c1);

    rmSync(mirrorRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  });

  it("hardenedGit disambiguates a missing cwd (GIT_CWD_MISSING) from a missing git binary (GIT_UNAVAILABLE)", async () => {
    const missing = join(scratchDir("run402-hardened-git-cwd-"), "does-not-exist");
    assert.equal(existsSync(missing), false);
    await assert.rejects(
      hardenedGit(missing, ["init", "-q", "--bare", "--object-format=sha1", "."]),
      (e: unknown) => (e as { code?: string }).code === "GIT_CWD_MISSING",
    );
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

  // clone-installs-retained-refs (D2) extended to recover: the SAME
  // refs/r402/retain/* bookkeeping `restoreObjectsInto` (clone/fetch) and
  // `fsck` install must also land for a disaster-drill `repos recover`, so a
  // freshly recovered bare repo's `git fsck` is silent for a retained,
  // branch-unreachable tip rather than reporting it dangling.
  it("recoverGitvaultMirror installs a retained ref for a branch-unreachable, force-displaced tip; git fsck is silent", async () => {
    const f = await makeVault();
    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    // An unrelated (orphan) commit force-displaces c1 off main — c1 becomes a
    // retention root that is present in the mirrored objects but reachable
    // from no canonical ref, exactly the case a disaster-drill recovery must
    // still reference locally.
    const c2 = await orphanCommit(f.repoDir, "unrelated");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: true }] } });

    const mirrorRoot = scratchDir("run402-mirror-retain-");
    const backend = new DirectoryMirrorBackend(mirrorRoot);
    await seedBackend(backend, transportEntries(f.transport, f.repoId));

    const outDir = scratchDir("run402-recovered-retain-");
    const result = await recoverGitvaultMirror({ backend, out_dir: outDir, keystore: f.keystore });

    assert.equal(result.mode, "recovered");
    assert.equal(result.refs["refs/heads/main"], c2);
    const retainRef = gitvaultRetainedRefName(c1);
    assert.deepEqual(result.retained_refs, { written: [retainRef], deleted: [], retained_count: 1, warning: null });
    assert.equal((await git(outDir, ["rev-parse", retainRef])).trim(), c1);

    const fsckOut = await git(outDir, ["fsck", "--full"]);
    assert.doesNotMatch(fsckOut, /dangling commit/);

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
    // exercise the isolation property without a full HTTP fixture. Full
    // `source/<repo_id>/…` wire key + a syntactically valid wal_ id (task
    // 5.3's real contract), so the failure this test exercises is the
    // BROKEN BACKEND's write, not an incidental key-shape refusal.
    const walId = `wal_${"d".repeat(32)}`;
    const walBytes = new Uint8Array([1, 2, 3]);
    const fakeClient = {
      apiBase: "https://fake.test",
      credentials: { getAuth: async () => ({}) },
      async request(path: string) {
        if (path.includes("/objects")) {
          return { repo_id: f.repoId, objects: [{ key: `source/${f.repoId}/wal/${walId}.pack.enc`, object_kind: "wal_pack", sha256: sha256Hex(walBytes), size_bytes: String(walBytes.length) }], has_more: false, next_cursor: null };
        }
        if (path.includes("/object-reads")) {
          return { reads: [{ url: "mem://wal-bytes" }] };
        }
        throw new Error(`unexpected request: ${path}`);
      },
      async fetch() {
        return new Response(walBytes, { status: 200 });
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
            objects: toWireListingEntries(entries, f.repoId),
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

// ─── foreign-recipient key_envelope handling (task 5.3 follow-up) ────────────
//
// Gateway diagnosis 2026-08-26 (production): a real vault's own `mirror
// sync` 403 on a `key_envelope` was NOT a bug — it was the recipient-only
// read gate correctly refusing a genuinely foreign recipient's envelope. A
// mirror machine can only ever hold ITS OWN envelope; a foreign one is the
// NORM on a multi-recipient vault (gitvault-human-envelopes), never a
// failure. These tests pin the fix: classification happens BEFORE any
// network read is attempted (the fingerprint is parsed straight out of the
// listed key), a foreign envelope never counts toward `objects_failed`, and
// `resolveKRepo`/`recover` selects its own envelope by fingerprint rather
// than by array position.
describe("gitvault mirror sync — foreign-recipient key_envelope handling (task 5.3 follow-up)", () => {
  it("a key_envelope addressed to a DIFFERENT recipient is classified skipped_foreign_recipient, never failed — and its bytes are NEVER requested", async () => {
    const f = await makeVault();
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: await commitFile(f.repoDir, "a.txt", "a\n"), force: false }] } });

    const ownFingerprint = f.keystore.readIdentity()!.encryption_fingerprint;
    assert.match(ownFingerprint, /^ek_[0-9a-f]{32}$/, "sanity: the fixture's own identity has a real ek_ fingerprint");
    const foreignFingerprint = `ek_${"f".repeat(32)}`;
    assert.notEqual(foreignFingerprint, ownFingerprint, "sanity: the synthetic foreign fingerprint must actually differ from our own");

    const entries = transportEntries(f.transport, f.repoId);
    const foreignKey = `key-envelopes/0000000000000001/${foreignFingerprint}.env`;
    const foreignBytes = new TextEncoder().encode("not a real envelope — must never be read");
    entries.push({ key: foreignKey, bytes: foreignBytes });

    const mirrorRoot = scratchDir("run402-mirror-foreign-envelope-");
    const backend = new DirectoryMirrorBackend(mirrorRoot);
    let foreignKeyRequested = false;
    const fakeClient = {
      apiBase: "https://fake.test",
      credentials: { getAuth: async () => ({}) },
      async request(path: string, init?: { body?: { objects?: Array<Record<string, string>> } }) {
        if (path.includes("/objects")) {
          return { repo_id: f.repoId, objects: toWireListingEntries(entries, f.repoId), has_more: false, next_cursor: null };
        }
        if (path.includes("/object-reads")) {
          const requested = init?.body?.objects?.[0];
          const key = keyForRead(requested!);
          if (key === foreignKey) {
            foreignKeyRequested = true;
            throw new Error("the gateway would 403 this — a correctly-skipping sync must never even ask");
          }
          return { reads: [{ url: `mem://${key}` }] };
        }
        throw new Error(`unexpected request: ${path}`);
      },
      async fetch(url: string) {
        if (typeof url === "string" && url.startsWith("mem://")) {
          const key = url.slice("mem://".length);
          if (key === foreignKey) { foreignKeyRequested = true; throw new Error("must never fetch a foreign envelope's bytes"); }
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

    const summary = await mirrorSync(fakeClient, f.repoId, { keystore: f.keystore, backend });
    assert.equal(foreignKeyRequested, false, "the foreign envelope's bytes must never be requested from the gateway");
    assert.equal(summary.objects_failed, 0, "a foreign envelope must never count as a failure");
    assert.equal(summary.objects_skipped_foreign_recipient, 1);
    assert.deepEqual(summary.skipped_foreign_recipient_keys, [foreignKey]);
    assert.equal(await backend.get(foreignKey), null, "the mirror must not hold the foreign envelope's bytes");
    assert.ok(summary.objects_copied > 0, "everything else must still sync normally");

    // The capture-time dual-push hook (design D6) must report `pushed`, not
    // `failed`, when the only "issue" was an expected foreign-recipient skip
    // — this was exactly the live drill's regression (`mirror: dual-push
    // FAILED (deploy is unaffected)` on a perfectly healthy vault).
    const pushResult = await mirrorPushForGeneration(fakeClient, f.repoId, { keystore: f.keystore, backend });
    assert.equal(pushResult.outcome, "pushed");

    rmSync(mirrorRoot, { recursive: true, force: true });
  });

  it("recoverGitvaultMirror decrypts using the OWN envelope even when a foreign one is absent from the mirror entirely", async () => {
    const f = await makeVault();
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: await commitFile(f.repoDir, "a.txt", "a\n"), force: false }] } });

    const mirrorRoot = scratchDir("run402-recover-own-envelope-");
    const backend = new DirectoryMirrorBackend(mirrorRoot);
    // Seed EVERYTHING (including the real own envelope) — a foreign envelope
    // is simply never present here at all, matching what a real `mirror
    // sync` leaves behind (it is never even attempted, let alone copied).
    await seedBackend(backend, transportEntries(f.transport, f.repoId));

    const outDir = scratchDir("run402-recover-own-envelope-out-");
    const result = await recoverGitvaultMirror({ backend, out_dir: outDir, keystore: f.keystore });
    assert.equal(result.mode, "recovered");
    assert.equal(result.chain_break, null);

    rmSync(mirrorRoot, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });
});

// ─── request/response fixture helpers for the sync-idempotency test ──────────
// Gateway-true key shapes throughout (§3 / storage-keys.ts) — see
// `toRepoRelativeGatewayKey`'s doc comment above for why `key_envelope` is
// NOT the SDK's own upload-manifest `path` spelling. The listing itself is
// built by `toWireListingEntries`/`wireObjectKindFor` above (full
// `source/<repo_id>/…` keys, real kind classification including the chain
// kinds) — this helper is only for resolving an `object-reads` request back
// to the fixture's repo-relative bytes.

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
