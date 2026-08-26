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
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
