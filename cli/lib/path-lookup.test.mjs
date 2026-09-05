/**
 * `path-lookup.mjs` — the PATH-executable probe `doctor.mjs`/`repos.mjs`'s
 * `view()` both use to detect a `kygit::` remote with no `git-remote-kygit`
 * helper installed (kygit-handoff design D8, mirroring
 * `kygit/kygit.mjs`'s own `findRemoteHelper`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExecutableOnPath, remoteHelperNextAction } from "./path-lookup.mjs";

describe("isExecutableOnPath", () => {
  it("finds an executable file on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "path-lookup-"));
    try {
      const bin = join(dir, "git-remote-kygit");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      assert.equal(isExecutableOnPath("git-remote-kygit", { PATH: dir }), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when the name exists but is not executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "path-lookup-"));
    try {
      const bin = join(dir, "git-remote-kygit");
      writeFileSync(bin, "not executable");
      chmodSync(bin, 0o644);
      assert.equal(isExecutableOnPath("git-remote-kygit", { PATH: dir }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when the name is nowhere on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "path-lookup-"));
    try {
      assert.equal(isExecutableOnPath("git-remote-kygit", { PATH: dir }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks every directory on a multi-entry PATH, in order", () => {
    const dirA = mkdtempSync(join(tmpdir(), "path-lookup-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "path-lookup-b-"));
    try {
      const bin = join(dirB, "git-remote-kygit");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      assert.equal(isExecutableOnPath("git-remote-kygit", { PATH: `${dirA}:${dirB}` }), true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("returns false for an empty or missing PATH rather than throwing", () => {
    assert.equal(isExecutableOnPath("git-remote-kygit", {}), false);
    assert.equal(isExecutableOnPath("git-remote-kygit", { PATH: "" }), false);
  });
});

describe("remoteHelperNextAction", () => {
it("names the missing helper for the checkout's remote scheme, and nothing when it is on PATH or the checkout is unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-remote-helper-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = kygit::org/name\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    const emptyPath = { PATH: dir };
    const missing = remoteHelperNextAction(dir, emptyPath);
    assert.equal(missing?.type, "install_remote_helper");
    assert.match(missing.why, /git-remote-kygit/);
    assert.equal(missing.command, "npm i -g @kychee/kygit run402");
    // present on PATH → nothing to say
    const bin = join(dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "git-remote-kygit"), "#!/bin/sh\n"); chmodSync(join(bin, "git-remote-kygit"), 0o755);
    assert.equal(remoteHelperNextAction(dir, { PATH: bin }), null);
    // run402:: scheme names the other helper
    writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = run402::org/name\n`);
    assert.match(remoteHelperNextAction(dir, emptyPath).why, /git-remote-run402/);
    // no checkout → null, never a throw
    assert.equal(remoteHelperNextAction(join(dir, "nope"), emptyPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
});
