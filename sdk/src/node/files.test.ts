/**
 * Unit tests for `fileSetFromDir` — the Node-only directory-to-FileSet
 * helper used by `r.deploy.apply` and the `sites.deployDir` shim.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileSetFromDir, normalizeRelPath } from "./files.js";
import { LocalError } from "../errors.js";

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "run402-files-test-"));
}

describe("fileSetFromDir", () => {
  it("walks the tree and emits FsFileSource markers per file", async () => {
    const root = fresh();
    try {
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
      mkdirSync(join(root, "assets"));
      writeFileSync(join(root, "assets", "style.css"), "body{}");

      const set = await fileSetFromDir(root);
      assert.deepEqual(Object.keys(set).sort(), [
        "assets/style.css",
        "index.html",
      ]);
      const indexEntry = set["index.html"] as { __source: string; path: string };
      assert.equal(indexEntry.__source, "fs-file");
      assert.equal(indexEntry.path, join(root, "index.html"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips .git, node_modules, .DS_Store at any depth", async () => {
    const root = fresh();
    try {
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref");
      mkdirSync(join(root, "node_modules"));
      mkdirSync(join(root, "node_modules", "foo"));
      writeFileSync(join(root, "node_modules", "foo", "package.json"), "{}");
      writeFileSync(join(root, ".DS_Store"), "");

      const set = await fileSetFromDir(root);
      assert.deepEqual(Object.keys(set), ["index.html"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects custom ignore list (merged with defaults)", async () => {
    const root = fresh();
    try {
      writeFileSync(join(root, "keep.txt"), "1");
      writeFileSync(join(root, "skip.txt"), "2");

      const set = await fileSetFromDir(root, { ignore: ["skip.txt"] });
      assert.deepEqual(Object.keys(set), ["keep.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks with LocalError", async () => {
    const root = fresh();
    const target = fresh();
    try {
      writeFileSync(join(target, "real.html"), "x");
      symlinkSync(join(target, "real.html"), join(root, "linked.html"));

      await assert.rejects(
        () => fileSetFromDir(root),
        (err: unknown) =>
          err instanceof LocalError && /symlink/.test((err as Error).message),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("throws LocalError when the directory does not exist", async () => {
    await assert.rejects(
      () => fileSetFromDir("/this/does/not/exist/anywhere/abc123"),
      (err: unknown) =>
        err instanceof LocalError && /cannot read directory/.test((err as Error).message),
    );
  });

  it("throws LocalError when the path is not a directory", async () => {
    const root = fresh();
    try {
      const filePath = join(root, "single.txt");
      writeFileSync(filePath, "x");
      await assert.rejects(
        () => fileSetFromDir(filePath),
        (err: unknown) =>
          err instanceof LocalError && /is not a directory/.test((err as Error).message),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws LocalError when only ignored entries remain", async () => {
    const root = fresh();
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref");
      writeFileSync(join(root, ".DS_Store"), "");

      await assert.rejects(
        () => fileSetFromDir(root),
        (err: unknown) =>
          err instanceof LocalError &&
          /no deployable files/.test((err as Error).message),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizeRelPath converts to forward slashes", () => {
    // POSIX inputs pass through; backslash inputs would convert (Windows-only).
    assert.equal(normalizeRelPath("a/b/c.html"), "a/b/c.html");
  });
});
