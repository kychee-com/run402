/**
 * gitvault D6 — named addressing, id-pinning, and push-to-create
 * (repo-first-onramp task 4.5). Exercised against `GitvaultMemoryTransport`
 * (the same fixture every other creation/deploy test uses) plus a real git
 * working tree for the pin (local git config), since pinning IS local git
 * state and a fake would not prove the read/write round-trips.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalError } from "../errors.js";
import { gitvaultRemoteAddressForm, gitvaultRemoteUrl, gitvaultRemoteUrlForRepo, gitvaultSlugReleasedInfo, parseGitvaultRemoteUrl } from "../namespaces/gitvault.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { findResumablePushToCreateJournal, listIncompleteGitvaultJournals, readGitvaultJournal } from "./gitvault-creation-journal.js";
import { GitvaultMemoryTransport, makeRepo } from "./gitvault-memory-transport.test.js";
import { pinGitvaultRepo, readPinnedGitvaultRepo, resolveGitvaultAddress } from "./gitvault-address.js";
import { pushToCreateGitvault } from "./gitvault-push-to-create.js";

let root: string;
let keystore: GitvaultKeystore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run402-gitvault-address-"));
  keystore = GitvaultKeystore.open({ rootDir: join(root, "ks") });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── address form discrimination ──────────────────────────────────────────

describe("gitvaultRemoteAddressForm", () => {
  it("classifies a UUID org id + prj_-prefixed project id as id-form", () => {
    assert.equal(gitvaultRemoteAddressForm({ org_id: "11111111-1111-4111-8111-111111111111", project_id: "prj_abc123" }), "id");
  });
  it("classifies a non-UUID org half as slug-form even when the name half is prj_-prefixed", () => {
    assert.equal(gitvaultRemoteAddressForm({ org_id: "acme", project_id: "prj_abc123" }), "slug");
  });
  it("classifies a non-prj_ name half as slug-form even when the org half is a UUID", () => {
    assert.equal(gitvaultRemoteAddressForm({ org_id: "11111111-1111-4111-8111-111111111111", project_id: "my-notes" }), "slug");
  });
  it("classifies an ordinary org-slug/name pair as slug-form", () => {
    assert.equal(gitvaultRemoteAddressForm({ org_id: "acme", project_id: "my-notes" }), "slug");
  });
});

describe("gitvaultRemoteUrlForRepo / parseGitvaultRemoteUrl round-trip", () => {
  it("round-trips a slug-form address", () => {
    const url = gitvaultRemoteUrlForRepo("acme", "my-notes");
    assert.equal(url, "run402::acme/my-notes");
    const parsed = parseGitvaultRemoteUrl(url);
    assert.deepEqual(parsed, { org_id: "acme", project_id: "my-notes" });
    assert.equal(gitvaultRemoteAddressForm(parsed!), "slug");
  });
  it("id-form (gitvaultRemoteUrl) still parses to id-form", () => {
    const url = gitvaultRemoteUrl("11111111-1111-4111-8111-111111111111", "prj_abc123");
    const parsed = parseGitvaultRemoteUrl(url)!;
    assert.equal(gitvaultRemoteAddressForm(parsed), "id");
  });
});

// ─── resolveGitvaultAddress — id-form ──────────────────────────────────────

describe("resolveGitvaultAddress — id-form", () => {
  it("resolves via findVaultByProject and pins repo_id (design D4 — no resolved_from, id-form has no slug pair)", async () => {
    const transport = new GitvaultMemoryTransport();
    // A REAL, fully-created vault (not a bare allocate) — findVaultByProject
    // only resolves once the fixture's objects actually exist, matching D2's
    // own "vault existence" convention (see the fixture's own doc comment).
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport, org_id: "org_1", project_id: "prj_1" });

    const repoDir = await makeRepo(root);
    const resolution = await resolveGitvaultAddress({
      keystore, transport,
      address: { org_id: "11111111-1111-4111-8111-111111111111", project_id: "prj_1" },
      repo_dir: repoDir,
    });
    assert.equal(resolution.form, "id");
    assert.equal(resolution.via, "resolved");
    assert.equal(resolution.repo_id, allocation.repo_id);
    assert.equal(resolution.address, null);
    // gitvault-client-round-trips design D4: the first successful id-form
    // resolution pins repo_id too — no `resolved_from` (id-form has no
    // org-slug/name pair to record diagnostically).
    assert.deepEqual(await readPinnedGitvaultRepo(repoDir), { repo_id: allocation.repo_id, resolved_from: null });
  });

  it("a second id-form resolution follows the pin — never calls findVaultByProject again", async () => {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport, org_id: "org_1", project_id: "prj_1" });
    const repoDir = await makeRepo(root);
    const address = { org_id: "11111111-1111-4111-8111-111111111111", project_id: "prj_1" };

    const first = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(first.via, "resolved");
    const callsBeforeSecond = transport.calls.filter((c) => c === "find-vault").length;
    assert.ok(callsBeforeSecond > 0, "sanity: the first call really did resolve over the network");

    const second = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(second.via, "pin");
    assert.equal(second.repo_id, allocation.repo_id);
    assert.equal(second.form, "id");
    // Proves the pin path never called findVaultByProject a second time — only getVaultRecord.
    assert.equal(transport.calls.filter((c) => c === "find-vault").length, callsBeforeSecond);
  });

  it("a stale id-form pin (repo_id no longer resolves) clears and re-resolves once", async () => {
    const inner = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport: inner, org_id: "org_1", project_id: "prj_1" });
    const repoDir = await makeRepo(root);
    const address = { org_id: "11111111-1111-4111-8111-111111111111", project_id: "prj_1" };
    await pinGitvaultRepo(repoDir, allocation.repo_id);
    assert.notEqual(await readPinnedGitvaultRepo(repoDir), null);

    // The fixture's own getVaultRecord/findVaultByProject never model "the
    // vault is genuinely gone" (they always return a best-effort record) —
    // a thin wrapper simulates the purge honestly: BOTH the pin-check's
    // getVaultRecord AND the id-form fallback's findVaultByProject 404,
    // exactly what a deleted/purged vault looks like from either route.
    let getVaultRecordCalls = 0;
    let findVaultByProjectCalls = 0;
    const transport = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "getVaultRecord") {
          return async (req: { repo_id: string }) => {
            getVaultRecordCalls += 1;
            if (req.repo_id === allocation.repo_id) throw new LocalError("no such vault", "reading the gitvault record", { code: "RESOURCE_NOT_FOUND" });
            return target.getVaultRecord(req);
          };
        }
        if (prop === "findVaultByProject") {
          return async (req: { project_id: string }) => {
            findVaultByProjectCalls += 1;
            throw new LocalError(`no gitvault for ${req.project_id}`, "resolving the project's gitvault", { code: "RESOURCE_NOT_FOUND" });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await assert.rejects(
      resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir }),
      (e: unknown) => {
        assert.ok(e instanceof LocalError);
        assert.equal((e as LocalError).code, "RESOURCE_NOT_FOUND");
        return true;
      },
    );
    assert.equal(getVaultRecordCalls, 1, "the pin was checked exactly once before being cleared");
    assert.equal(findVaultByProjectCalls, 1, "cleared the pin and re-resolved via findVaultByProject exactly once before failing");
    // The stale pin was cleared, not left dangling.
    assert.equal(await readPinnedGitvaultRepo(repoDir), null);
  });
});

// ─── resolveGitvaultAddress — slug-form, resolve-only (no create) ─────────

describe("resolveGitvaultAddress — slug-form, allow_create: false", () => {
  it("a miss on an unresolvable slug-form address is an ordinary not-found refusal, never a creation", async () => {
    const transport = new GitvaultMemoryTransport();
    const repoDir = await makeRepo(root);
    await assert.rejects(
      resolveGitvaultAddress({ keystore, transport, address: { org_id: "acme", project_id: "my-notes" }, repo_dir: repoDir, allow_create: false }),
      (e: unknown) => {
        assert.ok(e instanceof LocalError);
        assert.equal((e as LocalError).code, "RESOURCE_NOT_FOUND");
        return true;
      },
    );
    assert.equal(transport.calls.filter((c) => c === "allocate").length, 0, "a read-only resolution must never allocate");
    assert.equal(await readPinnedGitvaultRepo(repoDir), null);
  });
});

// ─── id-pinning (task 4.5's central guarantee) ─────────────────────────────

describe("resolveGitvaultAddress — slug-form id-pinning", () => {
  it("pins repo_id on first resolution, and every later open follows the PIN, surviving a rename", async () => {
    const transport = new GitvaultMemoryTransport();
    const repoDir = await makeRepo(root);

    const first = await resolveGitvaultAddress({
      keystore, transport,
      address: { org_id: "acme", project_id: "my-notes" },
      repo_dir: repoDir, allow_create: true,
    });
    assert.equal(first.via, "created");
    assert.equal(first.form, "slug");

    const pinned = await readPinnedGitvaultRepo(repoDir);
    assert.ok(pinned);
    assert.equal(pinned!.repo_id, first.repo_id);
    assert.deepEqual(pinned!.resolved_from, { org_slug: "acme", repo_name: "my-notes" });

    // Simulate a RENAME: the org slug "acme" no longer resolves to anything
    // (a real rename would move it to a NEW slug, or into cooldown) — the
    // repoNames entry for the OLD address is removed here to model that.
    transport.repoNames.delete("acme/my-notes");
    const callsBeforeSecond = transport.calls.filter((c) => c === "find-vault-by-repo").length;

    // A SECOND resolution of the SAME checkout follows the PIN — never
    // touches the (now-broken) slug resolution at all.
    const second = await resolveGitvaultAddress({
      keystore, transport,
      address: { org_id: "acme", project_id: "my-notes" },
      repo_dir: repoDir,
    });
    assert.equal(second.via, "pin");
    assert.equal(second.repo_id, first.repo_id);
    assert.equal(second.project_id, first.project_id);
    assert.equal(second.org_id, first.org_id);
    // Proves the pin path never called findVaultByRepo (which would have
    // failed against the deleted repoNames entry) — only getVaultRecord.
    assert.equal(transport.calls.filter((c) => c === "find-vault-by-repo").length, callsBeforeSecond);
  });

  it("pinGitvaultRepo omits resolvedFrom for an id-form pin — reads back as resolved_from: null", async () => {
    const repoDir = await makeRepo(root);
    assert.equal(await readPinnedGitvaultRepo(repoDir), null);
    await pinGitvaultRepo(repoDir, "src_deadbeef"); // no third argument — the id-form shape
    const pinned = await readPinnedGitvaultRepo(repoDir);
    assert.deepEqual(pinned, { repo_id: "src_deadbeef", resolved_from: null });
  });

  it("pinGitvaultRepo / readPinnedGitvaultRepo round-trip directly", async () => {
    const repoDir = await makeRepo(root);
    assert.equal(await readPinnedGitvaultRepo(repoDir), null);
    await pinGitvaultRepo(repoDir, "src_deadbeef", { org_slug: "acme", repo_name: "widgets" });
    const pinned = await readPinnedGitvaultRepo(repoDir);
    assert.deepEqual(pinned, { repo_id: "src_deadbeef", resolved_from: { org_slug: "acme", repo_name: "widgets" } });
  });
});

// ─── push-to-create (task 4.4/4.5, design D6) ──────────────────────────────

describe("pushToCreateGitvault — the happy path", () => {
  it("allocates a NEW project + vault atomically when the address does not resolve yet", async () => {
    const transport = new GitvaultMemoryTransport();
    const result = await pushToCreateGitvault({ keystore, transport, org_slug: "acme", repo_name: "my-notes" });
    assert.equal(result.found, false);
    assert.ok(result.repo_id.startsWith("src_"));
    assert.ok(result.project_id.startsWith("prj_"));
    assert.equal(result.org_id, "org_acme");
    assert.ok(result.created);
    assert.equal(result.created!.deduplicated, false);
    assert.equal(listIncompleteGitvaultJournals(keystore).length, 0);

    // A SECOND push-to-create call for the SAME address is an ordinary
    // resolve (the fast path) — no second allocate.
    const second = await pushToCreateGitvault({ keystore, transport, org_slug: "acme", repo_name: "my-notes" });
    assert.equal(second.found, true);
    assert.equal(second.repo_id, result.repo_id);
    assert.equal(transport.calls.filter((c) => c === "allocate").length, 1, "still exactly one allocate ever");
  });

  it("resumes an interrupted push-to-create journal by (org_slug, repo_name), not a fresh one", async () => {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    await assert.rejects(
      createGitvault({
        keystore, transport, push_to_create: { org_slug: "acme", repo_name: "my-notes" },
        onStage: (stage) => { if (stage === "ALLOCATED") throw new Error("simulated crash"); },
      }),
    );
    const incomplete = listIncompleteGitvaultJournals(keystore);
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0]!.push_to_create?.org_slug, "acme");
    assert.equal(incomplete[0]!.org_id, "org_acme", "ALLOCATED already pinned org_id/project_id from the response");
    const resumable = findResumablePushToCreateJournal(keystore, "acme", "my-notes");
    assert.equal(resumable?.client_creation_id, incomplete[0]!.client_creation_id);

    const result = await pushToCreateGitvault({ keystore, transport, org_slug: "acme", repo_name: "my-notes" });
    assert.equal(result.found, false);
    assert.equal(result.created!.deduplicated, true);
    assert.equal(readGitvaultJournal(keystore, incomplete[0]!.client_creation_id)?.stage, "ACTIVE");
    assert.equal(transport.calls.filter((c) => c === "allocate").length, 1, "resuming must never re-allocate");
  });
});

describe("pushToCreateGitvault — REPO_CREATION_CONFLICT (design D6's race)", () => {
  it("the LOSER resolves to the WINNER's repo and proceeds as an ordinary push; zero orphans", async () => {
    const transport = new GitvaultMemoryTransport();

    // Two DIFFERENT principals racing the identical (org_slug, repo_name).
    // The fixture's synchronous check-and-reserve inside `allocate()` means
    // whichever push's SYNCHRONOUS portion runs first wins deterministically
    // — exactly the ordering `Promise.all` produces, and analogous to how the
    // real gateway's atomic PRIMARY KEY reservation decides a genuine race.
    const winnerKeystore = GitvaultKeystore.open({ rootDir: join(root, "ks-winner") });
    const loserKeystore = GitvaultKeystore.open({ rootDir: join(root, "ks-loser") });

    const [winner, loser] = await Promise.all([
      pushToCreateGitvault({ keystore: winnerKeystore, transport, org_slug: "acme", repo_name: "my-notes" }),
      pushToCreateGitvault({ keystore: loserKeystore, transport, org_slug: "acme", repo_name: "my-notes" }),
    ]);

    // Exactly one creator; the other resolved to the SAME repo, never created its own.
    const creators = [winner, loser].filter((r) => !r.found);
    const resolvers = [winner, loser].filter((r) => r.found);
    assert.equal(creators.length, 1, "exactly one of the two racers created the repo");
    assert.equal(resolvers.length, 1, "the other resolved to the winner's repo instead of creating a second one");
    assert.equal(resolvers[0]!.repo_id, creators[0]!.repo_id, "the loser's work is not lost — it resolves to the SAME repo");
    assert.equal(resolvers[0]!.project_id, creators[0]!.project_id);
    // Zero orphans: exactly one allocate call ever landed a repo.
    assert.equal(transport.repoNames.size, 1);
    assert.equal([...transport.projectRepoIds.values()].length, 1);
  });
});

describe("pushToCreateGitvault — SLUG_RELEASED is never auto-followed", () => {
  it("rethrows the typed refusal unchanged, and creates nothing", async () => {
    const transport = new GitvaultMemoryTransport();
    transport.slugReleased.set("acme", { successor_slug: "acme-hq", released_at: "2026-06-01T00:00:00.000Z", cooldown_until: "2026-08-30T00:00:00.000Z" });

    await assert.rejects(
      pushToCreateGitvault({ keystore, transport, org_slug: "acme", repo_name: "my-notes" }),
      (e: unknown) => {
        assert.ok(e instanceof LocalError);
        assert.equal((e as LocalError).code, "SLUG_RELEASED");
        const info = gitvaultSlugReleasedInfo(e);
        assert.deepEqual(info, { successor_slug: "acme-hq", released_at: "2026-06-01T00:00:00.000Z", cooldown_until: "2026-08-30T00:00:00.000Z" });
        return true;
      },
    );
    assert.equal(transport.calls.filter((c) => c === "allocate").length, 0);
    assert.equal(listIncompleteGitvaultJournals(keystore).length, 0);
  });

  it("gitvaultSlugReleasedInfo returns null for an unrelated error", () => {
    assert.equal(gitvaultSlugReleasedInfo(new LocalError("nope", "ctx", { code: "RESOURCE_NOT_FOUND" })), null);
    assert.equal(gitvaultSlugReleasedInfo(new Error("plain")), null);
  });
});

describe("resolveGitvaultAddress — push-to-create pins on creation too", () => {
  it("pins repo_id the moment it push-to-creates, not only on a later resolve", async () => {
    const transport = new GitvaultMemoryTransport();
    const repoDir = await makeRepo(root);
    let receivedReceipt = false;
    const resolution = await resolveGitvaultAddress({
      keystore, transport,
      address: { org_id: "acme", project_id: "my-notes" },
      repo_dir: repoDir,
      allow_create: true,
      onVaultCreated: async (created) => { receivedReceipt = Boolean(created.recovery_receipt); },
    });
    assert.equal(resolution.via, "created");
    assert.ok(receivedReceipt, "onVaultCreated fired with the one-shot recovery receipt");
    const pinned = await readPinnedGitvaultRepo(repoDir);
    assert.equal(pinned?.repo_id, resolution.repo_id);
  });
});
