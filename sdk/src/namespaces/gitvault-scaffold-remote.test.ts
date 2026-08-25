/**
 * `r.gitvault.scaffoldRemote` — D1 (`repo-first-onramp` task 2.1): the remote
 * scaffold claims `origin` additively, falls back to `run402` only when
 * `origin` is already taken by something else, and never modifies or
 * reclaims ANY existing remote it finds under either name.
 *
 * These exercise real git, not the protocol: scaffoldRemote never opens a
 * vault or touches the network, so a real temp-dir repository is cheaper and
 * more honest than mocking git out.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

describe("scaffoldRemote — D1 claim origin additively", () => {
  it("origin-absent: claims `origin`", async () => {
    const dir = await freshRepo();
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(r.name, "origin");
    assert.equal(r.url, OUR_URL);
    assert.equal(r.already_present, false);
    assert.equal(r.existing_url, null);
    assert.match(r.reason, /claimed it/);
    assert.equal((await hardenedGit(dir, ["remote", "get-url", "origin"])).text().trim(), OUR_URL);
  });

  it("origin-present-pointing-elsewhere: falls back to `run402`, leaves origin byte-identical", async () => {
    const dir = await freshRepo();
    await hardenedGit(dir, ["remote", "add", "origin", "https://github.com/kychee-com/example.git"]);
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(r.name, "run402");
    assert.equal(r.url, OUR_URL);
    assert.equal(r.already_present, false);
    assert.match(r.reason, /origin.*added as 'run402'/);
    // origin is left EXACTLY as it was.
    assert.equal((await hardenedGit(dir, ["remote", "get-url", "origin"])).text().trim(), "https://github.com/kychee-com/example.git");
    assert.equal((await hardenedGit(dir, ["remote", "get-url", "run402"])).text().trim(), OUR_URL);
  });

  it("run402-already-present: origin AND run402 both taken by something else — neither is touched, nothing added", async () => {
    const dir = await freshRepo();
    await hardenedGit(dir, ["remote", "add", "origin", "https://github.com/kychee-com/example.git"]);
    await hardenedGit(dir, ["remote", "add", "run402", "https://gitlab.com/someone/else.git"]);
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(r.name, "run402");
    assert.equal(r.already_present, true);
    assert.equal(r.existing_url, "https://gitlab.com/someone/else.git");
    assert.match(r.reason, /neither remote was touched/);
    // Both remotes are exactly as they were — nothing added, nothing rewritten.
    assert.equal((await hardenedGit(dir, ["remote", "get-url", "origin"])).text().trim(), "https://github.com/kychee-com/example.git");
    assert.equal((await hardenedGit(dir, ["remote", "get-url", "run402"])).text().trim(), "https://gitlab.com/someone/else.git");
  });

  it("idempotent: a second scaffold on the same vault reports origin already claimed, changes nothing", async () => {
    const dir = await freshRepo();
    const s = sdk();
    const first = await s.gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(first.already_present, false);
    const second = await s.gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(second.name, "origin");
    assert.equal(second.already_present, true);
    assert.equal(second.existing_url, OUR_URL);
    assert.match(second.reason, /already points here/);
  });

  it("origin taken elsewhere, but run402 already points at this exact vault: idempotent on the fallback name too", async () => {
    const dir = await freshRepo();
    await hardenedGit(dir, ["remote", "add", "origin", "https://github.com/kychee-com/example.git"]);
    await hardenedGit(dir, ["remote", "add", "run402", OUR_URL]);
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(r.name, "run402");
    assert.equal(r.already_present, true);
    assert.equal(r.existing_url, OUR_URL);
    assert.match(r.reason, /already points here, nothing to add/);
  });

  it("not a repository yet: initializes one, then claims origin", async () => {
    const dir = join(root, "fresh");
    mkdirSync(dir, { recursive: true });
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT });
    assert.equal(r.created_repository, true);
    assert.equal(r.name, "origin");
    assert.equal((await hardenedGit(dir, ["remote", "get-url", "origin"])).text().trim(), OUR_URL);
  });

  it("an explicit remote_name is honored verbatim and never claims `origin`", async () => {
    const dir = await freshRepo();
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT, remote_name: "vault" });
    assert.equal(r.name, "vault");
    assert.equal(r.already_present, false);
    await assert.rejects(hardenedGit(dir, ["remote", "get-url", "origin"]), "no origin remote should exist");
    assert.equal((await hardenedGit(dir, ["remote", "get-url", "vault"])).text().trim(), OUR_URL);
  });

  it("an explicit remote_name that already exists elsewhere is left byte-identical", async () => {
    const dir = await freshRepo();
    await hardenedGit(dir, ["remote", "add", "vault", "https://example.com/other.git"]);
    const r = await sdk().gitvault.scaffoldRemote({ repo_dir: dir, org_id: ORG, project_id: PROJECT, remote_name: "vault" });
    assert.equal(r.already_present, true);
    assert.equal(r.existing_url, "https://example.com/other.git");
    assert.equal((await hardenedGit(dir, ["remote", "get-url", "vault"])).text().trim(), "https://example.com/other.git");
  });
});
