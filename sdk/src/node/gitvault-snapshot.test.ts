/**
 * gitvault snapshot (task 5.5) — policies (clean/dirty/unborn/detached/
 * conflicted), the frozen ignore authority (global excludes as DATA, named
 * refusals when unreadable, include/includeIf refused), filter-free object
 * creation for EVERY path (the hostile-filter acceptance test: a configured
 * clean filter that would write a sentinel never runs), linked-worktree /
 * bare / sparse / submodule refusals, and snapshot materialization building
 * from the commit rather than the mutating tree.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureSnapshot,
  detectActiveFilters,
  discoverGlobalExcludes,
  gitvaultCommitLine,
  hardenedGitEnv,
  inspectRepository,
  materializeSnapshot,
  parseGitConfigAsData,
  probeGitVersion,
  snapshotCommitment,
  GITVAULT_DEPLOY_REF,
} from "./gitvault-snapshot.js";
import { commitFile, git, makeRepo } from "./gitvault-memory-transport.test.js";
import { deriveDigestKey, keyedCommitment, randomBytes } from "../namespaces/gitvault.crypto.js";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run402-gitvault-snapshot-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const env = () => ({ HOME: home, XDG_CONFIG_HOME: undefined });

type Refusal = { code?: string; details?: { file?: string; paths?: Array<{ path: string; filter: string }> } };

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as Refusal).code ?? "no-code"; }
  return "no-throw";
}

/** The refusal `p` threw, or `null` when it resolved. */
async function refusal(p: Promise<unknown>): Promise<Refusal | null> {
  try { await p; } catch (e) { return e as Refusal; }
  return null;
}

describe("hardened git execution", () => {
  it("probes the version and runs with a scrubbed environment", async () => {
    const v = await probeGitVersion(root);
    assert.ok(v[0] >= 2);
    const e = hardenedGitEnv();
    assert.equal(e.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(e.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(e.GIT_NO_REPLACE_OBJECTS, "1");
    assert.ok(!Object.keys(e).some((k) => k.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_NO_REPLACE_OBJECTS", "GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].includes(k)));
  });
});

describe("snapshot policies", () => {
  it("clean tree → HEAD (kind head), symref head_target, gitvault_commit line", async () => {
    const dir = await makeRepo(root);
    const head = await git(dir, ["rev-parse", "HEAD"]);
    const s = await captureSnapshot({ dir, env: env() });
    assert.equal(s.kind, "head");
    assert.equal(s.oid, head);
    assert.deepEqual(s.head, { kind: "symref", ref: "refs/heads/main" });
    assert.equal(gitvaultCommitLine(s), `gitvault_commit ${head}`);
  });

  it("dirty tree → synthetic commit of tracked + untracked-not-ignored; git status unchanged; branches untouched", async () => {
    const dir = await makeRepo(root);
    const head = await git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "README.md"), "changed\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "ignored.txt"), "secret\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "deep.txt"), "deep\n");
    symlinkSync("README.md", join(dir, "link"));
    const before = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const s = await captureSnapshot({ dir, env: env() });
    assert.equal(s.kind, "synthetic");
    assert.notEqual(s.oid, head);
    assert.deepEqual(s.paths, [".gitignore", "README.md", "link", "new.txt", "sub/deep.txt"]);
    assert.equal(gitvaultCommitLine(s), `gitvault_commit ${s.oid} (synthetic)`);
    // parented on HEAD; tree contents are the work tree's raw bytes
    assert.equal(await git(dir, ["rev-parse", `${s.oid}^`]), head);
    assert.equal(await git(dir, ["show", `${s.oid}:README.md`]), "changed");
    assert.equal(await git(dir, ["show", `${s.oid}:link`]), "README.md");
    assert.equal(await git(dir, ["cat-file", "-e", `${s.oid}:ignored.txt`]).then(() => "present", () => "absent"), "absent");
    // nothing the agent sees moved
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), head);
    assert.equal(await git(dir, ["rev-parse", "refs/heads/main"]), head);
    assert.equal(await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), before);
    // the local protocol ref keeps the synthetic commit reachable
    assert.equal(await git(dir, ["rev-parse", GITVAULT_DEPLOY_REF]), s.oid);
  });

  it("tracked file deleted from the work tree is absent from the synthetic commit", async () => {
    const dir = await makeRepo(root);
    await commitFile(dir, "gone.txt", "x\n");
    rmSync(join(dir, "gone.txt"));
    const s = await captureSnapshot({ dir, env: env() });
    assert.equal(s.kind, "synthetic");
    assert.ok(!s.paths.includes("gone.txt"));
  });

  it("unborn HEAD → parentless synthetic commit; symref head_target (unborn branch)", async () => {
    const dir = join(root, "unborn");
    mkdirSync(dir);
    await git(dir, ["init", "-q", "-b", "main", "."]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    const s = await captureSnapshot({ dir, env: env() });
    assert.equal(s.kind, "synthetic");
    assert.equal(s.head_oid, null);
    assert.deepEqual(s.head, { kind: "symref", ref: "refs/heads/main" });
    assert.equal(await git(dir, ["rev-list", "--count", s.oid]), "1");
  });

  it("detached HEAD is supported and representable as {kind: detached, oid}", async () => {
    const dir = await makeRepo(root);
    const head = await git(dir, ["rev-parse", "HEAD"]);
    await git(dir, ["checkout", "-q", "--detach", head]);
    const clean = await captureSnapshot({ dir, env: env() });
    assert.deepEqual(clean.head, { kind: "detached", oid: head });
    assert.equal(clean.kind, "head");
    writeFileSync(join(dir, "x.txt"), "x\n");
    const dirty = await captureSnapshot({ dir, env: env() });
    assert.equal(dirty.kind, "synthetic");
    assert.deepEqual(dirty.head, { kind: "detached", oid: head });
    assert.equal(await git(dir, ["rev-parse", `${dirty.oid}^`]), head);
  });

  it("unmerged index → SNAPSHOT_CONFLICTED_INDEX (fails before any object is created)", async () => {
    const dir = await makeRepo(root);
    await git(dir, ["checkout", "-q", "-b", "other"]);
    await commitFile(dir, "c.txt", "other\n");
    await git(dir, ["checkout", "-q", "main"]);
    await commitFile(dir, "c.txt", "main\n");
    await git(dir, ["merge", "other"]).catch(() => undefined);
    assert.equal((await git(dir, ["ls-files", "-u"])).length > 0, true);
    assert.equal(await code(captureSnapshot({ dir, env: env() })), "SNAPSHOT_CONFLICTED_INDEX");
  });
});

describe("frozen ignore authority — global excludes as data", () => {
  it("honors the user's global excludes exactly as git would; discovery reads XDG then ~/.gitconfig, last wins, ~/ expansion", async () => {
    const dir = await makeRepo(root);
    writeFileSync(join(home, ".gitconfig"), '[core]\n\texcludesFile = "~/my-ignores"\n');
    writeFileSync(join(home, "my-ignores"), ".env.production\n");
    writeFileSync(join(dir, ".env.production"), "SECRET=1\n");
    writeFileSync(join(dir, "keep.txt"), "k\n");
    const d = discoverGlobalExcludes(env());
    assert.equal(d.path, join(home, "my-ignores"));
    assert.equal(d.source, "core.excludesFile");
    const s = await captureSnapshot({ dir, env: env() });
    assert.deepEqual(s.paths, ["README.md", "keep.txt"]);
    assert.equal(s.global_excludes_path, join(home, "my-ignores"));
  });

  it("XDG config is read first and ~/.gitconfig overrides it (last value wins)", async () => {
    const xdg = join(root, "xdg");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "config"), "[core]\n  excludesFile = /nonexistent/from-xdg\n");
    writeFileSync(join(home, ".gitconfig"), "[core]\n  excludesFile = $HOME/from-home\n");
    writeFileSync(join(home, "from-home"), "*.log\n");
    const d = discoverGlobalExcludes({ HOME: home, XDG_CONFIG_HOME: xdg });
    assert.equal(d.path, join(home, "from-home"));
    assert.deepEqual(d.configs_read, [join(xdg, "git", "config"), join(home, ".gitconfig")]);
  });

  it("default path when core.excludesFile is unset: $XDG_CONFIG_HOME/git/ignore, falling back to ~/.config/git/ignore", async () => {
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "ignore"), "*.tmp\n");
    const d = discoverGlobalExcludes(env());
    assert.equal(d.source, "default");
    assert.equal(d.path, join(home, ".config", "git", "ignore"));
    assert.equal(d.patterns, "*.tmp\n");
    assert.equal(discoverGlobalExcludes({ HOME: join(root, "nohome") }).path, null);
  });

  it("an existing-but-unreadable excludes file refuses the capture BY NAME, never a silently widened snapshot", async () => {
    if (process.getuid?.() === 0) return; // root ignores modes
    const dir = await makeRepo(root);
    writeFileSync(join(home, ".gitconfig"), "[core]\n  excludesFile = ~/locked\n");
    writeFileSync(join(home, "locked"), ".env.production\n");
    chmodSync(join(home, "locked"), 0o000);
    writeFileSync(join(dir, ".env.production"), "SECRET=1\n");
    try {
      const caught = await refusal(captureSnapshot({ dir, env: env() }));
      assert.equal(caught?.code, "GITVAULT_EXCLUDES_UNREADABLE");
      assert.equal(caught?.details?.file, join(home, "locked"));
    } finally {
      chmodSync(join(home, "locked"), 0o600);
    }
  });

  it("an unreadable CONFIG file (not only the excludes file) refuses by name", async () => {
    if (process.getuid?.() === 0) return;
    writeFileSync(join(home, ".gitconfig"), "[core]\n");
    chmodSync(join(home, ".gitconfig"), 0o000);
    try {
      assert.throws(() => discoverGlobalExcludes(env()), (e: { code?: string; details?: { file?: string } }) => e.code === "GITVAULT_CONFIG_UNREADABLE" && e.details?.file === join(home, ".gitconfig"));
    } finally {
      chmodSync(join(home, ".gitconfig"), 0o600);
    }
  });

  it("include / includeIf constructs refuse the capture by name; relative or env-dependent paths refuse by name", () => {
    writeFileSync(join(home, ".gitconfig"), "[include]\n  path = ~/other\n");
    assert.throws(() => discoverGlobalExcludes(env()), (e: { code?: string }) => e.code === "GITVAULT_CONFIG_INCLUDE_REFUSED");
    writeFileSync(join(home, ".gitconfig"), '[includeIf "gitdir:~/work/"]\n  path = ~/other\n');
    assert.throws(() => discoverGlobalExcludes(env()), (e: { code?: string }) => e.code === "GITVAULT_CONFIG_INCLUDE_REFUSED");
    writeFileSync(join(home, ".gitconfig"), "[core]\n  excludesFile = relative/ignores\n");
    assert.throws(() => discoverGlobalExcludes(env()), (e: { code?: string }) => e.code === "GITVAULT_EXCLUDES_PATH_UNSUPPORTED");
    writeFileSync(join(home, ".gitconfig"), "[core]\n  excludesFile = $XDG_CONFIG_HOME/ignores\n");
    assert.throws(() => discoverGlobalExcludes(env()), (e: { code?: string }) => e.code === "GITVAULT_EXCLUDES_PATH_UNSUPPORTED");
  });

  it("config parser: quoted values with spaces and escapes, comments, case-insensitive keys, [section.sub] legacy form", () => {
    const entries = parseGitConfigAsData('# c\n[Core]\n\tExcludesFile = "~/my dir/ign\\"ores" ; trailing\n[alias.x]\n  y = z\n', "f");
    assert.deepEqual(entries.map((e) => [e.section, e.subsection, e.key, e.value]), [["core", null, "excludesfile", '~/my dir/ign"ores'], ["alias", "x", "y", "z"]]);
  });
});

describe("filter-free object creation (no-filter acceptance)", () => {
  it("a hostile clean filter on an UNTRACKED file never runs: capture refuses by name and the sentinel is never written", async () => {
    const dir = await makeRepo(root);
    const sentinel = join(root, "FILTER_RAN");
    // The repo's own config declares the filter; .gitattributes (itself untracked) applies it ONLY to the untracked file.
    await git(dir, ["config", "filter.evil.clean", `sh -c 'echo ran > ${sentinel}; cat'`]);
    await git(dir, ["config", "filter.evil.required", "true"]);
    writeFileSync(join(dir, ".gitattributes"), "payload.bin filter=evil\n");
    writeFileSync(join(dir, "payload.bin"), "raw bytes\n");
    const caught = await refusal(captureSnapshot({ dir, env: env() }));
    assert.equal(caught?.code, "GITVAULT_FILTER_ACTIVE");
    assert.deepEqual(caught?.details?.paths, [{ path: "payload.bin", filter: "evil" }]);
    assert.equal(existsSync(sentinel), false, "the filter process must never start");
    // and git's own view of the attribute agrees (the detection reads the attribute, not the filter)
    assert.deepEqual(await detectActiveFilters(dir, ["payload.bin", "README.md"]), [{ path: "payload.bin", filter: "evil" }]);
  });

  it("LFS is refused by its own name", async () => {
    const dir = await makeRepo(root);
    writeFileSync(join(dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    writeFileSync(join(dir, "big.bin"), "x\n");
    assert.equal(await code(captureSnapshot({ dir, env: env() })), "GITVAULT_LFS_UNSUPPORTED");
  });

  it("a tracked file with CRLF/eol config is hashed RAW (no text conversion)", async () => {
    const dir = await makeRepo(root);
    await git(dir, ["config", "core.autocrlf", "true"]);
    writeFileSync(join(dir, "crlf.txt"), "a\r\nb\r\n");
    const s = await captureSnapshot({ dir, env: env() });
    const blob = await git(dir, ["rev-parse", `${s.oid}:crlf.txt`]);
    const raw = await git(dir, ["hash-object", "--no-filters", "--stdin"], "a\r\nb\r\n");
    assert.equal(blob, raw);
  });
});

describe("unsupported repositories are refused by name", () => {
  it("linked worktree", async () => {
    const dir = await makeRepo(root);
    const linked = join(root, "linked");
    await git(dir, ["worktree", "add", "-q", linked, "-b", "wt"]);
    assert.equal(await code(inspectRepository(linked)), "GITVAULT_LINKED_WORKTREE");
    assert.equal(await code(captureSnapshot({ dir: linked, env: env() })), "GITVAULT_LINKED_WORKTREE");
    // the main work tree is still fine
    assert.equal((await inspectRepository(dir)).top_level, dir);
  });

  it("bare repository, sparse checkout, submodule gitlink, non-repository, repo-config include", async () => {
    const bare = join(root, "bare.git");
    mkdirSync(bare);
    await git(bare, ["init", "-q", "--bare", "."]);
    assert.equal(await code(inspectRepository(bare)), "GITVAULT_BARE_REPOSITORY");

    const sparse = await makeRepo(root, "sparse");
    await git(sparse, ["config", "core.sparseCheckout", "true"]);
    assert.equal(await code(inspectRepository(sparse)), "GITVAULT_SPARSE_CHECKOUT");

    const sub = await makeRepo(root, "withsub");
    const other = await makeRepo(root, "other");
    const otherHead = await git(other, ["rev-parse", "HEAD"]);
    await git(sub, ["update-index", "--add", "--cacheinfo", `160000,${otherHead},vendor/other`]);
    assert.equal(await code(inspectRepository(sub)), "GITVAULT_SUBMODULES_UNSUPPORTED");

    const plain = join(root, "plain");
    mkdirSync(plain);
    assert.equal(await code(inspectRepository(plain)), "GITVAULT_NOT_A_REPOSITORY");

    const inc = await makeRepo(root, "inc");
    writeFileSync(join(inc, ".git", "config"), readFileSync(join(inc, ".git", "config"), "utf8") + "[include]\n\tpath = /tmp/nothing\n");
    assert.equal(await code(inspectRepository(inc)), "GITVAULT_CONFIG_INCLUDE_REFUSED");
  });
});

describe("snapshot materialization — builds from the commit, never the mutating tree", () => {
  it("mid-deploy edits cannot skew provenance", async () => {
    const dir = await makeRepo(root);
    writeFileSync(join(dir, "app.js"), "v1\n");
    const s = await captureSnapshot({ dir, env: env() });
    writeFileSync(join(dir, "app.js"), "v2 (edited while the deploy is in flight)\n");
    writeFileSync(join(dir, "sneaky.js"), "never captured\n");
    const out = await materializeSnapshot(dir, s.oid, join(root, "build"));
    assert.equal(readFileSync(join(out, "app.js"), "utf8"), "v1\n");
    assert.equal(existsSync(join(out, "sneaky.js")), false);
    assert.equal(readFileSync(join(out, "README.md"), "utf8"), "hello\n");
    // the user's index is untouched
    assert.equal(await git(dir, ["diff", "--cached", "--name-only"]), "");
  });
});

describe("snapshot commitment", () => {
  it("snapshot_oid_hmac = HMAC(K_digest(snapshot_oid), JCS({oid, format:sha1}))", () => {
    const k = randomBytes(32);
    const oid = "c4b6d3fc93856a0d7a010896ed68f8c3f6bbf293";
    const expected = keyedCommitment(deriveDigestKey(k, "src_" + "ab".repeat(16), "0000000000000001", "snapshot_oid"), { oid, format: "sha1" });
    assert.equal(snapshotCommitment(k, "src_" + "ab".repeat(16), "0000000000000001", oid), expected);
  });
});
