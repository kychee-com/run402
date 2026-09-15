/**
 * `r.gitvault.scaffoldRemote` (first-deploy-agent-dx, design D3): the remote
 * is ALWAYS named `run402` — `origin` is never claimed, even when free — and
 * the scaffold acts on the APP ROOT only: a directory that is not a
 * repository is initialized, a directory that is itself a git toplevel gets
 * the remote, and a directory that merely lies inside some other repository
 * is left byte-identical and reported `skipped` with the toplevel named.
 *
 * These exercise real git, not the protocol: scaffoldRemote never opens a
 * vault or touches the network, so a real temp-dir repository is cheaper and
 * more honest than mocking git out.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Run402 } from "../index.js";
import { gitvaultRemoteUrl } from "./gitvault.js";
import { hardenedGit } from "../node/gitvault-snapshot.js";
import type { CredentialsProvider } from "../credentials.js";

function sdk(): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return { authorization: "Bearer test" };
    },
    async getProject() {
      return null;
    },
  };
  // scaffoldRemote never calls fetch — a fetch that throws proves it.
  const fetchImpl: typeof globalThis.fetch = async () => {
    throw new Error("scaffoldRemote must never touch the network");
  };
  return new Run402({ apiBase: "https://api.test", credentials: creds, fetch: fetchImpl });
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run402-gitvault-scaffold-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ORG = "org_demo";
const PROJECT = "prj_demo";
const OUR_URL = gitvaultRemoteUrl(ORG, PROJECT);

async function freshRepo(): Promise<string> {
  const dir = join(root, "repo");
  await hardenedGit(root, ["init", "-q", "-b", "main", "repo"]);
  return dir;
}

async function remoteUrl(dir: string, name: string): Promise<string> {
  return (await hardenedGit(dir, ["remote", "get-url", name])).text().trim();
}

describe("scaffoldRemote — the remote is always `run402`, origin is never claimed", () => {
  it("no remotes at all: adds `run402`, leaves `origin` absent", async () => {
    const dir = await freshRepo();
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(r.status, "scaffolded");
    assert.equal(r.name, "run402");
    assert.equal(r.url, OUR_URL);
    assert.equal(r.already_present, false);
    assert.equal(r.existing_url, null);
    assert.match(r.reason, /added/);
    assert.equal(await remoteUrl(dir, "run402"), OUR_URL);
    await assert.rejects(remoteUrl(dir, "origin"), "origin must not have been claimed");
  });

  it("origin pointing elsewhere: adds `run402`, leaves origin byte-identical", async () => {
    const dir = await freshRepo();
    await hardenedGit(dir, ["remote", "add", "origin", "https://github.com/kychee-com/example.git"]);
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(r.status, "scaffolded");
    assert.equal(r.name, "run402");
    assert.equal(await remoteUrl(dir, "origin"), "https://github.com/kychee-com/example.git");
    assert.equal(await remoteUrl(dir, "run402"), OUR_URL);
  });

  it("run402 already taken by something else: nothing is touched, nothing added", async () => {
    const dir = await freshRepo();
    await hardenedGit(dir, ["remote", "add", "run402", "https://gitlab.com/someone/else.git"]);
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(r.status, "scaffolded");
    assert.equal(r.name, "run402");
    assert.equal(r.already_present, true);
    assert.equal(r.existing_url, "https://gitlab.com/someone/else.git");
    assert.match(r.reason, /left unchanged/);
    assert.equal(await remoteUrl(dir, "run402"), "https://gitlab.com/someone/else.git");
  });

  it("idempotent: a second scaffold reports run402 already pointing here, changes nothing", async () => {
    const dir = await freshRepo();
    const s = sdk();
    const first = await s.gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(first.already_present, false);
    const second = await s.gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(second.status, "scaffolded");
    assert.equal(second.name, "run402");
    assert.equal(second.already_present, true);
    assert.equal(second.existing_url, OUR_URL);
    assert.match(second.reason, /already points here/);
  });

  it("not a repository yet: initializes one on branch main, then adds `run402`", async () => {
    const dir = join(root, "fresh");
    mkdirSync(dir);
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(r.status, "scaffolded");
    assert.equal(r.created_repository, true);
    assert.equal(r.name, "run402");
    assert.equal(await remoteUrl(dir, "run402"), OUR_URL);
    assert.equal((await hardenedGit(dir, ["symbolic-ref", "HEAD"])).text().trim(), "refs/heads/main");
  });

  it("an EXISTING repository's branch is never touched, even if it is not 'main'", async () => {
    const dir = await freshRepo();
    await hardenedGit(dir, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
    const before = (await hardenedGit(dir, ["symbolic-ref", "HEAD"])).text().trim();
    await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    const after = (await hardenedGit(dir, ["symbolic-ref", "HEAD"])).text().trim();
    assert.equal(after, before);
    assert.equal(after, "refs/heads/develop");
  });

  it("an explicit remote_name is honored verbatim", async () => {
    const dir = await freshRepo();
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT, remote_name: "vault" });
    assert.equal(r.name, "vault");
    await assert.rejects(remoteUrl(dir, "origin"), "no origin remote should exist");
    await assert.rejects(remoteUrl(dir, "run402"), "no run402 remote should exist");
    assert.equal(await remoteUrl(dir, "vault"), OUR_URL);
  });

  it("an explicit remote_name that already exists elsewhere is left byte-identical", async () => {
    const dir = await freshRepo();
    await hardenedGit(dir, ["remote", "add", "vault", "https://example.com/other.git"]);
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT, remote_name: "vault" });
    assert.equal(r.already_present, true);
    assert.equal(await remoteUrl(dir, "vault"), "https://example.com/other.git");
  });
});

describe("scaffoldRemote — the app root only; an enclosing repository is never touched", () => {
  it("a subdirectory of another repository: skipped, toplevel named, nothing changes anywhere", async () => {
    const top = await freshRepo();
    await hardenedGit(top, ["remote", "add", "origin", "https://github.com/kychee-com/monorepo.git"]);
    const app = join(top, "apps", "demo");
    mkdirSync(app, { recursive: true });
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: app, org_id: ORG, project_id: PROJECT });
    assert.equal(r.status, "skipped");
    assert.equal(realpathSync(r.toplevel!), realpathSync(top));
    assert.match(r.reason, /inside the repository at/);
    assert.equal(r.created_repository, false);
    // The enclosing repository has exactly the remotes it had.
    assert.equal((await hardenedGit(top, ["remote"])).text().trim(), "origin");
    // And no repository was created in the app directory.
    assert.equal(realpathSync((await hardenedGit(app, ["rev-parse", "--show-toplevel"])).text().trim()), realpathSync(top));
    // The skip names the way out: a nested repository for the app.
    assert.equal(r.next_actions?.length, 1);
    assert.equal(r.next_actions![0]!.type, "create_nested_repo");
    assert.equal(r.next_actions![0]!.command, `run402 repos create --nested --project ${PROJECT}`);
    assert.match(r.next_actions![0]!.why ?? "", /without touching the enclosing repository/);
    assert.equal(r.nested, undefined);
  });

  it("nested: true — the app root becomes its own repository; the enclosing one gains only an exclude line", async () => {
    const top = await freshRepo();
    await hardenedGit(top, ["remote", "add", "origin", "https://github.com/kychee-com/monorepo.git"]);
    const app = join(top, "apps", "demo");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "index.html"), "<h1>demo</h1>\n");
    writeFileSync(join(top, "README.md"), "# monorepo\n");

    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: app, org_id: ORG, project_id: PROJECT, nested: true });
    assert.equal(r.status, "scaffolded");
    assert.equal(r.nested, true);
    assert.equal(r.created_repository, true);
    assert.equal(r.already_present, false);
    assert.equal(realpathSync(r.enclosing_toplevel!), realpathSync(top));
    assert.equal(r.excluded_in_enclosing, true);
    assert.equal(r.next_actions, undefined);
    assert.equal(r.toplevel, undefined);

    // apps/demo is its own repository on `main`, carrying the remote.
    assert.ok(existsSync(join(app, ".git")));
    assert.equal(realpathSync((await hardenedGit(app, ["rev-parse", "--show-toplevel"])).text().trim()), realpathSync(app));
    assert.equal((await hardenedGit(app, ["symbolic-ref", "HEAD"])).text().trim(), "refs/heads/main");
    assert.equal(await remoteUrl(app, "run402"), OUR_URL);

    // The enclosing repository: exactly one exclude line, nothing else —
    // its remotes are what they were, no .gitignore appeared, its index is
    // empty, and `git status` no longer lists the app as untracked noise.
    const exclude = readFileSync(join(top, ".git", "info", "exclude"), "utf-8");
    assert.equal(exclude.split("\n").filter((line) => line === "/apps/demo/").length, 1);
    assert.equal((await hardenedGit(top, ["remote"])).text().trim(), "origin");
    assert.equal(existsSync(join(top, ".gitignore")), false);
    assert.equal(existsSync(join(top, ".gitmodules")), false);
    assert.equal((await hardenedGit(top, ["ls-files", "--stage"])).text().trim(), "");
    const porcelain = (await hardenedGit(top, ["status", "--porcelain", "--untracked-files=all"])).text();
    assert.ok(!porcelain.includes("apps/demo"), `enclosing status must not list the nested repo:\n${porcelain}`);
    assert.ok(porcelain.includes("README.md"), "the enclosing repository's own untracked files are still reported");

    // Idempotent: a second nested call re-reports the same shape, adds no
    // second exclude line, and re-inits nothing.
    const again = await sdk().gitvault.scaffoldRemote({ repo_dir: app, org_id: ORG, project_id: PROJECT, nested: true });
    assert.equal(again.status, "scaffolded");
    assert.equal(again.nested, true);
    assert.equal(again.created_repository, false);
    assert.equal(again.already_present, true);
    assert.equal(again.existing_url, OUR_URL);
    assert.equal(realpathSync(again.enclosing_toplevel!), realpathSync(top));
    assert.equal(again.excluded_in_enclosing, true);
    const excludeAgain = readFileSync(join(top, ".git", "info", "exclude"), "utf-8");
    assert.equal(excludeAgain.split("\n").filter((line) => line === "/apps/demo/").length, 1);
    assert.equal((await hardenedGit(app, ["symbolic-ref", "HEAD"])).text().trim(), "refs/heads/main");
  });

  it("nested: true inside a linked worktree excludes via the common dir (rev-parse --git-path)", async () => {
    const top = await freshRepo();
    writeFileSync(join(top, "README.md"), "# monorepo\n");
    await hardenedGit(top, ["add", "README.md"]);
    await hardenedGit(top, ["commit", "-q", "-m", "init"]);
    const wt = join(root, "wt");
    await hardenedGit(top, ["worktree", "add", "-q", wt]);
    const app = join(wt, "apps", "demo");
    mkdirSync(app, { recursive: true });
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: app, org_id: ORG, project_id: PROJECT, nested: true });
    assert.equal(r.status, "scaffolded");
    assert.equal(r.nested, true);
    assert.equal(realpathSync(r.enclosing_toplevel!), realpathSync(wt));
    assert.equal(r.excluded_in_enclosing, true);
    // The worktree's `.git` is a file pointing at the common dir; the exclude
    // lives there, and the worktree's status honors it.
    const exclude = readFileSync(join(top, ".git", "info", "exclude"), "utf-8");
    assert.ok(exclude.split("\n").includes("/apps/demo/"));
    const porcelain = (await hardenedGit(wt, ["status", "--porcelain", "--untracked-files=all"])).text();
    assert.ok(!porcelain.includes("apps/demo"), `worktree status must not list the nested repo:\n${porcelain}`);
  });

  it("nested: true on a directory in no repository at all is the ordinary scaffold (nested is moot)", async () => {
    const dir = join(root, "standalone");
    mkdirSync(dir, { recursive: true });
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT, nested: true });
    assert.equal(r.status, "scaffolded");
    assert.equal(r.created_repository, true);
    assert.equal(r.nested, undefined);
    assert.equal(r.enclosing_toplevel, undefined);
    assert.equal((await hardenedGit(dir, ["symbolic-ref", "HEAD"])).text().trim(), "refs/heads/main");
  });

  it("the toplevel itself is scaffolded normally", async () => {
    const top = await freshRepo();
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: top, org_id: ORG, project_id: PROJECT });
    assert.equal(r.status, "scaffolded");
    assert.equal(r.name, "run402");
  });
});
