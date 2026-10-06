/**
 * Build determinism for the Vite plugin.
 *
 * Everything the plugin feeds into the SSR server bundle — the
 * `virtual:run402-assetmap` module source and the rewritten `.astro`
 * sources — plus the on-disk `_assets-manifest.json` must be
 * byte-identical across rebuilds of the same commit and across checkout
 * paths. Otherwise the SSR function's code hash changes on every build
 * and the gateway redeploys it even when no source changed.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BuildCache } from "./cache.js";
import type { AssetRef } from "./types.js";
import type { ProjectAssetsClient } from "./uploader.js";
import { clearRegistry, dumpRegistry } from "./registry.js";
import {
  assetMapKey,
  createVitePlugin,
  manifestGeneratedAt,
  type VitePluginState,
} from "./vite-plugin.js";

const RESOLVED_VIRTUAL_ID = "\0virtual:run402-assetmap";
const PAGE_REL = join("src", "pages", "index.astro");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearRegistry();
});

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "run402-astro-determinism-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src", "pages"), { recursive: true });
  mkdirSync(join(root, "src", "images"), { recursive: true });
  mkdirSync(join(root, "content", "photos"), { recursive: true });
  writeFileSync(
    join(root, PAGE_REL),
    [
      "---",
      'import Image from "@run402/astro/Image.astro";',
      "---",
      '<Image src="../images/hero.jpg" alt="Hero" />',
      '<Image src="../images/logo.png" alt="Logo" />',
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "src", "images", "hero.jpg"), "hero-bytes");
  writeFileSync(join(root, "src", "images", "logo.png"), "logo-bytes");
  writeFileSync(join(root, "content", "photos", "b.jpg"), "photo-b");
  writeFileSync(join(root, "content", "photos", "a.jpg"), "photo-a");
  return root;
}

/**
 * Fake gateway: the AssetRef depends only on the key and the bytes, the
 * way CAS-addressed refs do.
 */
function fakeClient(): ProjectAssetsClient {
  return {
    assets: {
      async put(key, source) {
        const sha256 = createHash("sha256").update(source).digest("hex");
        const ref: AssetRef = {
          key,
          sha256,
          size_bytes: typeof source === "string" ? source.length : source.byteLength,
          content_type: "image/jpeg",
          url: `https://example.com/${sha256}`,
          cdn_url: `https://cdn.example.com/${sha256}`,
        };
        return ref;
      },
    },
  };
}

function makeState(root: string, virtualOrder: "forward" | "reverse"): VitePluginState {
  const state: VitePluginState = {
    projectRoot: root,
    aliases: null,
    client: fakeClient(),
    cache: new BuildCache(root),
    prefix: "astro/",
    dryRun: false,
    verbose: false,
    refMap: new Map(),
    publicDirRefs: new Set(),
    virtualEntries: new Map(),
    assetsDirs: [
      { absolutePath: join(root, "content", "photos"), baseDir: join(root, "content", "photos") },
    ],
    manifestPath: join(root, "dist", "client", "_assets-manifest.json"),
    assetExtensions: [".jpg", ".jpeg", ".png", ".webp"],
    manifestKeyByAbsPath: new Map(),
    projectId: "prj_test",
  };
  if (virtualOrder === "reverse") {
    // Simulate a different upload completion order: re-insert every
    // entry in reverse whenever the uploader populates the map.
    const original = state.virtualEntries;
    const realSet = original.set.bind(original);
    original.set = (k, v) => {
      const prior = Array.from(original.entries());
      original.clear();
      realSet(k, v);
      for (const [pk, pv] of prior) realSet(pk, pv);
      return original;
    };
  }
  return state;
}

interface BuildOutputs {
  virtualModule: string;
  page: string;
  manifestFile: string;
}

async function build(root: string, virtualOrder: "forward" | "reverse" = "forward"): Promise<BuildOutputs> {
  const state = makeState(root, virtualOrder);
  const plugin = createVitePlugin(state);
  plugin.configResolved?.({ root });
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await plugin.buildStart?.();
    const virtualModule = await plugin.load?.(RESOLVED_VIRTUAL_ID);
    const page = await plugin.load?.(join(root, PAGE_REL));
    plugin.closeBundle?.();
    assert.equal(typeof virtualModule, "string");
    assert.equal(typeof page, "string");
    return {
      virtualModule: virtualModule as string,
      page: page as string,
      manifestFile: readFileSync(state.manifestPath, "utf-8"),
    };
  } finally {
    process.stderr.write = stderrWrite;
  }
}

describe("vite plugin build determinism", () => {
  it("rebuilding the same fixture produces byte-identical bundle inputs and manifest", async () => {
    const root = makeFixture();
    const first = await build(root);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await build(root, "reverse");
    assert.equal(second.virtualModule, first.virtualModule);
    assert.equal(second.page, first.page);
    assert.equal(second.manifestFile, first.manifestFile);
  });

  it("builds from two different checkout paths produce byte-identical output", async () => {
    const rootA = makeFixture();
    const rootB = makeFixture();
    assert.notEqual(rootA, rootB);
    const a = await build(rootA);
    const b = await build(rootB, "reverse");
    assert.equal(b.virtualModule, a.virtualModule);
    assert.equal(b.page, a.page);
    assert.equal(b.manifestFile, a.manifestFile);
    for (const out of [a.virtualModule, a.page, a.manifestFile]) {
      assert.ok(!out.includes(basename(rootA)), "output leaks the checkout path");
    }
  });

  it("keys the virtual module and the rewritten src by project-relative path", async () => {
    const root = makeFixture();
    const out = await build(root);
    assert.match(out.page, /<Image src="src\/images\/hero\.jpg" alt="Hero" \/>/);
    assert.match(out.virtualModule, /\["src\/images\/hero\.jpg", /);
    // Dev-mode registry uses the same key the rewritten prop carries.
    assert.ok(dumpRegistry().has("src/images/hero.jpg"));
  });

  it("the bundled manifest matches the on-disk manifest", async () => {
    const root = makeFixture();
    const out = await build(root);
    const bundled = /export const manifest = (.*);\n$/.exec(out.virtualModule)?.[1];
    assert.ok(bundled);
    assert.deepEqual(JSON.parse(bundled), JSON.parse(out.manifestFile));
    assert.deepEqual(Object.keys(JSON.parse(out.manifestFile).assets), ["a.jpg", "b.jpg"]);
  });
});

describe("manifestGeneratedAt", () => {
  it("defaults to the Unix epoch, never the wall clock", () => {
    assert.equal(manifestGeneratedAt({}), "1970-01-01T00:00:00.000Z");
  });

  it("honors SOURCE_DATE_EPOCH", () => {
    assert.equal(manifestGeneratedAt({ SOURCE_DATE_EPOCH: "1700000000" }), "2023-11-14T22:13:20.000Z");
  });

  it("ignores a malformed SOURCE_DATE_EPOCH", () => {
    assert.equal(manifestGeneratedAt({ SOURCE_DATE_EPOCH: "yesterday" }), "1970-01-01T00:00:00.000Z");
    assert.equal(manifestGeneratedAt({ SOURCE_DATE_EPOCH: "-5" }), "1970-01-01T00:00:00.000Z");
  });
});

describe("assetMapKey", () => {
  it("is the project-relative path with forward slashes", () => {
    assert.equal(assetMapKey("/a/b", "/a/b/src/images/x.jpg"), "src/images/x.jpg");
    assert.equal(assetMapKey("/a/b", "/a/shared/x.jpg"), "../shared/x.jpg");
  });
});
