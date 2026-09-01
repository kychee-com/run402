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
import { pinGitvaultRepo, readPinnedGitvaultRepo, recoverStaleGitvaultPin, resolveGitvaultAddress } from "./gitvault-address.js";
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
    // org-slug/name pair to record diagnostically). Since the pin fold, it
    // also records the resolved ids so later resolutions are OFFLINE.
    assert.deepEqual(await readPinnedGitvaultRepo(repoDir), { repo_id: allocation.repo_id, resolved_from: null, project_id: resolution.project_id, org_id: resolution.org_id });
    assert.ok(resolution.project_id && resolution.org_id, "the record's ids ride into the pin");
  });

  it("a second id-form resolution follows the pin — never calls findVaultByProject again", async () => {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport, org_id: "org_1", project_id: "prj_1" });
    const repoDir = await makeRepo(root);
    const address = { org_id: "11111111-1111-4111-8111-111111111111", project_id: "prj_1" };

    const first = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(first.via, "resolved");
    assert.equal(first.offline, false);
    const callsBeforeSecond = transport.calls.length;
    assert.ok(transport.calls.filter((c) => c === "find-vault").length > 0, "sanity: the first call really did resolve over the network");

    const second = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(second.via, "pin");
    assert.equal(second.repo_id, allocation.repo_id);
    assert.equal(second.form, "id");
    // The pin fold: an id-carrying pin resolves fully OFFLINE — not one
    // transport call of any kind (the pre-fold behavior substituted a
    // per-invocation getVaultRecord validation read; that read is gone).
    assert.equal(second.offline, true);
    assert.equal(second.project_id, first.project_id);
    assert.equal(second.org_id, first.org_id);
    assert.equal(transport.calls.length, callsBeforeSecond, "an id-carrying pin makes ZERO transport calls");
  });

  it("a legacy id-less pin self-upgrades through exactly one validation read, then goes offline", async () => {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport, org_id: "org_1", project_id: "prj_1" });
    const repoDir = await makeRepo(root);
    const address = { org_id: "11111111-1111-4111-8111-111111111111", project_id: "prj_1" };
    // The pre-fold pin shape: repo_id only, no ids.
    await pinGitvaultRepo(repoDir, allocation.repo_id);

    const upgraded = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(upgraded.via, "pin");
    assert.equal(upgraded.offline, false);
    assert.equal(transport.calls.filter((c) => c === "vault-record").length, 1, "one validation read, which also fetches the ids");
    const pinned = await readPinnedGitvaultRepo(repoDir);
    assert.equal(pinned?.project_id, upgraded.project_id);
    assert.equal(pinned?.org_id, upgraded.org_id);

    const callsBeforeThird = transport.calls.length;
    const third = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(third.offline, true);
    assert.equal(transport.calls.length, callsBeforeThird, "the rewritten pin is offline from then on");
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

// ─── resolveGitvaultAddress — id-form, keystore consult (gitvault-offline-clone-resolve) ───

describe("resolveGitvaultAddress — id-form, keystore consult (gitvault-offline-clone-resolve)", () => {
  const ID_ORG = "22222222-2222-4222-8222-222222222222";
  const ID_PROJECT = "prj_keystore1";

  it("a keystore-known repo resolves with ZERO transport operations, marked via 'keystore'", async () => {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport, org_id: ID_ORG, project_id: ID_PROJECT });
    const repoDir = await makeRepo(root);
    const address = { org_id: ID_ORG, project_id: ID_PROJECT };

    const callsBefore = transport.calls.length;
    const resolution = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(resolution.form, "id");
    assert.equal(resolution.via, "keystore");
    assert.equal(resolution.offline, true);
    assert.equal(resolution.repo_id, allocation.repo_id);
    assert.equal(transport.calls.length, callsBefore, "a keystore-known repo makes zero transport calls");
    // The git-config pin is written on first successful use — exactly where
    // the network-resolved branch writes it — so every LATER invocation on
    // this checkout is a plain pin hit instead of a keystore scan.
    assert.deepEqual(await readPinnedGitvaultRepo(repoDir), { repo_id: allocation.repo_id, resolved_from: null, project_id: ID_PROJECT, org_id: ID_ORG });
  });

  it("a keystore hit needs no repo_dir at all — cwd-independent, e.g. a bare `git ls-remote`", async () => {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport, org_id: ID_ORG, project_id: ID_PROJECT });
    const address = { org_id: ID_ORG, project_id: ID_PROJECT };

    const callsBefore = transport.calls.length;
    const resolution = await resolveGitvaultAddress({ keystore, transport, address });
    assert.equal(resolution.via, "keystore");
    assert.equal(resolution.offline, true);
    assert.equal(resolution.repo_id, allocation.repo_id);
    assert.equal(transport.calls.length, callsBefore);
  });

  it("a keystore MISS falls back to findVaultByProject byte-identically — exactly one transport call", async () => {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    // Deliberately NOT id-shaped ("org_1" is not a UUID) and a different
    // project_id than the address below — the keystore's own repo file can
    // never satisfy the id-form lookup, so this is a guaranteed miss.
    const allocation = await createGitvault({ keystore, transport, org_id: "org_1", project_id: "prj_1" });
    const repoDir = await makeRepo(root);
    const address = { org_id: "33333333-3333-4333-8333-333333333333", project_id: "prj_no_local_match" };

    const resolution = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(resolution.via, "resolved");
    assert.equal(resolution.offline, false);
    assert.equal(resolution.repo_id, allocation.repo_id, "the memory transport's single-vault fixture answers regardless of the requested project_id");
    assert.equal(transport.calls.filter((c) => c === "find-vault").length, 1, "a keystore miss costs exactly the one findVaultByProject read");
  });

  it("a project_id match under a DIFFERENT org_id is a miss, never a guess", async () => {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport, org_id: ID_ORG, project_id: ID_PROJECT });
    const repoDir = await makeRepo(root);
    // Same project_id as the keystore's own repo file, a DIFFERENT (but
    // still id-shaped) org — the keystore scan must not answer this as a
    // hit just because the project half matches.
    const wrongOrgAddress = { org_id: "44444444-4444-4444-8444-444444444444", project_id: ID_PROJECT };

    const resolution = await resolveGitvaultAddress({ keystore, transport, address: wrongOrgAddress, repo_dir: repoDir });
    assert.equal(resolution.via, "resolved", "org mismatch falls through to the network — the keystore never guesses");
    assert.equal(resolution.repo_id, allocation.repo_id);
    assert.equal(transport.calls.filter((c) => c === "find-vault").length, 1);
  });

  it("the git-config pin is preferred over the keystore once it exists", async () => {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    await createGitvault({ keystore, transport, org_id: ID_ORG, project_id: ID_PROJECT });
    const repoDir = await makeRepo(root);
    const address = { org_id: ID_ORG, project_id: ID_PROJECT };

    const first = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(first.via, "keystore");

    const callsBefore = transport.calls.length;
    const second = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(second.via, "pin", "once pinned, the git-config pin answers first — the keystore scan is never reached again");
    assert.equal(second.offline, true);
    assert.equal(transport.calls.length, callsBefore);
  });

  it("slug-form addresses never consult the keystore — a miss is still an ordinary not-found refusal", async () => {
    const transport = new GitvaultMemoryTransport();
    const repoDir = await makeRepo(root);
    // Design D5: keystore maps ids, not slugs — slug-form dispatch never
    // calls findRepoByProject at all, so an empty keystore changes nothing.
    await assert.rejects(
      resolveGitvaultAddress({ keystore, transport, address: { org_id: "acme", project_id: "my-notes" }, repo_dir: repoDir, allow_create: false }),
      (e: unknown) => {
        assert.ok(e instanceof LocalError);
        assert.equal((e as LocalError).code, "RESOURCE_NOT_FOUND");
        return true;
      },
    );
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
    // failed against the deleted repoNames entry) — and, since the pin
    // fold, no other transport call either: the id-carrying pin is offline.
    assert.equal(second.offline, true);
    assert.equal(transport.calls.filter((c) => c === "find-vault-by-repo").length, callsBeforeSecond);
  });

  it("pinGitvaultRepo omits resolvedFrom for an id-form pin — reads back as resolved_from: null", async () => {
    const repoDir = await makeRepo(root);
    assert.equal(await readPinnedGitvaultRepo(repoDir), null);
    await pinGitvaultRepo(repoDir, "src_deadbeef"); // no third argument — the id-form shape
    const pinned = await readPinnedGitvaultRepo(repoDir);
    assert.deepEqual(pinned, { repo_id: "src_deadbeef", resolved_from: null, project_id: null, org_id: null });
  });

  it("pinGitvaultRepo / readPinnedGitvaultRepo round-trip directly", async () => {
    const repoDir = await makeRepo(root);
    assert.equal(await readPinnedGitvaultRepo(repoDir), null);
    await pinGitvaultRepo(repoDir, "src_deadbeef", { org_slug: "acme", repo_name: "widgets" });
    const pinned = await readPinnedGitvaultRepo(repoDir);
    assert.deepEqual(pinned, { repo_id: "src_deadbeef", resolved_from: { org_slug: "acme", repo_name: "widgets" }, project_id: null, org_id: null });
  });

  it("pinGitvaultRepo round-trips the resolved ids (the offline-pin schema)", async () => {
    const repoDir = await makeRepo(root);
    await pinGitvaultRepo(repoDir, "src_deadbeef", { org_slug: "acme", repo_name: "widgets" }, { project_id: "prj_1", org_id: "org_1" });
    const pinned = await readPinnedGitvaultRepo(repoDir);
    assert.deepEqual(pinned, { repo_id: "src_deadbeef", resolved_from: { org_slug: "acme", repo_name: "widgets" }, project_id: "prj_1", org_id: "org_1" });
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

// ─── recoverStaleGitvaultPin (gitvault-force-spelling-and-pin-fold) ────────

describe("recoverStaleGitvaultPin — stale-pin discovery moved to first use", () => {
  /** An id-carrying pin for a REAL vault, plus the address that resolves it. */
  async function pinnedFixture() {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport, org_id: "org_1", project_id: "prj_1" });
    const repoDir = await makeRepo(root);
    const address = { org_id: "11111111-1111-4111-8111-111111111111", project_id: "prj_1" };
    const first = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    const resolution = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(resolution.offline, true, "sanity: the fixture's second resolution is the offline-pin shape");
    return { transport, allocation, repoDir, address, first, resolution };
  }

  it("a vault-absent failure under an offline pin re-resolves to the NEW vault and rewrites the pin", async () => {
    const f = await pinnedFixture();
    // The project has been re-allocated a NEW vault (delete + recreate):
    // resolution by project id now answers a different repo.
    const transport = new Proxy(f.transport, {
      get(target, prop, receiver) {
        if (prop === "findVaultByProject") {
          return async () => ({ ...(await target.getVaultRecord({ repo_id: f.allocation.repo_id })), repo_id: "src_recreated" });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const fresh = await recoverStaleGitvaultPin({
      keystore, transport, address: f.address, repo_dir: f.repoDir,
      resolution: f.resolution,
      error: new LocalError("denied", "materializing", { code: "GITVAULT_ACCESS_DENIED" }),
    });
    assert.ok(fresh, "a different repo_id is a recovery");
    assert.equal(fresh!.repo_id, "src_recreated");
    const pinned = await readPinnedGitvaultRepo(f.repoDir);
    assert.equal(pinned?.repo_id, "src_recreated");
    assert.ok(pinned?.project_id && pinned?.org_id, "the rewritten pin carries ids again");
  });

  it("re-resolution landing on the SAME repo_id answers null and restores the pin — the refusal is real", async () => {
    const f = await pinnedFixture();
    const fresh = await recoverStaleGitvaultPin({
      keystore, transport: f.transport, address: f.address, repo_dir: f.repoDir,
      resolution: f.resolution,
      error: new LocalError("denied", "materializing", { code: "GITVAULT_ACCESS_DENIED" }),
    });
    assert.equal(fresh, null);
    const pinned = await readPinnedGitvaultRepo(f.repoDir);
    assert.equal(pinned?.repo_id, f.resolution.repo_id, "the pin is restored, not left cleared");
    assert.ok(pinned?.project_id && pinned?.org_id);
  });

  it("a non-vault-absent error answers null with zero transport calls and an untouched pin", async () => {
    const f = await pinnedFixture();
    const callsBefore = f.transport.calls.length;
    const fresh = await recoverStaleGitvaultPin({
      keystore, transport: f.transport, address: f.address, repo_dir: f.repoDir,
      resolution: f.resolution,
      error: new LocalError("boom", "materializing", { code: "CHAIN_BROKEN" }),
    });
    assert.equal(fresh, null);
    assert.equal(f.transport.calls.length, callsBefore, "no probe for an error that cannot mean a stale pin");
    assert.equal((await readPinnedGitvaultRepo(f.repoDir))?.repo_id, f.resolution.repo_id);
  });

  it("a non-offline resolution answers null immediately — recovery is only armed for offline pins", async () => {
    const f = await pinnedFixture();
    const fresh = await recoverStaleGitvaultPin({
      keystore, transport: f.transport, address: f.address, repo_dir: f.repoDir,
      resolution: { ...f.resolution, offline: false },
      error: new LocalError("denied", "materializing", { code: "GITVAULT_ACCESS_DENIED" }),
    });
    assert.equal(fresh, null);
  });
});

// ─── recoverStaleGitvaultPin — keystore-sourced offline resolution (gitvault-offline-clone-resolve design D3) ───

describe("recoverStaleGitvaultPin — keystore-sourced offline resolution (gitvault-offline-clone-resolve)", () => {
  const ID_ORG = "55555555-5555-4555-8555-555555555555";
  const ID_PROJECT = "prj_keystore_stale";

  /**
   * A KEYSTORE-sourced offline resolution for a real vault (never a
   * git-config pin at the moment of resolving — see the `via` assertion
   * below). Once resolved, the checkout DOES also carry a freshly-written
   * pin (D1: "written on first successful use") pointing at the SAME stale
   * repo, so this fixture exercises the case where BOTH a matching keystore
   * file and a matching pin exist — the scenario where, without the D3
   * bypass, recovery's re-resolve would just re-consult the same stale
   * local answer and never reach the network.
   */
  async function keystoreFixture() {
    const transport = new GitvaultMemoryTransport();
    const { createGitvault } = await import("./gitvault-creation-journal.js");
    const allocation = await createGitvault({ keystore, transport, org_id: ID_ORG, project_id: ID_PROJECT });
    const repoDir = await makeRepo(root);
    const address = { org_id: ID_ORG, project_id: ID_PROJECT };
    const resolution = await resolveGitvaultAddress({ keystore, transport, address, repo_dir: repoDir });
    assert.equal(resolution.via, "keystore", "sanity: the fixture's resolution is the keystore-sourced offline shape");
    assert.equal(resolution.offline, true);
    return { transport, allocation, repoDir, address, resolution };
  }

  it("a vault-absent failure re-resolves over the network exactly once and lands on the NEW vault — the stale keystore file is bypassed, not re-consulted", async () => {
    const f = await keystoreFixture();
    let findVaultByProjectCalls = 0;
    const transport = new Proxy(f.transport, {
      get(target, prop, receiver) {
        if (prop === "findVaultByProject") {
          return async () => {
            findVaultByProjectCalls += 1;
            return { ...(await target.getVaultRecord({ repo_id: f.allocation.repo_id })), repo_id: "src_recreated_ks" };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const fresh = await recoverStaleGitvaultPin({
      keystore, transport, address: f.address, repo_dir: f.repoDir,
      resolution: f.resolution,
      error: new LocalError("denied", "materializing", { code: "GITVAULT_ACCESS_DENIED" }),
    });
    assert.ok(fresh, "a different repo_id from a real network re-resolve is a recovery");
    assert.equal(fresh!.repo_id, "src_recreated_ks");
    assert.equal(fresh!.via, "resolved", "the retry is a genuine network resolution, never another keystore hit");
    assert.equal(findVaultByProjectCalls, 1, "exactly one network re-resolve — without the D3 bypass this would be zero, because the keystore's own (stale) file would answer first");
    const pinned = await readPinnedGitvaultRepo(f.repoDir);
    assert.equal(pinned?.repo_id, "src_recreated_ks", "the pin is rewritten to the new vault");
  });

  it("re-resolution landing on the SAME repo_id answers null and restores the pin — the refusal is real, never laundered by re-serving the stale keystore file", async () => {
    const f = await keystoreFixture();
    let findVaultByProjectCalls = 0;
    const transport = new Proxy(f.transport, {
      get(target, prop, receiver) {
        if (prop === "findVaultByProject") {
          return async (req: { project_id: string }) => {
            findVaultByProjectCalls += 1;
            return target.findVaultByProject(req);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const fresh = await recoverStaleGitvaultPin({
      keystore, transport, address: f.address, repo_dir: f.repoDir,
      resolution: f.resolution,
      error: new LocalError("denied", "materializing", { code: "GITVAULT_ACCESS_DENIED" }),
    });
    assert.equal(fresh, null);
    assert.equal(findVaultByProjectCalls, 1, "the retry still costs one genuine network call — recovery must never be answered by re-consulting the same keystore file");
    const pinned = await readPinnedGitvaultRepo(f.repoDir);
    assert.equal(pinned?.repo_id, f.resolution.repo_id, "the pin is restored so this checkout is offline (via the pin) from here on");
  });
});
