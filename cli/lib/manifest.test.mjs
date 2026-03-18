import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFilePathsInManifest } from "./manifest.mjs";

let tempDir;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "manifest-test-"));
  // Create test files
  writeFileSync(join(tempDir, "index.html"), "<!DOCTYPE html><html><body>Hello</body></html>");
  writeFileSync(join(tempDir, "style.css"), "body { margin: 0; }");
  writeFileSync(join(tempDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // PNG header
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveFilePathsInManifest", () => {
  it("resolves path to inline data for text files", () => {
    const manifest = {
      files: [{ file: "index.html", path: "index.html" }],
    };
    resolveFilePathsInManifest(manifest, tempDir);
    assert.equal(manifest.files[0].data, "<!DOCTYPE html><html><body>Hello</body></html>");
    assert.equal(manifest.files[0].path, undefined, "path field should be removed");
    assert.equal(manifest.files[0].encoding, undefined, "text files should not set encoding");
  });

  it("auto-detects binary files and base64-encodes them", () => {
    const manifest = {
      files: [{ file: "logo.png", path: "logo.png" }],
    };
    resolveFilePathsInManifest(manifest, tempDir);
    assert.equal(manifest.files[0].encoding, "base64");
    // Verify it's valid base64 that decodes to our PNG header
    const buf = Buffer.from(manifest.files[0].data, "base64");
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50); // 'P'
  });

  it("leaves entries with existing data untouched", () => {
    const manifest = {
      files: [{ file: "index.html", data: "<h1>inline</h1>" }],
    };
    resolveFilePathsInManifest(manifest, tempDir);
    assert.equal(manifest.files[0].data, "<h1>inline</h1>");
  });

  it("mixes path and data entries", () => {
    const manifest = {
      files: [
        { file: "index.html", data: "<h1>inline</h1>" },
        { file: "style.css", path: "style.css" },
      ],
    };
    resolveFilePathsInManifest(manifest, tempDir);
    assert.equal(manifest.files[0].data, "<h1>inline</h1>");
    assert.equal(manifest.files[1].data, "body { margin: 0; }");
    assert.equal(manifest.files[1].path, undefined);
  });

  it("uses path as file name when file is omitted", () => {
    const manifest = {
      files: [{ path: "style.css" }],
    };
    resolveFilePathsInManifest(manifest, tempDir);
    assert.equal(manifest.files[0].file, "style.css");
    assert.equal(manifest.files[0].data, "body { margin: 0; }");
  });

  it("handles manifest with no files array", () => {
    const manifest = { migrations: "CREATE TABLE t (id int)" };
    resolveFilePathsInManifest(manifest, tempDir);
    assert.equal(manifest.files, undefined, "should not add a files array");
  });

  it("throws on missing file", () => {
    const manifest = {
      files: [{ file: "missing.html", path: "does-not-exist.html" }],
    };
    assert.throws(
      () => resolveFilePathsInManifest(manifest, tempDir),
      /ENOENT/,
    );
  });
});
