/**
 * gitvault-mirror-default — the `vault_unmirrored` standing finding.
 *
 * The change's three pinned properties:
 *   1. Finding present / absent / cleared — no config → finding (configure
 *      form); configured-but-never-succeeded → finding (backfill form); a
 *      zero-failure sync stamps `last_success_at` in the LOCAL config and
 *      clears it; a mirror that verifiably holds a generation (synced before
 *      the stamp existed) also clears it; moving the destination reopens it.
 *   2. Server blindness — computing the finding performs ZERO gateway calls
 *      (the unconfigured `mirrorStatus` branch returns before any network),
 *      and nothing about the mirror ever rides a request.
 *   3. Unmirrored push/deploy byte-identical — `mirrorPushForGeneration` on a
 *      vault with no mirror reports `skipped_no_mirror` with no network call,
 *      exactly the pre-change contract.
 *
 * Run: node --test --import tsx sdk/src/node/gitvault-mirror-default.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Gitvault, gitvaultUnmirroredFinding } from "../namespaces/gitvault.js";
import { GITVAULT_UNMIRRORED_FINDING_STATEMENT } from "../namespaces/gitvault.crypto.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { readMirrorConfig, recordMirrorSuccess, saveMirrorConfig } from "./gitvault-mirror-config.js";
import { mirrorPushForGeneration, mirrorSync } from "./gitvault-mirror.js";
import { _resetGitvaultEdgeFetchStateForTest } from "./gitvault-edge-fetch.js";

const REPO_ID = `src_${"a".repeat(32)}`;

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A client that REFUSES every network surface and counts the attempts — the
 * server-blindness probe. Any request/fetch reaching it is itself the failure.
 */
function refusingClient(): { client: any; calls: () => number } {
  let calls = 0;
  const client = {
    apiBase: "https://refused.test",
    credentials: {
      getAuth: async () => {
        calls += 1;
        throw new Error("server-blindness violation: getAuth was called");
      },
    },
    async request(path: string) {
      calls += 1;
      throw new Error(`server-blindness violation: request(${path}) was called`);
    },
    async fetch(url: string) {
      calls += 1;
      throw new Error(`server-blindness violation: fetch(${url}) was called`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { client, calls: () => calls };
}

/** One wal_pack entry served over the fake wire — the minimal happy-path sync. */
function oneObjectClient(repoId: string): any {
  const walId = `wal_${"d".repeat(32)}`;
  const walBytes = new Uint8Array([1, 2, 3]);
  return {
    apiBase: "https://fake.test",
    credentials: { getAuth: async () => ({}) },
    async request(path: string) {
      if (path.includes("/objects")) {
        return {
          repo_id: repoId,
          objects: [{ key: `source/${repoId}/wal/${walId}.pack.enc`, object_kind: "wal_pack", sha256: sha256Hex(walBytes), size_bytes: String(walBytes.length) }],
          has_more: false,
          next_cursor: null,
        };
      }
      if (path.includes("/object-reads")) return { reads: [{ url: "mem://wal-bytes" }] };
      throw new Error(`unexpected request: ${path}`);
    },
    async fetch() {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("gitvaultUnmirroredFinding — the pure computation", () => {
  it("no mirror configured → the finding, in its configure form", () => {
    const finding = gitvaultUnmirroredFinding({ configured: false, last_success_at: null, mirrored_generation: null });
    assert.ok(finding);
    assert.equal(finding.kind, "vault_unmirrored");
    assert.equal(finding.message, GITVAULT_UNMIRRORED_FINDING_STATEMENT);
    assert.equal(finding.setup_command, "run402 repos mirror <destination>");
  });

  it("configured but no success evidence yet → the finding, in its backfill form", () => {
    const finding = gitvaultUnmirroredFinding({ configured: true, last_success_at: null, mirrored_generation: null });
    assert.ok(finding);
    assert.equal(finding.kind, "vault_unmirrored");
    assert.equal(finding.setup_command, "run402 repos mirror --backfill");
  });

  it("a recorded success clears it — and keeps it cleared through a transiently unreachable mirror", () => {
    assert.equal(gitvaultUnmirroredFinding({ configured: true, last_success_at: "2026-08-30T00:00:00.000Z", mirrored_generation: null }), null);
  });

  it("a mirror that verifiably holds a generation clears it even without the local stamp (pre-change synced mirrors)", () => {
    assert.equal(gitvaultUnmirroredFinding({ configured: true, last_success_at: null, mirrored_generation: "0000000000000001" }), null);
  });

  it("informational, never blocking: the finding is a plain value with no throw path", () => {
    // A finding is data the edges echo — asserting the full shape here pins
    // that nothing upstream can turn it into control flow.
    const finding = gitvaultUnmirroredFinding({ configured: false, last_success_at: null, mirrored_generation: null })!;
    assert.deepEqual(Object.keys(finding).sort(), ["kind", "message", "setup_command"]);
  });
});

describe("mirror config — last_success_at lifecycle", () => {
  let root: string;
  let keystore: GitvaultKeystore;

  beforeEach(() => {
    root = scratchDir("run402-mirror-default-cfg-");
    keystore = new GitvaultKeystore({ rootDir: root });
  });

  it("recordMirrorSuccess stamps the local config; a same-destination re-save carries the stamp", () => {
    saveMirrorConfig(keystore, { repo_id: REPO_ID, destination: { kind: "directory", path: join(root, "mirror") } });
    assert.equal(readMirrorConfig(keystore, REPO_ID)?.last_success_at, undefined);
    const stamped = recordMirrorSuccess(keystore, REPO_ID, () => new Date("2026-08-30T01:02:03.000Z"));
    assert.equal(stamped?.last_success_at, "2026-08-30T01:02:03.000Z");
    const resaved = saveMirrorConfig(keystore, { repo_id: REPO_ID, destination: { kind: "directory", path: join(root, "mirror") } });
    assert.equal(resaved.last_success_at, "2026-08-30T01:02:03.000Z");
  });

  it("moving the destination resets the stamp — a success against the old bucket says nothing about the new one", () => {
    saveMirrorConfig(keystore, { repo_id: REPO_ID, destination: { kind: "directory", path: join(root, "mirror-a") } });
    recordMirrorSuccess(keystore, REPO_ID);
    const moved = saveMirrorConfig(keystore, { repo_id: REPO_ID, destination: { kind: "directory", path: join(root, "mirror-b") } });
    assert.equal(moved.last_success_at, undefined);
    const finding = gitvaultUnmirroredFinding({ configured: true, last_success_at: moved.last_success_at ?? null, mirrored_generation: null });
    assert.equal(finding?.setup_command, "run402 repos mirror --backfill");
  });

  it("recordMirrorSuccess is a no-op when no config exists (test-injected backends sync without one)", () => {
    assert.equal(recordMirrorSuccess(keystore, REPO_ID), null);
  });
});

describe("mirrorStatus + mirrorSync — present, cleared, and gateway-blind", () => {
  let root: string;
  let keystore: GitvaultKeystore;

  beforeEach(() => {
    _resetGitvaultEdgeFetchStateForTest();
    root = scratchDir("run402-mirror-default-status-");
    keystore = new GitvaultKeystore({ rootDir: root });
  });

  it("unconfigured vault: mirrorStatus carries the finding and performs ZERO network calls (the gateway never learns whether a mirror exists)", async () => {
    const { client, calls } = refusingClient();
    const status = await new Gitvault(client).mirrorStatus({ repo_id: REPO_ID, keystore_root: root });
    assert.equal(status.configured, false);
    assert.equal(status.last_success_at, null);
    assert.equal(status.finding?.kind, "vault_unmirrored");
    assert.equal(status.finding?.setup_command, "run402 repos mirror <destination>");
    assert.equal(calls(), 0, "computing the vault_unmirrored finding must never touch the network");
  });

  it("a zero-failure sync stamps last_success_at, and the finding no longer appears", async () => {
    saveMirrorConfig(keystore, { repo_id: REPO_ID, destination: { kind: "directory", path: join(root, "mirror") } });
    const summary = await mirrorSync(oneObjectClient(REPO_ID), REPO_ID, { keystore });
    assert.equal(summary.objects_failed, 0);
    assert.equal(summary.objects_copied, 1);
    const config = readMirrorConfig(keystore, REPO_ID);
    assert.ok(config?.last_success_at, "a zero-failure sync stamps the local success fact");
    const finding = gitvaultUnmirroredFinding({ configured: true, last_success_at: config!.last_success_at!, mirrored_generation: null });
    assert.equal(finding, null, "the finding clears on the first successful mirror write or sync");
  });

  it("a failing sync does NOT stamp success — the finding stands until a pass really completes clean", async () => {
    saveMirrorConfig(keystore, { repo_id: REPO_ID, destination: { kind: "directory", path: join(root, "mirror") } });
    const walId = `wal_${"d".repeat(32)}`;
    const client = oneObjectClient(REPO_ID);
    client.fetch = async () => new Response(null, { status: 500 });
    // The presigned GET failing turns the one entry into objects_failed=1.
    const summary = await mirrorSync(client, REPO_ID, { keystore });
    assert.equal(summary.objects_failed, 1, `expected the ${walId} copy to fail`);
    assert.equal(readMirrorConfig(keystore, REPO_ID)?.last_success_at, undefined);
  });

  it("unmirrored push/deploy stays byte-identical: mirrorPushForGeneration reports skipped_no_mirror with no network call", async () => {
    const { client, calls } = refusingClient();
    const result = await mirrorPushForGeneration(client, REPO_ID, { keystore });
    assert.deepEqual(result, { attempted: false, outcome: "skipped_no_mirror" });
    assert.equal(calls(), 0, "an unmirrored vault's push path must not gain any network traffic from the finding machinery");
  });

  it("the sync summary itself never mentions the finding — capture/push output is unchanged for mirrored vaults too", async () => {
    saveMirrorConfig(keystore, { repo_id: REPO_ID, destination: { kind: "directory", path: join(root, "mirror") } });
    const summary = await mirrorSync(oneObjectClient(REPO_ID), REPO_ID, { keystore });
    assert.ok(!("finding" in summary), "the finding lives on mirrorStatus (doctor/view), never on the sync/push result");
  });
});
