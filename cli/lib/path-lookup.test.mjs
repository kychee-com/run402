/**
 * `path-lookup.mjs` — the PATH-executable probe behind `repos resume` /
 * `repos join`'s remote-helper next action.
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
      const bin = join(dir, "git-remote-run402");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      assert.equal(isExecutableOnPath("git-remote-run402", { PATH: dir }), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when the name exists but is not executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "path-lookup-"));
    try {
      const bin = join(dir, "git-remote-run402");
      writeFileSync(bin, "not executable");
      chmodSync(bin, 0o644);
      assert.equal(isExecutableOnPath("git-remote-run402", { PATH: dir }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when the name is nowhere on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "path-lookup-"));
    try {
      assert.equal(isExecutableOnPath("git-remote-run402", { PATH: dir }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks every directory on a multi-entry PATH, in order", () => {
    const dirA = mkdtempSync(join(tmpdir(), "path-lookup-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "path-lookup-b-"));
    try {
      const bin = join(dirB, "git-remote-run402");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      assert.equal(isExecutableOnPath("git-remote-run402", { PATH: `${dirA}:${dirB}` }), true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("returns false for an empty or missing PATH rather than throwing", () => {
    assert.equal(isExecutableOnPath("git-remote-run402", {}), false);
    assert.equal(isExecutableOnPath("git-remote-run402", { PATH: "" }), false);
  });
});

describe("remoteHelperNextAction", () => {
it("names the missing helper for a run402:: checkout, and nothing when it is on PATH or the checkout is unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "run402-remote-helper-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = run402::org/name\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    const emptyPath = { PATH: dir };
    const missing = remoteHelperNextAction(dir, emptyPath);
    assert.equal(missing?.type, "install_remote_helper");
    assert.match(missing.why, /git-remote-run402/);
    assert.equal(missing.command, "npm i -g run402");
    // present on PATH → nothing to say
    const bin = join(dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "git-remote-run402"), "#!/bin/sh\n"); chmodSync(join(bin, "git-remote-run402"), 0o755);
    assert.equal(remoteHelperNextAction(dir, { PATH: bin }), null);
    // any other remote → nothing to say
    writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = https://example.com/x.git\n`);
    assert.equal(remoteHelperNextAction(dir, emptyPath), null);
    // no checkout → null, never a throw
    assert.equal(remoteHelperNextAction(join(dir, "nope"), emptyPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
});
