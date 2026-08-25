/**
 * gitvault D2 — lazy allocation on first push (repo-first-onramp task 2.2).
 *
 * `openOrCreateGitvault` is the primitive the remote helper and the capture
 * lane (`run402 gitvault push`/`snapshot`) drive so a push against an
 * unallocated project runs the six-stage creation journal inline. Exercised
 * against the same `GitvaultMemoryTransport` fixture every other
 * creation/deploy test uses — this is orchestration on top of an
 * already-proven journal, not a re-proof of the journal itself.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalError } from "../errors.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { createGitvault, listIncompleteGitvaultJournals, readGitvaultJournal } from "./gitvault-creation-journal.js";
import { GitvaultMemoryTransport } from "./gitvault-memory-transport.test.js";
import { openOrCreateGitvault } from "./gitvault-open-or-create.js";

let root: string;
let keystore: GitvaultKeystore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run402-gitvault-open-or-create-"));
  keystore = GitvaultKeystore.open({ rootDir: join(root, "ks") });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ORG = "org_1";
const PROJECT = "proj_1";

describe("openOrCreateGitvault — found (the common case)", () => {
  it("resolves without creating anything when the vault already exists", async () => {
    const transport = new GitvaultMemoryTransport();
    const created = await createGitvault({ keystore, transport, org_id: ORG, project_id: PROJECT, service_public_key: transport.service.public_key });
    assert.equal(transport.calls.filter((c) => c === "allocate").length, 1);

    const r = await openOrCreateGitvault({ keystore, transport, project_id: PROJECT, org_id: ORG });

    assert.equal(r.found, true);
    assert.equal(r.repo_id, created.repo_id);
    assert.equal(r.created, null);
    // No SECOND allocate call — resolving an existing vault costs one read, nothing more.
    assert.equal(transport.calls.filter((c) => c === "allocate").length, 1);
  });
});

describe("openOrCreateGitvault — unresolved and no org_id: byte-identical to a plain resolve", () => {
  it("rethrows the original resolution failure unchanged", async () => {
    const transport = new GitvaultMemoryTransport();
    await assert.rejects(
      openOrCreateGitvault({ keystore, transport, project_id: PROJECT }),
      (err: unknown) => {
        assert.ok(err instanceof LocalError);
        assert.equal((err as LocalError).code, "RESOURCE_NOT_FOUND");
        return true;
      },
    );
    // No creation was attempted — no journal, no allocate call.
    assert.equal(transport.calls.length, 1, "exactly the one failed find-vault read");
    assert.equal(listIncompleteGitvaultJournals(keystore).length, 0);
  });
});

describe("openOrCreateGitvault — unresolved and org_id supplied: lazy creation (D2)", () => {
  it("allocates the vault and reports it as freshly created", async () => {
    const transport = new GitvaultMemoryTransport();

    const r = await openOrCreateGitvault({ keystore, transport, project_id: PROJECT, org_id: ORG });

    assert.equal(r.found, false);
    assert.ok(r.repo_id.startsWith("src_"));
    assert.ok(r.created);
    assert.equal(r.created!.deduplicated, false);
    assert.ok(r.created!.recovery_receipt);
    assert.ok(r.created!.genesis_sha256);
    // The journal reached ACTIVE — nothing left incomplete.
    assert.equal(listIncompleteGitvaultJournals(keystore).length, 0);

    // Idempotent: opening again finds it, allocates nothing further.
    const second = await openOrCreateGitvault({ keystore, transport, project_id: PROJECT, org_id: ORG });
    assert.equal(second.found, true);
    assert.equal(second.repo_id, r.repo_id);
    assert.equal(transport.calls.filter((c) => c === "allocate").length, 1, "still exactly one allocate ever");
  });
});

describe("openOrCreateGitvault — resumability (D2's central guarantee)", () => {
  it("a creation interrupted mid-flight is resumed by the NEXT call, not restarted as a competing attempt", async () => {
    const transport = new GitvaultMemoryTransport();

    // Simulate the process dying right after ALLOCATED: the journal is
    // durable on disk at that stage, but nothing past it happened yet — no
    // key material sealed, no genesis admitted.
    await assert.rejects(
      createGitvault({
        keystore,
        transport,
        org_id: ORG,
        project_id: PROJECT,
        service_public_key: transport.service.public_key,
        onStage: (stage) => {
          if (stage === "ALLOCATED") throw new Error("simulated crash");
        },
      }),
    );
    const incomplete = listIncompleteGitvaultJournals(keystore);
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0]!.stage, "ALLOCATED");
    const crashedId = incomplete[0]!.client_creation_id;
    assert.equal(transport.calls.filter((c) => c === "allocate").length, 1, "the allocation itself landed before the simulated crash");

    // Re-run through the REAL entry point — no client_creation_id supplied,
    // exactly as a re-pushed `git push` would call it.
    const r = await openOrCreateGitvault({ keystore, transport, project_id: PROJECT, org_id: ORG });

    assert.equal(r.found, false);
    assert.ok(r.created);
    assert.equal(r.created!.deduplicated, true, "the SAME local journal was resumed to completion, not started fresh");
    // Exactly one vault: the resumed journal's own client_creation_id, still ACTIVE.
    const resumedJournal = readGitvaultJournal(keystore, crashedId);
    assert.equal(resumedJournal?.stage, "ACTIVE");
    assert.equal(resumedJournal?.allocation?.repo_id, r.repo_id);
    // The allocate call was NEVER repeated — resume reuses the durable allocation record.
    assert.equal(transport.calls.filter((c) => c === "allocate").length, 1, "resuming must never re-allocate");
    assert.equal(listIncompleteGitvaultJournals(keystore).length, 0, "nothing left incomplete — exactly one vault, fully reconciled");

    // A THIRD call (as if the vault were being opened again on a later day)
    // finds it via the ordinary read path, no journal involved at all.
    const third = await openOrCreateGitvault({ keystore, transport, project_id: PROJECT, org_id: ORG });
    assert.equal(third.found, true);
    assert.equal(third.repo_id, r.repo_id);
  });
});
