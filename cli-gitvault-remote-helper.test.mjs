/**
 * `git-remote-run402` — the repository it operates on, proven behaviourally.
 *
 * THE DEFECT (gitvault dogfood #1, 2026-08-23). The helper took its repository
 * from `process.cwd()`. During `git clone` cwd is the directory clone was RUN
 * FROM, so `git clone run402::<org>/<project>` inside an unrelated checkout
 * both FAILED (`fatal: --stdin requires a git repository`) and left three
 * packfiles of DECRYPTED vault history in that unrelated repository, readable
 * with `git cat-file -p`, with no warning. For a product whose premise is
 * "encrypted before it leaves the machine", writing plaintext into a repo the
 * user never named is the wrong failure mode.
 *
 * WHAT IS PINNED HERE, driving the real binary over the real remote-helper
 * wire protocol:
 *   1. `fetch` with no `GIT_DIR` REFUSES, says so actionably, and writes
 *      nothing into the repository it happens to be standing in.
 *   2. `fetch` targets the repository `GIT_DIR` names — the clone case — and
 *      not cwd.
 *   3. `push` resolves its source revisions in the repository `GIT_DIR` names,
 *      before any network call, so a ref that exists only in cwd's repository
 *      is not silently published.
 *   4. `capabilities` still answers with no repository at all, so
 *      `git ls-remote run402::…` outside a checkout keeps working.
 *
 * Hermetic: `RUN402_API_BASE` points at a closed loopback port, so any network
 * attempt is a distinctly different, assertable failure. Nothing here reaches
 * a gateway.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseGitvaultHeadTargetForPush } from "./cli/git-remote-run402.mjs";

const HELPER = fileURLToPath(new URL("./cli/git-remote-run402.mjs", import.meta.url));
/** A closed port: any network attempt fails loudly and unmistakably. */
const DEAD_API = "http://127.0.0.1:9";
// ID-form: a UUID org id + a prj_-prefixed project id (repo-first-onramp
// design D6's discrimination — see `gitvaultRemoteAddressForm`). Every test
// in this file predates named addressing and exercises the ORDINARY
// project_id-addressed path, so this must classify as id-form, not
// slug-form, or these tests would silently start exercising a different
// code path (resolve-by-repo / push-to-create) the mock gateway stub below
// does not implement.
const ADDRESS = "11111111-1111-4111-8111-111111111111/prj_test";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(dir, { commit = false } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main", "."]);
  if (commit) {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "one"]);
  }
  return dir;
}

/** Every loose-object + pack file under a repository — the leak detector. */
function objectInventory(repoDir) {
  const objects = join(repoDir, ".git", "objects");
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else out.push(rel);
    }
  };
  walk(objects, "");
  return out;
}

/** Drive the helper over its wire protocol, exactly as git does. */
function runHelper({ cwd, env = {}, stdin }) {
  return spawnSync(process.execPath, [HELPER, "run402", ADDRESS], {
    cwd,
    input: stdin,
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      RUN402_API_BASE: DEAD_API,
      RUN402_CONFIG_DIR: env.RUN402_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), "run402-gvh-cfg-")),
      ...env,
    },
  });
}

describe("git-remote-run402 — repository resolution is fail-closed", () => {
  it("fetch with no GIT_DIR refuses, explains the working path, and writes NOTHING into cwd's repository", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-")));
    try {
      const decoy = makeRepo(join(root, "decoy"), { commit: true });
      const before = objectInventory(decoy);

      // git's own `GIT_DIR` deliberately absent. Before the fix this branch
      // fell through to `process.cwd()` and started decrypting into `decoy`.
      const r = runHelper({
        cwd: decoy,
        env: { GIT_DIR: undefined },
        stdin: "capabilities\n\nfetch 0000000000000000000000000000000000000000 refs/heads/main\n\n",
      });

      assert.notEqual(r.status, 0, `expected a refusal exit code, got ${r.status}\n${r.stderr}`);
      assert.match(r.stderr, /GIT_INVOCATION_REPO_UNRESOLVED/, r.stderr);
      assert.match(r.stderr, /refusing to touch a repository git did not name/, r.stderr);
      // The message must name the path that actually works — it was
      // undocumented when the dogfood found it.
      assert.match(r.stderr, /git init --bare/, r.stderr);
      // And it must not have reached a gateway: the refusal precedes the network.
      assert.doesNotMatch(r.stderr, /ECONNREFUSED|127\.0\.0\.1:9/, r.stderr);

      assert.deepEqual(objectInventory(decoy), before, "the helper wrote objects into a repository git never named");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fetch restores into the repository GIT_DIR names (the clone case), never cwd's", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-clone-")));
    try {
      const decoy = makeRepo(join(root, "decoy"), { commit: true });
      // What `git clone` hands the helper: a freshly created target repository
      // named by ABSOLUTE path in GIT_DIR, with cwd somewhere else entirely.
      const target = makeRepo(join(root, "target"));
      const targetGitDir = realpathSync(join(target, ".git"));
      const before = objectInventory(decoy);

      const r = runHelper({
        cwd: decoy,
        env: { GIT_DIR: targetGitDir },
        stdin: "capabilities\n\nfetch 0000000000000000000000000000000000000000 refs/heads/main\n\n",
      });

      // The restore itself cannot complete without a gateway; what matters is
      // WHERE it was about to write, which the helper states before it starts.
      assert.match(
        r.stderr,
        new RegExp(`restoring the vault object database for 1 ref\\(s\\) into ${targetGitDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        r.stderr,
      );
      assert.deepEqual(objectInventory(decoy), before, "the helper wrote objects into cwd's repository instead of the named one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("push resolves its source revisions in the named repository, before any network call", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-push-")));
    try {
      // `refs/heads/main` exists ONLY in the decoy. If the helper resolved
      // from cwd it would find a commit and go on to open the vault (a
      // network failure); resolving from the named repository fails locally.
      const decoy = makeRepo(join(root, "decoy"), { commit: true });
      const target = makeRepo(join(root, "target"));

      const r = runHelper({
        cwd: decoy,
        env: { GIT_DIR: realpathSync(join(target, ".git")) },
        stdin: "capabilities\n\npush refs/heads/main:refs/heads/main\n\n",
      });

      assert.match(r.stdout, /^error refs\/heads\/main /m, `${r.stdout}\n---\n${r.stderr}`);
      assert.match(r.stdout, /GIT_COMMAND_FAILED/, r.stdout);
      // Reaching the gateway would mean it had resolved a revision out of the
      // decoy — the exact confusion this test exists to forbid.
      assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /ECONNREFUSED|127\.0\.0\.1:9/, r.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("capabilities still answers with no repository at all", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-caps-")));
    try {
      const r = runHelper({ cwd: root, env: { GIT_DIR: undefined }, stdin: "capabilities\n\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "fetch\npush\noption\n\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── D2 (repo-first-onramp task 2.2) — lazy allocation on first push ─────────
//
// A live server, not the dead port above: the two things pinned here —
// `list` degrading to empty rather than erroring, and `push` actually
// REACHING the allocate route — both need a 404 the helper can read to tell
// "unallocated" apart from "unreachable". The full six-stage creation itself
// (crypto, PUT/admit wire shapes, resumability) is proven exhaustively at the
// SDK level against GitvaultMemoryTransport
// (sdk/src/node/gitvault-open-or-create.test.ts) — reimplementing that
// protocol as an HTTP fixture here would duplicate it, not add coverage.
// Recording that `POST /gitvault/v1/vaults` was reached is the wiring proof
// this layer owns: org_id came from the parsed run402::<org>/<project>
// address, all the way through to the SDK's lazy-create primitive.
//
// ASYNC spawn, not the spawnSync `runHelper` above: the mock server lives in
// THIS process, and spawnSync blocks this process's entire event loop until
// the child exits — which starves the very server the child is waiting on
// and deadlocks both sides. spawnSync only ever worked against DEAD_API
// because a closed port fails at the OS/TCP level with no event-loop
// involvement at all; a live server needs the parent free to service it.

/** Drive the helper asynchronously, so this process's event loop stays free to serve the mock gateway below. */
function runHelperAsync({ cwd, env = {}, stdin, address = ADDRESS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, "run402", address], {
      cwd,
      env: {
        ...process.env,
        RUN402_CONFIG_DIR: env.RUN402_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), "run402-gvh-cfg-")),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** A gateway stub that answers exactly the two gitvault creation routes this file needs. */
function withUnallocatedVaultGateway(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    const call = { method: req.method, url: req.url, body: "" };
    calls.push(call);
    // Captured for every request (including GET, where it stays "") — the
    // D6 push-to-create wiring test below needs the JSON body to prove
    // `{org_slug, repo_name}` rode the wire, not `{project_id}`; every
    // pre-existing assertion in this file only reads `.method`/`.url` and is
    // unaffected by the additive `.body` field.
    req.on("data", (chunk) => { call.body += chunk; });
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/gitvault/v1/vaults?")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "RESOURCE_NOT_FOUND", message: "no vault for this project" }));
        return;
      }
      if (req.method === "POST" && req.url === "/gitvault/v1/vaults") {
        // Reaching this route is what the test proves; the response need not
        // complete the six-stage journal (that machinery is proven at the SDK
        // level) — a deliberately incomplete/invalid body still counts as
        // "the allocate route was hit with org_id resolved from the address".
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "NOT_IMPLEMENTED_IN_TEST_STUB" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "RESOURCE_NOT_FOUND" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      handler(`http://127.0.0.1:${server.address().port}`, calls).then(
        () => server.close(() => resolve()),
        (err) => server.close(() => reject(err)),
      );
    });
  });
}

describe("git-remote-run402 — D2 lazy allocation", () => {
  it("list against an unallocated vault reports an EMPTY ref set, never an error — a read never creates anything", async () => {
    await withUnallocatedVaultGateway(async (apiBase, calls) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-d2-list-")));
      try {
        const r = await runHelperAsync({
          cwd: root,
          env: { GIT_DIR: undefined, RUN402_API_BASE: apiBase },
          stdin: "capabilities\n\nlist for-push\n\n",
        });
        assert.equal(r.status, 0, `${r.stdout}\n---\n${r.stderr}`);
        // capabilities block, then an EMPTY list block — no refs, no error.
        assert.equal(r.stdout, "fetch\npush\noption\n\n\n");
        assert.doesNotMatch(r.stderr, /error|refus/i, r.stderr);
        assert.equal(calls.filter((c) => c.method === "POST").length, 0, "list must never allocate");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("push against an unallocated vault reaches the allocate route — org_id came from the parsed address", async () => {
    await withUnallocatedVaultGateway(async (apiBase, calls) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-d2-push-")));
      try {
        const target = makeRepo(root, { commit: true });
        const r = await runHelperAsync({
          cwd: target,
          env: { GIT_DIR: realpathSync(join(target, ".git")), RUN402_API_BASE: apiBase },
          stdin: "capabilities\n\npush refs/heads/main:refs/heads/main\n\n",
        });
        // The stub's allocate response is deliberately incomplete, so creation
        // itself fails past this point — that failure is expected and fine;
        // what this test asserts is that the attempt happened at all.
        const allocateCalls = calls.filter((c) => c.method === "POST" && c.url === "/gitvault/v1/vaults");
        assert.equal(allocateCalls.length, 1, `expected exactly one allocate call; saw: ${JSON.stringify(calls)}\n${r.stdout}\n---\n${r.stderr}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

// ─── kychee-com/run402#565 — option dry-run true (a REAL dry run) ────────────
//
// `option dry-run` used to be honestly `unsupported`: this helper could not
// rehearse a publication, and a fake success would be worse than refusing.
// Pinned here, driving the real binary over the real wire protocol:
//   1. `option dry-run true` now answers `ok`, not `unsupported`.
//   2. A push-to-create dry run against an UNALLOCATED vault reaches ZERO
//      mutating routes — the allocate POST is never made — while still
//      reporting `ok <ref>` per the gitremote-helpers protocol (a real push
//      here WOULD succeed by allocating first; only sizing is unavailable).
//   3. `option dry-run true` composes with `push`: the SAME batch, run twice
//      (dry then real) against a live gateway, is proven at the SDK level
//      (`sdk/src/node/gitvault-publication.test.ts`'s `planPush` suite) —
//      reimplementing that as an HTTP fixture here would duplicate it, not
//      add coverage; this layer's job is the wire-protocol behavior only.

describe("git-remote-run402 — option dry-run true (kychee-com/run402#565)", () => {
  it("dry-run is acknowledged (`ok`), not `unsupported`", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-dryrun-cap-")));
    try {
      const r = runHelper({ cwd: root, env: { GIT_DIR: undefined }, stdin: "capabilities\n\noption dry-run true\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^ok$/m, `expected an 'ok' line for dry-run; got:\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, /unsupported/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an unrecognized dry-run value is honestly unsupported, not guessed", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-dryrun-bad-")));
    try {
      const r = runHelper({ cwd: root, env: { GIT_DIR: undefined }, stdin: "capabilities\n\noption dry-run maybe\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^unsupported$/m, r.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("push-to-create dry-run against an UNALLOCATED vault allocates NOTHING — zero mutating calls — and still reports ok", async () => {
    await withUnallocatedVaultGateway(async (apiBase, calls) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-dryrun-unalloc-")));
      try {
        const target = makeRepo(root, { commit: true });
        const r = await runHelperAsync({
          cwd: target,
          env: { GIT_DIR: realpathSync(join(target, ".git")), RUN402_API_BASE: apiBase },
          stdin: "capabilities\n\noption dry-run true\n\npush refs/heads/main:refs/heads/main\n\n",
        });
        // The one assertion this test exists for: push-to-create dry-run must
        // NEVER allocate. The gateway stub's only mutating route is the
        // allocate POST — zero POSTs of ANY kind proves nothing mutating was
        // attempted (the GET ?project_id= read is the only call that should
        // have happened).
        const postCalls = calls.filter((c) => c.method === "POST");
        assert.equal(postCalls.length, 0, `dry-run push-to-create must not allocate; saw: ${JSON.stringify(calls)}\n${r.stdout}\n---\n${r.stderr}`);
        assert.match(r.stdout, /^ok refs\/heads\/main$/m, `${r.stdout}\n---\n${r.stderr}`);
        assert.match(r.stderr, /dry-run.*no vault allocated/i, r.stderr);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

// ─── D6 (repo-first-onramp task 4) — named addressing + push-to-create + id-pinning ───
//
// `run402::acme/my-notes` is SLUG-form (neither half looks id-shaped —
// `gitvaultRemoteAddressForm`), routing through `resolveOrCreateAddress`
// instead of the plain project_id-addressed path above. Two things are
// pinned here, driving the REAL binary exactly like the D2 suite above:
//   1. a resolvable slug-form remote pins `repo_id` into this checkout's
//      LOCAL git config (`r402.repoId`) the FIRST time it resolves, and a
//      later invocation on the SAME checkout never re-resolves the address
//      over the network again;
//   2. a slug-form push against a NAME THAT DOES NOT RESOLVE YET reaches the
//      push-to-create route with `{org_slug, repo_name}` in the body — never
//      `{project_id}` — proving the address routed into D6's push-to-create
//      form and not the ordinary allocate. The full six-stage creation
//      itself is proven exhaustively at the SDK level
//      (sdk/src/node/gitvault-address.test.ts); reimplementing it as an HTTP
//      fixture here would duplicate it, not add coverage.

const SLUG_ADDRESS = "acme/my-notes";

function vaultRecordFixture(overrides = {}) {
  return {
    repo_id: "src_00000000000000000000000000000001", project_id: "prj_pinned", org_id: "org_pinned",
    gitvault_policy: "required", gitvault_policy_version: "1", gitvault_policy_changed_at: null,
    allocation_generation: "0000000000000001", allocation_sha256: null,
    newest_generation: null, genesis_admitted_at: null, latest_effective_admitted_at: null,
    admitted_generations: "0", gc_epoch: "0", repair_version: "0", repair_fence_state: "none",
    storage: { source_bytes: "0", open_session_reserved_bytes: "0", objects: {} },
    maintenance: { lease: null, open_cycle: null, pending_repair_attempt_id: null },
    warnings: [], created_at: null,
    ...overrides,
  };
}

/** A gateway stub whose `?repo=` read ALREADY resolves — the "found, no creation needed" fixture. */
function withResolvableRepoGateway(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.method === "GET" && req.url === `/gitvault/v1/vaults?repo=${encodeURIComponent(SLUG_ADDRESS)}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(vaultRecordFixture()));
      return;
    }
    // `materialize()` reads the vault record by id (for `newest_generation`)
    // before it ever needs the local identity that this test deliberately
    // omits — the SAME fixture answers both routes, so a resolved-by-address
    // handle behaves identically to one resolved by id.
    if (req.method === "GET" && req.url === "/gitvault/v1/vaults/src_00000000000000000000000000000001") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(vaultRecordFixture()));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "RESOURCE_NOT_FOUND" }));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      handler(`http://127.0.0.1:${server.address().port}`, calls).then(
        () => server.close(() => resolve()),
        (err) => server.close(() => reject(err)),
      );
    });
  });
}

/** Read the pinned `r402.repoId` straight from the checkout's local git config, bypassing the SDK entirely. */
function readPinnedRepoId(dir) {
  try {
    return execFileSync("git", ["config", "--local", "--get", "r402.repoId"], { cwd: dir, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

describe("git-remote-run402 — D6 slug-form id-pinning (task 4.5)", () => {
  // Neither of these helper invocations completes a full push — that needs
  // a local gitvault IDENTITY (this fresh RUN402_CONFIG_DIR never ran
  // `gitvault init`), which is a SEPARATE, later concern from address
  // resolution and pinning. What this test isolates is that resolution +
  // pinning happen BEFORE anything identity-dependent: `resolveOrCreateAddress`
  // resolves the address and writes the pin, and only THEN does opening the
  // vault for real work (materialize/sign) hit the (expected, typed)
  // `KEYSTORE_MISSING` wall — so the pin is durable even though the push
  // itself does not complete on a machine with no local key material yet.
  it("a resolvable slug-form remote pins repo_id on first push, and a SECOND push never re-resolves the address", async () => {
    await withResolvableRepoGateway(async (apiBase, calls) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-d6-pin-")));
      try {
        const target = makeRepo(root, { commit: true });
        const gitDir = realpathSync(join(target, ".git"));
        assert.equal(readPinnedRepoId(target), null, "nothing pinned yet");

        const first = await runHelperAsync({
          cwd: target,
          env: { GIT_DIR: gitDir, RUN402_API_BASE: apiBase },
          stdin: "capabilities\n\npush refs/heads/main:refs/heads/main\n\n",
          address: SLUG_ADDRESS,
        });
        assert.match(first.stdout, /KEYSTORE_MISSING/, `expected the push to reach the (later, identity-dependent) KEYSTORE_MISSING wall, not fail resolution itself: ${first.stdout}\n---\n${first.stderr}`);
        assert.equal(readPinnedRepoId(target), "src_00000000000000000000000000000001", "the pin survives even though the push itself did not complete");
        const repoCallsAfterFirst = calls.filter((c) => c.method === "GET" && c.url.startsWith("/gitvault/v1/vaults?repo=")).length;
        assert.equal(repoCallsAfterFirst, 1, "exactly one address resolution for the first push");

        // A SECOND push on the SAME checkout: the pin short-circuits address
        // resolution entirely — no further `?repo=` read, even though the
        // push still cannot complete for the same identity reason.
        const second = await runHelperAsync({
          cwd: target,
          env: { GIT_DIR: gitDir, RUN402_API_BASE: apiBase },
          stdin: "capabilities\n\npush refs/heads/main:refs/heads/main\n\n",
          address: SLUG_ADDRESS,
        });
        assert.match(second.stdout, /KEYSTORE_MISSING/, `${second.stdout}\n---\n${second.stderr}`);
        const repoCallsAfterSecond = calls.filter((c) => c.method === "GET" && c.url.startsWith("/gitvault/v1/vaults?repo=")).length;
        assert.equal(repoCallsAfterSecond, repoCallsAfterFirst, "the pin must be followed, never re-resolved");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("list against a slug-form remote resolves it cleanly — no repository, so nothing to pin, and no crash beyond the expected typed refusal", async () => {
    await withResolvableRepoGateway(async (apiBase, calls) => {
      const r = await runHelperAsync({
        cwd: mkdtempSync(join(tmpdir(), "run402-gvh-d6-list-")),
        env: { GIT_DIR: undefined, RUN402_API_BASE: apiBase },
        stdin: "capabilities\n\nlist for-push\n\n",
        address: SLUG_ADDRESS,
      });
      // Same identity wall as the push tests above — but note.equal(1) below
      // is the actual point: the address DID resolve (one clean `?repo=`
      // read), it is only the LOCAL identity that is missing.
      assert.match(r.stderr, /KEYSTORE_MISSING/, `${r.stdout}\n---\n${r.stderr}`);
      const repoCalls = calls.filter((c) => c.method === "GET" && c.url.startsWith("/gitvault/v1/vaults?repo=")).length;
      assert.equal(repoCalls, 1, "list resolved the address over the network exactly once");
    });
  });
});

describe("git-remote-run402 — D6 slug-form push-to-create wiring", () => {
  it("a push against a slug-form name that does NOT resolve yet reaches push-to-create with {org_slug, repo_name} — never {project_id}", async () => {
    await withUnallocatedVaultGateway(async (apiBase, calls) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-d6-create-")));
      try {
        const target = makeRepo(root, { commit: true });
        const r = await runHelperAsync({
          cwd: target,
          env: { GIT_DIR: realpathSync(join(target, ".git")), RUN402_API_BASE: apiBase },
          stdin: "capabilities\n\npush refs/heads/main:refs/heads/main\n\n",
          address: SLUG_ADDRESS,
        });
        // Same "deliberately incomplete stub response" shape as the D2 test
        // above — what this test proves is the WIRING, not the six-stage
        // protocol (proven exhaustively at the SDK level).
        const repoReads = calls.filter((c) => c.method === "GET" && c.url.startsWith("/gitvault/v1/vaults?repo="));
        assert.equal(repoReads.length, 1, `expected the fast-path resolve read; saw: ${JSON.stringify(calls)}\n${r.stdout}\n---\n${r.stderr}`);
        const allocateCalls = calls.filter((c) => c.method === "POST" && c.url === "/gitvault/v1/vaults");
        assert.equal(allocateCalls.length, 1, `expected exactly one push-to-create call; saw: ${JSON.stringify(calls)}\n${r.stdout}\n---\n${r.stderr}`);
        const body = JSON.parse(allocateCalls[0].body ?? "{}");
        assert.equal(body.org_slug, "acme");
        assert.equal(body.repo_name, "my-notes");
        assert.equal(body.project_id, undefined, "push-to-create must never send project_id");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

// ─── wallet selection (kychee-com/run402#558) ────────────────────────────
//
// Before this fix, `git-remote-run402` called `getSdk()` directly and ran no
// wallet selection at all — a `.run402.json` binding, and even the global
// `wallets use` default, silently never reached it; only `RUN402_WALLET`
// worked. These drive the REAL binary hermetically (`RUN402_API_BASE` is the
// closed DEAD_API port from the top of this file) by giving the resolved
// wallet a deliberately MALFORMED allowance.json (present, but missing a
// valid `address`) — `core/src/allowance.ts#readAllowance`'s own throw fires
// BEFORE any network dispatch (SIWX auth headers are computed ahead of the
// fetch), so the resolved wallet's name surfaces in stderr without ever
// touching the dead port. `list` is used throughout: it needs no repository,
// so the binding walk falls back to cwd exactly as `capabilities`/`option`'s
// tier does — the same "repository-free command" class the CLI's own
// resolution documents.

/** A profile directory holding ONLY a deliberately malformed allowance.json
 * (valid JSON object, but missing a valid `address`) — `profileExists()`
 * still reports it present (existence only checks the file's presence, not
 * its shape), so wallet SELECTION succeeds and the malformed-shape THROW
 * happens only once credentials are actually read. */
function writeMalformedWalletProfile(configDir, name) {
  const dir = name === "default" ? configDir : join(configDir, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "allowance.json"), JSON.stringify({ notAnAddress: true }));
}

function setGlobalDefaultWallet(configDir, name) {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ active_wallet: name }));
}

function writeBindingFile(dir, patch) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".run402.json"), JSON.stringify(patch));
}

describe("git-remote-run402 — wallet selection (kychee-com/run402#558)", () => {
  it("a .run402.json binding is honored — the resolved wallet's own (malformed) allowance surfaces, not the default's silence", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-wallet-binding-")));
    try {
      const configDir = mkdtempSync(join(tmpdir(), "run402-gvh-cfg-"));
      writeMalformedWalletProfile(configDir, "bound-wallet");
      writeBindingFile(root, { wallet: "bound-wallet" });

      const r = await runHelperAsync({
        cwd: root,
        env: { GIT_DIR: undefined, RUN402_CONFIG_DIR: configDir },
        stdin: "capabilities\n\nlist\n\n",
      });
      assert.match(r.stderr, /bound-wallet/, `binding must be honored, not silently ignored: ${r.stdout}\n---\n${r.stderr}`);
      assert.match(r.stderr, /allowance\.json/, r.stderr);
      // Never reached the dead port — the malformed-shape throw fires before
      // any fetch dispatch, so this is provably a selection/credential
      // problem, not a coincidental network failure that also mentions the name.
      assert.doesNotMatch(r.stderr, /ECONNREFUSED|127\.0\.0\.1:9/, r.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("RUN402_WALLET env disagreeing with a .run402.json binding is a hard WALLET_SELECTION_CONFLICT — same rule the CLI enforces", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-wallet-conflict-")));
    try {
      const configDir = mkdtempSync(join(tmpdir(), "run402-gvh-cfg-"));
      writeMalformedWalletProfile(configDir, "env-wallet");
      writeMalformedWalletProfile(configDir, "binding-wallet");
      writeBindingFile(root, { wallet: "binding-wallet" });

      const r = await runHelperAsync({
        cwd: root,
        env: { GIT_DIR: undefined, RUN402_CONFIG_DIR: configDir, RUN402_WALLET: "env-wallet" },
        stdin: "capabilities\n\nlist\n\n",
      });
      assert.match(r.stderr, /WALLET_SELECTION_CONFLICT/, `${r.stdout}\n---\n${r.stderr}`);
      // Names BOTH candidates, exactly like wallet-context.mjs#resolveWalletCore's
      // message for the CLI — one shared implementation, not a re-derived copy.
      assert.match(r.stderr, /RUN402_WALLET=env-wallet/, r.stderr);
      assert.match(r.stderr, /selects 'binding-wallet'/, r.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the global 'wallets use' default is honored when no env and no binding select a wallet", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-wallet-default-")));
    try {
      const configDir = mkdtempSync(join(tmpdir(), "run402-gvh-cfg-"));
      writeMalformedWalletProfile(configDir, "global-default-wallet");
      setGlobalDefaultWallet(configDir, "global-default-wallet");

      const r = await runHelperAsync({
        cwd: root,
        env: { GIT_DIR: undefined, RUN402_CONFIG_DIR: configDir },
        stdin: "capabilities\n\nlist\n\n",
      });
      assert.match(r.stderr, /global-default-wallet/, `${r.stdout}\n---\n${r.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the allowance-missing remedy names the resolved wallet/profile and how selection works, instead of blindly suggesting 'run402 init'", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-wallet-remedy-")));
    try {
      const configDir = mkdtempSync(join(tmpdir(), "run402-gvh-cfg-"));
      writeMalformedWalletProfile(configDir, "platform-deploy");
      writeBindingFile(root, { wallet: "platform-deploy" });

      const r = await runHelperAsync({
        cwd: root,
        env: { GIT_DIR: undefined, RUN402_CONFIG_DIR: configDir },
        stdin: "capabilities\n\nlist\n\n",
      });
      // Names WHICH wallet was resolved...
      assert.match(r.stderr, /Resolved wallet 'platform-deploy'/, r.stderr);
      // ...and HOW selection works (env/binding/wallets use), naming the binding file specifically.
      assert.match(r.stderr, /via .*\.run402\.json/, r.stderr);
      assert.match(r.stderr, /RUN402_WALLET env/, r.stderr);
      assert.match(r.stderr, /wallets use/, r.stderr);
      // The harmful part of the original remedy: run402 init would recreate
      // the DEFAULT wallet's allowance, not this one. It must not be offered
      // as the (sole, unqualified) fix when a binding/env picked a NAMED wallet.
      assert.doesNotMatch(r.stderr, /^git-remote-run402:.*run402 init.*$/m, r.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a genuinely unselected default wallet keeps the original 'run402 init' remedy — no binding/env means it IS the right fix", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "run402-gvh-wallet-plain-default-")));
    try {
      const configDir = mkdtempSync(join(tmpdir(), "run402-gvh-cfg-"));
      // Malformed DEFAULT allowance, nothing selecting any other wallet.
      writeMalformedWalletProfile(configDir, "default");

      const r = await runHelperAsync({
        cwd: root,
        env: { GIT_DIR: undefined, RUN402_CONFIG_DIR: configDir },
        stdin: "capabilities\n\nlist\n\n",
      });
      assert.match(r.stderr, /run402 init/, r.stderr);
      assert.doesNotMatch(r.stderr, /Resolved wallet/, "no override selected anything — nothing to name");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── first-push HEAD repair (kychee-com/run402#568) ──────────────────────
//
// THE DEFECT (dogfood #2). A fresh vault's HEAD symref defaults to
// `refs/heads/main` (the SDK's own genesis default). A first
// `git push origin master` (or any non-main branch) published the commit
// fine, but left HEAD naming a ref that would never exist — the first
// `git clone` warned "remote HEAD refers to nonexistent ref" and checked
// out an EMPTY tree, with the real commit sitting right there on the
// advertised `refs/heads/master`.
//
// `chooseGitvaultHeadTargetForPush` is the pure decision this file's own
// `runPush` composes (see its call site) — no I/O, no git, no network, so
// it is driven directly here rather than through the full protocol wire
// (a genuine crypto round trip needs a real vault backend; the SDK-layer
// plumbing that carries a supplied `head_target` through `push()` and back
// out of `materialize()` is already pinned in
// `sdk/src/node/gitvault-publication.test.ts`, "push can set head_target
// directly, overriding the base"). What is under test here is squarely the
// CLI-layer decision this bug's fix actually lives in: WHICH ref to repair
// HEAD to, and when to leave it alone.
describe("chooseGitvaultHeadTargetForPush — first-push HEAD repair (kychee-com/run402#568)", () => {
  const MAIN_SYMREF = { kind: "symref", ref: "refs/heads/main" };
  const oid = (n) => n.toString(16).padStart(40, "0");

  /** What a `list` immediately after this push would advertise — the actual clone-safety property: HEAD must never name an absent ref. */
  function postPushRefsAndHead({ baseRefs, updates, result }) {
    const refs = { ...(baseRefs ?? {}) };
    for (const u of updates) {
      if (u.new_oid === null) delete refs[u.ref];
      else refs[u.ref] = u.new_oid;
    }
    const headTarget = result.head_target ?? MAIN_SYMREF; // what vault.push() would carry forward when no override is given
    const headAdvertisable = headTarget.kind === "symref" ? Object.prototype.hasOwnProperty.call(refs, headTarget.ref) : true;
    return { refs, headTarget, headAdvertisable };
  }

  it("first push of master (a fresh vault, HEAD defaulting to the never-pushed 'main') sets HEAD to master — and the resulting ref map is clone-safe", () => {
    const updates = [{ ref: "refs/heads/master", new_oid: oid(1) }];
    const result = chooseGitvaultHeadTargetForPush({
      baseHeadTarget: MAIN_SYMREF,
      baseRefs: {},
      updates,
      localHeadRef: "refs/heads/master",
    });
    assert.deepEqual(result.head_target, { kind: "symref", ref: "refs/heads/master" });
    assert.match(result.note, /vault HEAD was dangling.*'refs\/heads\/main'/);
    assert.match(result.note, /setting it to 'refs\/heads\/master'/);

    // The property that actually matters: a `list` right after this push
    // must never advertise `@<ref> HEAD` for a ref with no entry — that is
    // exactly the "remote HEAD refers to nonexistent ref" hazard.
    const { headAdvertisable } = postPushRefsAndHead({ baseRefs: {}, updates, result });
    assert.equal(headAdvertisable, true, "HEAD must name a ref this push actually published — a clone must never see an empty tree");
  });

  it("first push of several branches in one batch prefers the local repository's own HEAD branch", () => {
    const updates = [
      { ref: "refs/heads/feature", new_oid: oid(2) },
      { ref: "refs/heads/dev", new_oid: oid(3) },
    ];
    const result = chooseGitvaultHeadTargetForPush({
      baseHeadTarget: MAIN_SYMREF,
      baseRefs: {},
      updates,
      localHeadRef: "refs/heads/dev",
    });
    assert.deepEqual(result.head_target, { kind: "symref", ref: "refs/heads/dev" });
    assert.match(result.note, /this repository's own HEAD branch/);
  });

  it("first push of several branches with NO matching local HEAD picks the first branch in the batch, and says so", () => {
    const updates = [
      { ref: "refs/heads/feature", new_oid: oid(2) },
      { ref: "refs/heads/dev", new_oid: oid(3) },
    ];
    const result = chooseGitvaultHeadTargetForPush({
      baseHeadTarget: MAIN_SYMREF,
      baseRefs: {},
      updates,
      localHeadRef: null, // detached, or unresolvable
    });
    assert.deepEqual(result.head_target, { kind: "symref", ref: "refs/heads/feature" });
    assert.match(result.note, /the first of 2 branches pushed in this batch/);
  });

  it("a later push with an already-healthy HEAD does not move it", () => {
    // HEAD already names 'main', and 'main' is present both before AND
    // after this push (which only touches a different branch) — the
    // documented rule: push never moves a healthy HEAD.
    const updates = [{ ref: "refs/heads/feature", new_oid: oid(4) }];
    const result = chooseGitvaultHeadTargetForPush({
      baseHeadTarget: MAIN_SYMREF,
      baseRefs: { "refs/heads/main": oid(0) },
      updates,
      localHeadRef: "refs/heads/feature",
    });
    assert.equal(result.head_target, undefined, "a healthy HEAD must not be overridden — vault.push() carries the base forward unchanged");
    assert.equal(result.note, null, "no repair happened, so there is nothing to note");
  });

  it("re-pushing the SAME branch HEAD already names is still healthy — updating main's oid never moves HEAD off main", () => {
    const updates = [{ ref: "refs/heads/main", new_oid: oid(5) }];
    const result = chooseGitvaultHeadTargetForPush({
      baseHeadTarget: MAIN_SYMREF,
      baseRefs: { "refs/heads/main": oid(0) },
      updates,
      localHeadRef: "refs/heads/main",
    });
    assert.equal(result.head_target, undefined);
    assert.equal(result.note, null);
  });

  it("a dangling HEAD with no branch in this batch (e.g. a tag-only or deletion-only push) is left alone — nothing here can repair it", () => {
    const tagOnly = chooseGitvaultHeadTargetForPush({
      baseHeadTarget: MAIN_SYMREF,
      baseRefs: {},
      updates: [{ ref: "refs/tags/v1", new_oid: oid(6) }],
      localHeadRef: "refs/heads/master",
    });
    assert.equal(tagOnly.head_target, undefined);
    assert.equal(tagOnly.note, null);

    const deletionOnly = chooseGitvaultHeadTargetForPush({
      baseHeadTarget: MAIN_SYMREF,
      baseRefs: { "refs/heads/main": oid(0) },
      updates: [{ ref: "refs/heads/main", new_oid: null }],
      localHeadRef: null,
    });
    assert.equal(deletionOnly.head_target, undefined);
    assert.equal(deletionOnly.note, null);
  });

  it("an UNSET head_target (defensive — the SDK always supplies a default today, but the rule covers it) is repaired the same way", () => {
    const result = chooseGitvaultHeadTargetForPush({
      baseHeadTarget: null,
      baseRefs: {},
      updates: [{ ref: "refs/heads/trunk", new_oid: oid(7) }],
      localHeadRef: "refs/heads/trunk",
    });
    assert.deepEqual(result.head_target, { kind: "symref", ref: "refs/heads/trunk" });
    assert.match(result.note, /vault HEAD was unset/);
  });

  it("a detached HEAD target is left untouched — only a dangling SYMREF is ever repaired", () => {
    const result = chooseGitvaultHeadTargetForPush({
      baseHeadTarget: { kind: "detached", oid: oid(9) },
      baseRefs: {},
      updates: [{ ref: "refs/heads/master", new_oid: oid(1) }],
      localHeadRef: "refs/heads/master",
    });
    assert.equal(result.head_target, undefined);
    assert.equal(result.note, null);
  });
});

// ---------------------------------------------------------------------------
// The 4.39.0 production regression: npm installs the helper bin as a SYMLINK
// (`/opt/homebrew/bin/git-remote-run402 -> ../lib/node_modules/...`), and
// Node's ESM loader resolves `import.meta.url` through the symlink to the
// REAL file while `process.argv[1]` keeps the symlink path — so a naive
// entrypoint guard (import.meta.url === pathToFileURL(argv[1]).href) fails
// exactly and only in production: the helper printed nothing, exited 0, and
// every real `git push`/`ls-remote` died with "remote helper aborted
// session". Every test here spawned `node HELPER` directly, so argv[1] was
// always the real path and the suite stayed green while the product was
// dead. This test invokes the helper THROUGH a symlink, the way npm does.
// ---------------------------------------------------------------------------
describe("entrypoint guard survives symlinked invocation (the npm bin shape)", () => {
  it("emits capabilities when spawned via a symlink to the helper", () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-gvh-symlink-"));
    const link = join(dir, "git-remote-run402");
    symlinkSync(HELPER, link);
    try {
      const result = spawnSync(link, ["run402", ADDRESS], {
        input: "capabilities\n\n",
        encoding: "utf-8",
        timeout: 30_000,
        env: {
          ...process.env,
          RUN402_API_BASE: DEAD_API,
          RUN402_CONFIG_DIR: mkdtempSync(join(tmpdir(), "run402-gvh-cfg-")),
        },
      });
      assert.match(result.stdout, /fetch\n/, `symlinked helper emitted no capabilities — the 4.39.0 silent-no-op regression is back. stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
      assert.match(result.stdout, /push\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
