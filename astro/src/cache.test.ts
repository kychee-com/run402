import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BuildCache } from "./cache.js";
import type { AssetRef } from "./types.js";

const sampleRef: AssetRef = {
  key: "astro/hero.jpg",
  sha256: "deadbeef".padEnd(64, "0"),
  size_bytes: 1234,
  content_type: "image/jpeg",
  url: "https://example.com/hero.jpg",
  cdn_url: "https://cdn.example.com/hero.jpg",
  width_px: 1600,
  height_px: 1200,
  blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
  variant_spec_version: "v1",
  display_url: "https://cdn.example.com/hero.jpg",
};

describe("BuildCache", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r402-cache-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null on cache miss", () => {
    const cache = new BuildCache(root);
    assert.equal(cache.get("/abs/foo.jpg", "any-sha"), null);
  });

  it("returns the cached AssetRef when sha matches", () => {
    const cache = new BuildCache(root);
    cache.set("/abs/hero.jpg", sampleRef.sha256, sampleRef);
    const got = cache.get("/abs/hero.jpg", sampleRef.sha256);
    assert.deepEqual(got, sampleRef);
  });

  it("returns null when sha differs (cache invalidation on content change)", () => {
    const cache = new BuildCache(root);
    cache.set("/abs/hero.jpg", sampleRef.sha256, sampleRef);
    const got = cache.get("/abs/hero.jpg", "differentshadifferentshadifferent");
    assert.equal(got, null);
  });

  it("persists across instances", () => {
    const cache1 = new BuildCache(root);
    cache1.set("/abs/hero.jpg", sampleRef.sha256, sampleRef);
    const cache2 = new BuildCache(root);
    const got = cache2.get("/abs/hero.jpg", sampleRef.sha256);
    assert.deepEqual(got, sampleRef);
  });

  it("creates node_modules/.run402/assetMap.json on first set()", () => {
    const cache = new BuildCache(root);
    cache.set("/abs/hero.jpg", sampleRef.sha256, sampleRef);
    const expected = join(root, "node_modules", ".run402", "assetMap.json");
    assert.ok(existsSync(expected), "cache file should exist");
    const parsed = JSON.parse(readFileSync(expected, "utf-8"));
    assert.equal(parsed.version, 1);
    assert.ok(parsed.entries["/abs/hero.jpg"]);
  });

  it("creates .gitignore with cache dir entry on first set()", () => {
    const cache = new BuildCache(root);
    cache.set("/abs/hero.jpg", sampleRef.sha256, sampleRef);
    const gi = join(root, ".gitignore");
    assert.ok(existsSync(gi), ".gitignore should exist");
    const content = readFileSync(gi, "utf-8");
    assert.match(content, /node_modules\/\.run402\//);
  });

  it("appends to existing .gitignore without dupes", () => {
    writeFileSync(join(root, ".gitignore"), "dist/\nnode_modules/\n", "utf-8");
    const cache = new BuildCache(root);
    cache.set("/abs/hero.jpg", sampleRef.sha256, sampleRef);
    const content = readFileSync(join(root, ".gitignore"), "utf-8");
    assert.match(content, /^dist\/$/m);
    assert.match(content, /^node_modules\/$/m);
    assert.match(content, /^node_modules\/\.run402\/$/m);
  });

  it("does not append .gitignore line when already present", () => {
    writeFileSync(
      join(root, ".gitignore"),
      "node_modules/.run402/\nother-entry/\n",
      "utf-8",
    );
    const cache = new BuildCache(root);
    cache.set("/abs/hero.jpg", sampleRef.sha256, sampleRef);
    const content = readFileSync(join(root, ".gitignore"), "utf-8");
    const matches = content.match(/node_modules\/\.run402/g);
    assert.equal(matches?.length, 1, "should appear exactly once");
  });

  it("delete() removes an entry", () => {
    const cache = new BuildCache(root);
    cache.set("/abs/hero.jpg", sampleRef.sha256, sampleRef);
    assert.equal(cache.size(), 1);
    cache.delete("/abs/hero.jpg");
    assert.equal(cache.size(), 0);
    assert.equal(cache.get("/abs/hero.jpg", sampleRef.sha256), null);
  });

  it("corrupt cache file is treated as empty (does not throw)", async () => {
    const cacheDir = join(root, "node_modules", ".run402");
    const { mkdirSync: mkdir, writeFileSync: writeFile } = await import("node:fs");
    mkdir(cacheDir, { recursive: true });
    writeFile(join(cacheDir, "assetMap.json"), "{not json{}", "utf-8");
    const cache = new BuildCache(root);
    assert.equal(cache.size(), 0);
  });
});
