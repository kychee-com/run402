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
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  });

  it("the toplevel itself is scaffolded normally", async () => {
    const top = await freshRepo();
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: top, org_id: ORG, project_id: PROJECT });
    assert.equal(r.status, "scaffolded");
    assert.equal(r.name, "run402");
  });
});
