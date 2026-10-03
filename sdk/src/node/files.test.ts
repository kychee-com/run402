/**
 * Unit tests for `fileSetFromDir` — the Node-only directory-to-FileSet
 * helper used by the internal apply engine and the `sites.deployDir` shim.
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

import { fileSetFromDir, fileSetFromDirSync, normalizeRelPath } from "./files.js";
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

  it("skips common secret-bearing files by default", async () => {
    const root = fresh();
    try {
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
      writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://secret");
      writeFileSync(join(root, ".env.production"), "API_KEY=secret");
      writeFileSync(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=secret");
      writeFileSync(join(root, "server.key"), "private key");
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested", "id_ed25519"), "private key");
      writeFileSync(join(root, "nested", "cert.pem"), "private key");

      const set = await fileSetFromDir(root);
      assert.deepEqual(Object.keys(set), ["index.html"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("can explicitly include secret-bearing files", async () => {
    const root = fresh();
    try {
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
      writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://secret");

      const set = await fileSetFromDir(root, { includeSensitive: true });
      assert.deepEqual(Object.keys(set).sort(), [".env", "index.html"]);
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

describe("fileSetFromDirSync", () => {
  it("collects exactly what fileSetFromDir collects, with the same ignore rules", async () => {
    const root = fresh();
    try {
      mkdirSync(join(root, "assets", "img"), { recursive: true });
      mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
      writeFileSync(join(root, "assets", "style.css"), "body{}");
      writeFileSync(join(root, "assets", "img", "logo.png"), "png");
      writeFileSync(join(root, "node_modules", "dep", "index.js"), "x");
      writeFileSync(join(root, ".git", "HEAD"), "ref");
      writeFileSync(join(root, ".env.local"), "SECRET=1");
      writeFileSync(join(root, "server.key"), "key");
      writeFileSync(join(root, "skip-me.txt"), "x");

      const opts = { ignore: ["skip-me.txt"] };
      assert.deepEqual(fileSetFromDirSync(root, opts), await fileSetFromDir(root, opts));
      assert.deepEqual(Object.keys(fileSetFromDirSync(root, opts)).sort(), ["assets/img/logo.png", "assets/style.css", "index.html"]);
      assert.deepEqual(
        Object.keys(fileSetFromDirSync(root, { ...opts, includeSensitive: true })).sort(),
        Object.keys(await fileSetFromDir(root, { ...opts, includeSensitive: true })).sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses symlinks, non-directories and empty trees like the async walker", () => {
    const root = fresh();
    try {
      assert.throws(() => fileSetFromDirSync(root), LocalError);
      writeFileSync(join(root, "a.txt"), "a");
      symlinkSync(join(root, "a.txt"), join(root, "link.txt"));
      assert.throws(() => fileSetFromDirSync(root), /symlink found/);
      assert.throws(() => fileSetFromDirSync(join(root, "a.txt")), /is not a directory/);
      assert.throws(() => fileSetFromDirSync(join(root, "missing")), /cannot read directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
