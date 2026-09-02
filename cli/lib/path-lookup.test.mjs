/**
 * `path-lookup.mjs` — the PATH-executable probe `doctor.mjs`/`repos.mjs`'s
 * `view()` both use to detect a `kygit::` remote with no `git-remote-kygit`
 * helper installed (kygit-handoff design D8, mirroring
 * `kygit/kygit.mjs`'s own `findRemoteHelper`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExecutableOnPath } from "./path-lookup.mjs";

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
