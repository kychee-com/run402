/**
 * gitvault-byo-primary-bucket — degraded read mode (design D4, task 3.4,
 * MIRROR HALF ONLY). Behavioral tests for `gitvault-degraded-read.ts`.
 *
 * Reuses the project's own `GitvaultMemoryTransport` fixture (`makeVault` /
 * `commitFile` / `git`) to build a REAL, protocol-valid vault, and a
 * `DirectoryMirrorBackend` seeded directly from the fixture's in-memory
 * object store — the same pattern `gitvault-mirror-recover.test.ts` uses
 * (real signed heads, real encrypted objects, not hand-rolled fixture
 * bytes).
 *
 * Run: node --test --import tsx sdk/src/node/gitvault-degraded-read.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, LocalError, NetworkError, PaymentAttemptError, Unauthorized } from "../errors.js";
import { GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT } from "../namespaces/gitvault.crypto.js";
import { commitFile, makeVault } from "./gitvault-memory-transport.test.js";
import { DirectoryMirrorBackend, openGitvaultMirrorBackend, type GitvaultMirrorBackend } from "./gitvault-mirror-backend.js";
import type { GitvaultMirrorDestination } from "./gitvault-mirror-config.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import { saveMirrorConfig } from "./gitvault-mirror-config.js";
import { isNetworkClassGitvaultReadError, resolveDegradedReadSource, tryGitvaultDegradedRead } from "./gitvault-degraded-read.js";

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Reproduces `gitvault-mirror-recover.test.ts`'s own `toRepoRelativeGatewayKey`
 * / `transportEntries` / `seedBackend` trio — a raw copy of the fixture's
 * stored bytes into a directory backend is exactly what a completed `mirror
 * sync` produces (see that file's own doc comment for why the key_envelope
 * translation matters).
 */
function toRepoRelativeGatewayKey(key: string): string {
  const m = /^envelopes\/([0-9a-f]{16})\/(ek_[0-9a-f]{32})$/.exec(key);
  return m ? `key-envelopes/${m[1]}/${m[2]}.env` : key;
}

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

/** A backend that refuses (and counts) every call — the "zero mirror I/O" probe. */
function refusingBackend(): { backend: GitvaultMirrorBackend; calls: () => number } {
  let calls = 0;
  const fail = (): never => {
    calls += 1;
    throw new Error("server/mirror-blindness violation: a mirror backend method was called");
  };
  const backend: GitvaultMirrorBackend = {
    describe: () => "refusing://backend",
    head: async () => fail(),
    get: async () => fail(),
    putCreateOnly: async () => fail(),
    list: async () => fail(),
  };
  return { backend, calls: () => calls };
}

// ─── Trigger discipline (isNetworkClassGitvaultReadError) ────────────────────

describe("gitvault degraded read — trigger discipline (design D4)", () => {
  it("a NetworkError (fetch threw before any response) is network-class", () => {
    assert.equal(isNetworkClassGitvaultReadError(new NetworkError("boom", new Error("ECONNREFUSED"), "ctx")), true);
  });

  it("an unbranded raw throw (the shape a DNS/connect failure ACTUALLY takes through gitvault's own direct-fetch reads) is network-class", () => {
    assert.equal(isNetworkClassGitvaultReadError(new TypeError("fetch failed")), true);
    assert.equal(isNetworkClassGitvaultReadError("a plain string throw"), true);
  });

  it("the payment-capable client's X402_INITIAL_REQUEST_FAILED (no response ever existed) is network-class; a later-phase payment failure is not", () => {
    const mk = (code: string) =>
      new PaymentAttemptError({ code, message: "m", phase: "initial_request" as never, paymentAttemptId: "pat_x", providerStarted: false, mutationState: "not_started" as never, safeToRetry: true, cause: new TypeError("fetch failed") });
    assert.equal(isNetworkClassGitvaultReadError(mk("X402_INITIAL_REQUEST_FAILED")), true);
    assert.equal(isNetworkClassGitvaultReadError(mk("X402_PAYMENT_SIGNING_FAILED")), false);
  });

  it("a typed 5xx ApiError is network-class", () => {
    assert.equal(isNetworkClassGitvaultReadError(new ApiError("boom", 500, null, "ctx")), true);
    assert.equal(isNetworkClassGitvaultReadError(new ApiError("boom", 503, null, "ctx")), true);
  });

  it("a typed 401/403/404 is NEVER network-class — an authorization refusal must not silently reroute", () => {
    assert.equal(isNetworkClassGitvaultReadError(new Unauthorized("boom", 401, null, "ctx")), false);
    assert.equal(isNetworkClassGitvaultReadError(new Unauthorized("boom", 403, null, "ctx")), false);
    assert.equal(isNetworkClassGitvaultReadError(new ApiError("boom", 404, null, "ctx")), false);
  });

  it("a typed 400 is not network-class", () => {
    assert.equal(isNetworkClassGitvaultReadError(new ApiError("boom", 400, null, "ctx")), false);
  });

  it("gitvault's own direct-fetch reads (getGenerationBytes/getObjectBytes) throw via a LocalError with the real HTTP status folded into details.status — a 5xx there is STILL network-class", () => {
    const e = new LocalError("heads/… read failed (HTTP 500)", "reading gitvault heads", { code: "GITVAULT_OBJECT_READ_FAILED", details: { generation: "0000000000000001", status: 500 } });
    assert.equal(e.status, null, "sanity: LocalError always reports status: null on e.status itself");
    assert.equal(isNetworkClassGitvaultReadError(e), true);
  });

  it("...and a 403 through that SAME path is NOT network-class", () => {
    const e = new LocalError("access denied", "reading gitvault heads", { code: "GITVAULT_ACCESS_DENIED", details: { generation: "0000000000000001", status: 403 } });
    assert.equal(isNetworkClassGitvaultReadError(e), false);
  });

  it("a protocol/chain error with no status signal at all is not network-class (never folded into a generic 'try the mirror')", () => {
    const e = new LocalError("head 0000000000000002 does not match the chain during restore", "restoring gitvault objects", { code: "CHAIN_BROKEN" });
    assert.equal(isNetworkClassGitvaultReadError(e), false);
  });
});

// ─── tryGitvaultDegradedRead — retry/fallback orchestration ──────────────────

describe("gitvault degraded read — retry and fallback orchestration", () => {
  it("a 4xx/authorization failure is NEVER retried and NEVER falls back — the original error surfaces unchanged, and attemptLive is called exactly once", async () => {
    let calls = 0;
    const original = new Unauthorized("nope", 403, { code: "GITVAULT_ACCESS_DENIED" }, "ctx");
    const attemptLive = async (): Promise<never> => {
      calls += 1;
      throw original;
    };
    const { backend, calls: backendCalls } = refusingBackend();
    await assert.rejects(
      tryGitvaultDegradedRead({ attemptLive, keystore: GitvaultKeystore.open({ rootDir: scratchDir("run402-degraded-ks-403-") }), repo_id: "src_" + "1".repeat(32), out_dir: scratchDir("run402-degraded-out-403-"), backend }),
      (e: unknown) => e === original,
    );
    assert.equal(calls, 1, "a 4xx must never be retried");
    assert.equal(backendCalls(), 0, "a 4xx must never touch the fallback backend");
  });

  it("a network-class failure gets ONE bounded retry against the live attempt before falling back", async () => {
    let calls = 0;
    const attemptLive = async (): Promise<never> => {
      calls += 1;
      throw new NetworkError("down", new Error("ECONNREFUSED"), "ctx");
    };
    const { backend } = refusingBackend(); // out_dir is null below, so the fallback never opens the backend either
    await assert.rejects(tryGitvaultDegradedRead({ attemptLive, keystore: GitvaultKeystore.open({ rootDir: scratchDir("run402-degraded-ks-retry-") }), repo_id: "src_" + "2".repeat(32), out_dir: null, backend }));
    assert.equal(calls, 2, "exactly one bounded retry — the live attempt plus one more");
  });

  it("no fallback source configured (no mirror) → the ORIGINAL error surfaces unchanged, and zero mirror I/O happens", async () => {
    const original = new NetworkError("down", new Error("ECONNREFUSED"), "ctx");
    const attemptLive = async (): Promise<never> => {
      throw original;
    };
    const keystore = GitvaultKeystore.open({ rootDir: scratchDir("run402-degraded-ks-nomirror-") });
    const repoId = "src_" + "3".repeat(32);
    // No saveMirrorConfig call at all — resolveDegradedReadSource must return null.
    assert.equal(resolveDegradedReadSource(keystore, repoId), null, "sanity: no mirror configured for this repo id");
    await assert.rejects(
      tryGitvaultDegradedRead({ attemptLive, keystore, repo_id: repoId, out_dir: scratchDir("run402-degraded-out-nomirror-") }),
      (e: unknown) => e === original,
    );
  });

  it("out_dir: null disables the fallback even with a mirror configured — nowhere to materialize into", async () => {
    const original = new NetworkError("down", new Error("ECONNREFUSED"), "ctx");
    const attemptLive = async (): Promise<never> => {
      throw original;
    };
    const { backend, calls } = refusingBackend();
    await assert.rejects(
      tryGitvaultDegradedRead({ attemptLive, keystore: GitvaultKeystore.open({ rootDir: scratchDir("run402-degraded-ks-nodir-") }), repo_id: "src_" + "4".repeat(32), out_dir: null, backend }),
      (e: unknown) => e === original,
    );
    assert.equal(calls(), 0);
  });

  it("a genuinely successful live attempt never touches the fallback at all", async () => {
    const { backend, calls } = refusingBackend();
    const live = { refs: { "refs/heads/main": "a".repeat(40) }, head_target: { kind: "symref" as const, ref: "refs/heads/main" }, generation: "0000000000000001" };
    const outcome = await tryGitvaultDegradedRead({ attemptLive: async () => live, keystore: GitvaultKeystore.open({ rootDir: scratchDir("run402-degraded-ks-live-") }), repo_id: "src_" + "5".repeat(32), out_dir: scratchDir("run402-degraded-out-live-"), backend });
    assert.deepEqual(outcome, { degraded: false, live });
    assert.equal(calls(), 0);
  });
});

// ─── Successful degraded read against a real, protocol-valid vault ───────────

describe("gitvault degraded read — served from a real DirectoryMirrorBackend", () => {
  it("degrades to the mirror: correct refs/generation, degraded: true, source provenance, validity-not-freshness stated verbatim", async () => {
    const f = await makeVault();
    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });

    const mirrorRoot = scratchDir("run402-degraded-mirror-");
    // `resolveDegradedReadSource` (via `openGitvaultMirrorBackend`) opens a
    // REPO-SCOPED backend rooted at `<destination>/source/<repo_id>` — seed
    // through the SAME factory so the layout matches exactly what a real
    // `mirror sync` against this destination would leave on disk.
    const destination: GitvaultMirrorDestination = { kind: "directory", path: mirrorRoot };
    const backend = openGitvaultMirrorBackend(destination, f.repoId);
    await seedBackend(backend, transportEntries(f.transport, f.repoId));
    saveMirrorConfig(f.keystore, { repo_id: f.repoId, destination });

    let attempts = 0;
    const outDir = scratchDir("run402-degraded-out-golden-");
    const outcome = await tryGitvaultDegradedRead({
      attemptLive: async () => {
        attempts += 1;
        throw new NetworkError("run402 is unreachable", new Error("ECONNREFUSED"), "listing gitvault vault objects");
      },
      keystore: f.keystore,
      repo_id: f.repoId,
      out_dir: outDir,
    });

    assert.equal(attempts, 2, "the bounded retry ran before falling back");
    assert.equal(outcome.degraded, true);
    if (!outcome.degraded) throw new Error("unreachable");
    assert.equal(outcome.result.degraded, true);
    assert.equal(outcome.result.refs["refs/heads/main"], c1);
    assert.equal(outcome.result.generation, "0000000000000001");
    assert.equal(outcome.result.head_target.kind, "symref");
    assert.equal(outcome.result.source.kind, "mirror");
    assert.equal(outcome.result.source.destination, mirrorRoot);
    assert.equal(outcome.result.source.credential_kind, null, "a directory destination carries no credential");
    assert.equal(outcome.result.validity_not_freshness, GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT);

    rmSync(mirrorRoot, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it("materializing into a checkout's OWN .git (the remote helper's degraded fetch) leaves it a non-bare repository with its working tree intact", async () => {
    const f = await makeVault();
    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const destination: GitvaultMirrorDestination = { kind: "directory", path: scratchDir("run402-degraded-mirror-wt-") };
    await seedBackend(openGitvaultMirrorBackend(destination, f.repoId), transportEntries(f.transport, f.repoId));
    saveMirrorConfig(f.keystore, { repo_id: f.repoId, destination });

    // A checkout git already prepared: non-bare, with a working tree.
    const worktree = scratchDir("run402-degraded-checkout-");
    execFileSync("git", ["init", "-q", "-b", "main", worktree]);
    const gitDir = join(worktree, ".git");
    assert.equal(execFileSync("git", ["-C", worktree, "config", "--get", "core.bare"]).toString().trim(), "false");

    const outcome = await tryGitvaultDegradedRead({
      attemptLive: async () => {
        throw new NetworkError("run402 is unreachable", new Error("ECONNREFUSED"), "restoring gitvault objects");
      },
      keystore: f.keystore,
      repo_id: f.repoId,
      out_dir: gitDir,
    });
    assert.equal(outcome.degraded, true);
    if (!outcome.degraded) throw new Error("unreachable");
    assert.equal(outcome.result.refs["refs/heads/main"], c1);
    assert.equal(execFileSync("git", ["-C", worktree, "config", "--get", "core.bare"]).toString().trim(), "false", "the checkout's git dir must stay non-bare");
    assert.equal(execFileSync("git", ["-C", worktree, "rev-parse", "--is-inside-work-tree"]).toString().trim(), "true");
    assert.equal(execFileSync("git", ["-C", worktree, "cat-file", "-t", c1]).toString().trim(), "commit", "the recovered objects landed in the checkout's own object database");
  });

  it("pins bounded: a mirror missing a later generation's own wal pack (a torn/behind copy) yields the earlier valid generation — never the unmaterializable newest one", async () => {
    const f = await makeVault();
    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } });
    const c2 = await commitFile(f.repoDir, "b.txt", "b\n");
    const gen2 = await f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: c1, new_oid: c2, force: false }] } });

    const mirrorRoot = scratchDir("run402-degraded-mirror-torn-");
    const destination: GitvaultMirrorDestination = { kind: "directory", path: mirrorRoot };
    const backend = openGitvaultMirrorBackend(destination, f.repoId);
    const entries = transportEntries(f.transport, f.repoId);
    const gen2WalId = gen2.head.wal_entries[0]!.object_id;
    const gen2WalKey = `wal/${gen2WalId}.pack.enc`;
    // Seed everything EXCEPT generation 2's own wal pack — a torn/behind mirror.
    await seedBackend(backend, entries.filter((e) => e.key !== gen2WalKey));
    saveMirrorConfig(f.keystore, { repo_id: f.repoId, destination });

    const outDir = scratchDir("run402-degraded-out-torn-");
    const outcome = await tryGitvaultDegradedRead({
      attemptLive: async () => {
        throw new NetworkError("down", new Error("ECONNREFUSED"), "ctx");
      },
      keystore: f.keystore,
      repo_id: f.repoId,
      out_dir: outDir,
    });

    assert.equal(outcome.degraded, true);
    if (!outcome.degraded) throw new Error("unreachable");
    assert.equal(outcome.result.generation, "0000000000000001", "must fall back to the last generation that fully materializes from this mirror");
    assert.equal(outcome.result.refs["refs/heads/main"], c1, "recovered at the fallback generation, not the (unmaterializable) newest one — local trust pins never advance past what the copy chain-verifies");

    rmSync(mirrorRoot, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });
});

// ─── Writes are never rerouted ────────────────────────────────────────────────

describe("gitvault degraded read — writes are never rerouted (D194: admission is irreducibly live-server)", () => {
  it("a push during a simulated gateway outage still fails, and performs ZERO mirror writes, even with a mirror configured", async () => {
    const f = await makeVault();

    const mirrorRoot = scratchDir("run402-degraded-mirror-push-");
    const realBackend = new DirectoryMirrorBackend(mirrorRoot);
    saveMirrorConfig(f.keystore, { repo_id: f.repoId, destination: { kind: "directory", path: mirrorRoot } });
    // Sanity: this vault DOES have a mirror configured — if pushes silently
    // rerouted to it, this is the destination that would receive writes.
    assert.notEqual(resolveDegradedReadSource(f.keystore, f.repoId), null);

    const originalAdmitHead = f.transport.admitHead.bind(f.transport);
    const originalPutCreateOnly = realBackend.putCreateOnly.bind(realBackend);
    let putCreateOnlyCalls = 0;
    // Count writes against the REAL, reachable, configured mirror backend —
    // `vault.push()` takes no backend argument at all, so this is checking
    // that the push path never even LOOKS for one, not merely that a stub
    // refused.
    realBackend.putCreateOnly = (key, bytes) => {
      putCreateOnlyCalls += 1;
      return originalPutCreateOnly(key, bytes);
    };
    f.transport.admitHead = async () => {
      throw new NetworkError("run402 is unreachable", new Error("ECONNREFUSED"), "admitting gitvault head");
    };

    const c1 = await commitFile(f.repoDir, "a.txt", "a\n");
    await assert.rejects(
      f.vault.push({ transaction: { updates: [{ ref: "refs/heads/main", expected_old_oid: null, new_oid: c1, force: false }] } }),
      (e: unknown) => e instanceof NetworkError,
    );
    assert.equal(putCreateOnlyCalls, 0, "a failed push must never write to the mirror — writes are never rerouted");

    f.transport.admitHead = originalAdmitHead;
    rmSync(mirrorRoot, { recursive: true, force: true });
  });
});
