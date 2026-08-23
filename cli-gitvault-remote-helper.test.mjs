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
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER = fileURLToPath(new URL("./cli/git-remote-run402.mjs", import.meta.url));
/** A closed port: any network attempt fails loudly and unmistakably. */
const DEAD_API = "http://127.0.0.1:9";
const ADDRESS = "org_test/prj_test";

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
