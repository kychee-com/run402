/**
 * `resolveGitInvocationRepo` — which repository did git invoke us for?
 *
 * The defect these tests exist for (gitvault dogfood #1): `git-remote-run402`
 * discovered its repository from `process.cwd()`. During `git clone` cwd is
 * the directory clone was RUN FROM, so cloning a vault while standing inside
 * an unrelated repository wrote three packfiles of DECRYPTED vault history
 * into that unrelated repository — readable with `git cat-file -p`, with no
 * warning and no successful clone to show for it.
 *
 * The rule these tests pin: the repository comes from `GIT_DIR` (which git
 * always sets when it invokes a helper against a repository), it is PROVEN by
 * asking that directory what repository it is, and anything short of proof
 * refuses. A refusal must leave the caller with nothing to write into.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenedGit, resolveGitInvocationRepo } from "./gitvault-snapshot.js";

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

async function makeRepo(dir: string, opts: { bare?: boolean; commit?: boolean } = {}): Promise<string> {
  mkdirSync(dir, { recursive: true });
  await hardenedGit(dir, ["init", "-q", ...(opts.bare ? ["--bare"] : []), "-b", "main", "."]);
  if (opts.commit) {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    await hardenedGit(dir, ["add", "a.txt"]);
    await hardenedGit(dir, ["commit", "-q", "-m", "one"]);
  }
  return dir;
}

async function gitDirOf(dir: string): Promise<string> {
  return (await hardenedGit(dir, ["rev-parse", "--absolute-git-dir"])).text().trim();
}

describe("resolveGitInvocationRepo", () => {
  it("resolves the repository GIT_DIR names, NOT the one cwd sits in (the clone case)", async () => {
    const root = tmp("run402-gv-invocation-");
    try {
      // The decoy: an unrelated repository the user happens to be standing in.
      const decoy = await makeRepo(join(root, "decoy"), { commit: true });
      // The clone target: git creates `<target>/.git` before it runs the
      // helper, and names it in GIT_DIR — an ABSOLUTE path, cwd elsewhere.
      const target = await makeRepo(join(root, "target"));
      const targetGitDir = await gitDirOf(target);

      const resolved = await resolveGitInvocationRepo({ GIT_DIR: targetGitDir }, decoy);

      assert.equal(realpathSync(resolved.git_dir), realpathSync(targetGitDir));
      assert.equal(realpathSync(resolved.repo_dir), realpathSync(targetGitDir));
      // And the returned `repo_dir` really is a cwd whose discovery lands
      // there — that is the whole contract every hardened git call relies on.
      assert.equal(realpathSync(await gitDirOf(resolved.repo_dir)), realpathSync(targetGitDir));
      assert.notEqual(realpathSync(resolved.git_dir), realpathSync(await gitDirOf(decoy)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the RELATIVE `GIT_DIR=.git` git passes for fetch/push, resolved against cwd", async () => {
    const root = tmp("run402-gv-invocation-rel-");
    try {
      const repo = await makeRepo(join(root, "repo"), { commit: true });
      const resolved = await resolveGitInvocationRepo({ GIT_DIR: ".git" }, repo);
      assert.equal(realpathSync(resolved.git_dir), realpathSync(join(repo, ".git")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the `GIT_DIR=.` git passes inside a bare repository", async () => {
    const root = tmp("run402-gv-invocation-bare-");
    try {
      const bare = await makeRepo(join(root, "bare.git"), { bare: true });
      const resolved = await resolveGitInvocationRepo({ GIT_DIR: "." }, bare);
      assert.equal(realpathSync(resolved.git_dir), realpathSync(bare));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when git set no GIT_DIR, rather than guessing from cwd", async () => {
    const root = tmp("run402-gv-invocation-none-");
    try {
      // cwd IS a perfectly good repository — the point is that it is not the
      // one git asked about, so guessing it is exactly the leak.
      const decoy = await makeRepo(join(root, "decoy"), { commit: true });
      await assert.rejects(
        () => resolveGitInvocationRepo({}, decoy),
        (err: { code?: string; details?: { reason?: string } }) => {
          assert.equal(err.code, "GIT_INVOCATION_REPO_UNRESOLVED");
          assert.equal(err.details?.reason, "no_git_dir");
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when GIT_DIR does not exist", async () => {
    const root = tmp("run402-gv-invocation-missing-");
    try {
      await assert.rejects(
        () => resolveGitInvocationRepo({ GIT_DIR: join(root, "nowhere", ".git") }, root),
        (err: { code?: string; details?: { reason?: string } }) => {
          assert.equal(err.code, "GIT_INVOCATION_REPO_UNRESOLVED");
          assert.equal(err.details?.reason, "git_dir_not_a_repository");
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a GIT_DIR that is a plain subdirectory of some OTHER repository", async () => {
    const root = tmp("run402-gv-invocation-mismatch-");
    try {
      const repo = await makeRepo(join(root, "repo"), { commit: true });
      const inner = join(repo, "not-a-git-dir");
      mkdirSync(inner, { recursive: true });
      // Discovery from `inner` ascends to `repo/.git` — a real repository, but
      // NOT the path we were handed. Acting on it is the confusion itself.
      await assert.rejects(
        () => resolveGitInvocationRepo({ GIT_DIR: inner }, root),
        (err: { code?: string; details?: { reason?: string } }) => {
          assert.equal(err.code, "GIT_INVOCATION_REPO_UNRESOLVED");
          assert.equal(err.details?.reason, "git_dir_mismatch");
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
