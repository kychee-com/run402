import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureHandoffSnapshot, globMatchesGitPath, isHandoffSensitivePath, GITVAULT_HANDOFF_SENSITIVE_DENYLIST } from "./gitvault-snapshot.js";
import { applyHandoffCheckpoint, resolveResumeTargetDir, readGitCommitMessage } from "./gitvault-restore.js";
import { git, makeRepo, commitFile } from "./gitvault-memory-transport.test.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run402-gitvault-restore-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("globMatchesGitPath / isHandoffSensitivePath — the denylist", () => {
  it("matches every literal name in the denylist against a top-level file", () => {
    const cases: Array<[string, string]> = [
      [".env", ".env"], [".env.local", ".env.local"], ["id.pem", "id.pem"], ["priv.key", "priv.key"],
      ["cert.p12", "cert.p12"], ["cert.pfx", "cert.pfx"], ["keystore.jks", "keystore.jks"], ["a.keystore", "a.keystore"],
      ["id_rsa", "id_rsa"], ["id_rsa.pub", "id_rsa.pub"], ["id_ed25519", "id_ed25519"], ["id_ecdsa", "id_ecdsa"],
      [".npmrc", ".npmrc"], [".netrc", ".netrc"], [".pypirc", ".pypirc"], [".git-credentials", ".git-credentials"],
      ["terraform.tfstate", "terraform.tfstate"], ["terraform.tfstate.backup", "terraform.tfstate.backup"],
      ["aws-credentials.json", "aws-credentials.json"], ["x.secret", "x.secret"], ["secrets.yaml", "secrets.yaml"],
    ];
    for (const [path] of cases) assert.ok(isHandoffSensitivePath(path), `expected ${path} to be sensitive`);
  });

  it("matches a directory-style pattern at any depth", () => {
    assert.ok(isHandoffSensitivePath(".aws/credentials"));
    assert.ok(isHandoffSensitivePath("sub/.aws/credentials"));
    assert.ok(isHandoffSensitivePath(".ssh/id_rsa"));
    assert.ok(isHandoffSensitivePath(".gnupg/secring.gpg"));
  });

  it("does not flag an ordinary file", () => {
    assert.ok(!isHandoffSensitivePath("README.md"));
    assert.ok(!isHandoffSensitivePath("src/index.ts"));
    assert.ok(!isHandoffSensitivePath("envelope.ts")); // must not match `.env` by substring
  });

  it("--include-sensitive re-admits a named path", () => {
    assert.ok(isHandoffSensitivePath(".env"));
    assert.ok(!isHandoffSensitivePath(".env", [".env"]));
  });

  it("GITVAULT_HANDOFF_SENSITIVE_DENYLIST matches design D10 verbatim", () => {
    assert.deepEqual([...GITVAULT_HANDOFF_SENSITIVE_DENYLIST], [
      ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore",
      "id_rsa*", "id_ed25519*", "id_ecdsa*", ".npmrc", ".netrc", ".pypirc", ".git-credentials",
      "*.tfstate*", "*credentials*.json", ".aws/**", ".ssh/**", ".gnupg/**", "*.secret", "secrets.*",
    ]);
  });

  it("globMatchesGitPath: a slash-bearing non-** glob matches the full path only", () => {
    assert.ok(globMatchesGitPath("a/b.txt", "a/b.txt"));
    assert.ok(!globMatchesGitPath("a/b.txt", "x/a/b.txt"));
  });
});

describe("captureHandoffSnapshot + applyHandoffCheckpoint — the acceptance sketch", () => {
  it("restores committed, staged, unstaged, deleted, and untracked changes distinctly; excludes ignored and sensitive; leaves the source repo unchanged", async () => {
    const dir = await makeRepo(root, "source");
    await commitFile(dir, "tracked.txt", "line1\n");
    await commitFile(dir, "sub/deep.txt", "nested\n");
    await commitFile(dir, "other.txt", "keep\n");

    const sourceHeadBefore = await git(dir, ["rev-parse", "HEAD"]);
    const sourceStatusBefore = await git(dir, ["status", "--porcelain=v1"]);
    assert.equal(sourceStatusBefore, "", "source repo should start clean");

    // staged + unstaged on the SAME tracked file
    writeFileSync(join(dir, "tracked.txt"), "line1\nline2\n");
    await git(dir, ["add", "tracked.txt"]);
    writeFileSync(join(dir, "tracked.txt"), "line1\nline2\nline3\n");
    // a deleted tracked file
    await git(dir, ["rm", "-q", "other.txt"]);
    // an untracked file
    writeFileSync(join(dir, "new_untracked.txt"), "untracked content\n");
    // an ignored file (never transferred)
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "junk.txt"), "junk\n");
    // a sensitive untracked file
    writeFileSync(join(dir, ".env"), "SECRET=shh\n");

    const sourceDirtyStatusBeforeCapture = await git(dir, ["status", "--porcelain=v1"]);

    const snap = await captureHandoffSnapshot({
      dir,
      message: (stats) => JSON.stringify({ schema: "kygit.handoff-note.v1", summary: "test", capture: { base_head: stats.base_head_oid, branch: stats.branch, modified_captured: stats.modified_captured.length, untracked_captured: stats.untracked_captured.length, sensitive_excluded: stats.sensitive_excluded, ignored_not_transferred_count: stats.ignored_not_transferred_count } }),
    });

    assert.equal(snap.base_head_oid, sourceHeadBefore);
    assert.deepEqual(snap.modified_captured, ["tracked.txt"]);
    assert.ok(snap.untracked_captured.includes("new_untracked.txt"));
    assert.ok(snap.untracked_captured.includes(".gitignore"));
    assert.deepEqual(snap.sensitive_excluded, [".env"]);
    assert.equal(snap.ignored_not_transferred_count, 1);

    // Source repo (branch, index, work tree) is untouched by the capture —
    // still exactly as dirty as we left it.
    const sourceStatusAfter = await git(dir, ["status", "--porcelain=v1"]);
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), sourceHeadBefore);
    assert.equal(sourceStatusAfter, sourceDirtyStatusBeforeCapture, "capturing a handoff must never commit, reset, or touch the source checkout");
    assert.ok(sourceStatusAfter.includes("tracked.txt"));

    // Clone into a fresh directory (simulating the retention-root-materialized
    // clone `resume()` drives against a live vault) and restore. A plain
    // child_process clone here — NOT `hardenedGit` (`-c protocol.allow=never`
    // would refuse the `file://` transport, exactly the reason
    // `cloneGitvaultRemote` deliberately runs outside that runner).
    const target = join(root, "target");
    execFileSync("git", ["clone", "--no-checkout", dir, target], { stdio: "pipe" });
    // A same-filesystem local clone brings the whole object store; make the
    // production dependency explicit and self-verifying rather than assumed.
    try {
      await git(target, ["cat-file", "-e", snap.oid]);
    } catch {
      execFileSync("git", ["-C", target, "fetch", dir, snap.oid], { stdio: "pipe" });
    }

    const restored = await applyHandoffCheckpoint({ dir: target, stash_oid: snap.oid });
    assert.equal(restored.base_head_oid, sourceHeadBefore);
    assert.equal(restored.branch, "main");

    const status = await git(target, ["status", "--porcelain=v1"]);
    assert.ok(/^.D other\.txt$|^D. other\.txt$/m.test(status), `deleted tracked file should show as deleted — got: ${JSON.stringify(status)}`);
    assert.ok(/MM? tracked\.txt/.test(status), "tracked.txt should show staged+unstaged");
    assert.ok(status.includes("new_untracked.txt"), "untracked file should be restored");
    assert.ok(status.includes(".gitignore"), "the .gitignore file itself is untracked-not-ignored and should be restored");
    assert.ok(!status.includes(".env"), ".env must not be restored (sensitive)");
    assert.ok(!existsSync(join(target, "node_modules")), "ignored node_modules/ must never be transferred");
    assert.ok(!existsSync(join(target, ".env")), ".env must not exist on disk");
    assert.equal(readFileSync(join(target, "tracked.txt"), "utf8"), "line1\nline2\nline3\n");
    assert.equal(readFileSync(join(target, "new_untracked.txt"), "utf8"), "untracked content\n");
    assert.ok(!existsSync(join(target, "other.txt")), "deleted file must not exist on disk");

    const cachedTracked = await git(target, ["show", ":tracked.txt"]);
    assert.equal(cachedTracked, "line1\nline2");

    const noteRaw = await readGitCommitMessage(target, snap.oid);
    assert.ok(noteRaw);
    const note = JSON.parse(noteRaw!);
    assert.equal(note.schema, "kygit.handoff-note.v1");
    assert.equal(note.capture.sensitive_excluded[0], ".env");
  });

  it("a clean tree still produces a synthetic commit (always synthetic, one code path)", async () => {
    const dir = await makeRepo(root, "clean-repo");
    const headBefore = await git(dir, ["rev-parse", "HEAD"]);
    const snap = await captureHandoffSnapshot({ dir, message: "clean handoff" });
    assert.notEqual(snap.oid, headBefore, "the outer commit is ALWAYS a new synthetic commit, never HEAD itself");
    assert.equal(snap.base_head_oid, headBefore);
    assert.deepEqual(snap.modified_captured, []);
    assert.deepEqual(snap.untracked_captured, []);
  });

  it("refuses SNAPSHOT_CONFLICTED_INDEX on an unmerged index", async () => {
    const a = await makeRepo(root, "conflict-a");
    await commitFile(a, "f.txt", "base\n");
    await git(a, ["checkout", "-q", "-b", "feature"]);
    await commitFile(a, "f.txt", "feature\n", "feature edit");
    await git(a, ["checkout", "-q", "main"]);
    await commitFile(a, "f.txt", "main\n", "main edit");
    try {
      await git(a, ["merge", "-q", "feature"]);
    } catch {
      /* expected merge conflict */
    }
    await assert.rejects(
      captureHandoffSnapshot({ dir: a, message: "should not write" }),
      (e: unknown) => (e as { code?: string }).code === "SNAPSHOT_CONFLICTED_INDEX",
    );
  });

  it("refuses HANDOFF_NO_BASE_COMMIT on an unborn HEAD", async () => {
    const dir = join(root, "unborn");
    mkdirSync(dir, { recursive: true });
    await git(dir, ["init", "-q", "-b", "main", "."]);
    await assert.rejects(
      captureHandoffSnapshot({ dir, message: "no base yet" }),
      (e: unknown) => (e as { code?: string }).code === "HANDOFF_NO_BASE_COMMIT",
    );
  });
});

describe("resolveResumeTargetDir", () => {
  it("prefers an explicit --to over the derived name", async () => {
    const dir = await resolveResumeTargetDir(join(root, "explicit"), "acme/notes", "repo_x");
    assert.equal(dir, join(root, "explicit"));
  });

  it("falls back to the address's repo-name half", async () => {
    const cwd = process.cwd();
    const dir = await resolveResumeTargetDir(undefined, "acme/notes", "repo_x");
    assert.equal(dir, join(cwd, "notes"));
  });

  it("falls back to the vault id with no address", async () => {
    const cwd = process.cwd();
    const dir = await resolveResumeTargetDir(undefined, null, "repo_x");
    assert.equal(dir, join(cwd, "repo_x"));
  });
});
