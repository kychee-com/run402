import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { astroKeyWarning, normalizeServerOutput, sortManifestAssets } from "./ssr-determinism.js";

/** What Astro's injectManifest writes: compact JSON.stringify output. */
function astroManifestChunk(assets: string[]): string {
  const manifest = {
    adapterName: "@run402/astro",
    inlinedScripts: [["/src/a.astro", "console.log(1)"]],
    assets,
    i18n: null,
  };
  return `const manifest = deserializeManifest(${JSON.stringify(manifest)});\nexport { manifest };\n`;
}

describe("sortManifestAssets", () => {
  it("sorts Astro's compact manifest assets list", () => {
    const out = sortManifestAssets(astroManifestChunk(["/c.css", "/a.js", "/b.png"]));
    assert.equal(out, astroManifestChunk(["/a.js", "/b.png", "/c.css"]));
  });

  it("makes two race-ordered outputs byte-identical", () => {
    const a = sortManifestAssets(astroManifestChunk(["/favicon.svg", "/_astro/x.js", "/robots.txt"]));
    const b = sortManifestAssets(astroManifestChunk(["/robots.txt", "/favicon.svg", "/_astro/x.js"]));
    assert.equal(a, b);
  });

  it("is whitespace-tolerant and keeps esbuild's reprinted layout", () => {
    const code = [
      "var manifest = {",
      '  "inlinedScripts": [],',
      '  "assets": [',
      '    "/b",',
      '    "/a"',
      "  ],",
      '  "i18n": null',
      "};",
    ].join("\n");
    const expected = code.replace('"/b",\n    "/a"', '"/a",\n    "/b"');
    assert.equal(sortManifestAssets(code), expected);
    assert.equal(sortManifestAssets('"inlinedScripts": [], "assets": ["/b", "/a"]'), '"inlinedScripts": [], "assets": ["/a", "/b"]');
  });

  it("leaves an unrelated assets key alone", () => {
    const code = 'const user = {"assets":["/z","/y"]};';
    assert.equal(sortManifestAssets(code), code);
  });

  it("handles escaped quotes and brackets inside strings", () => {
    const code = astroManifestChunk(['/z "q".js', "/a[1].js"]).replace(
      '"inlinedScripts":[["/src/a.astro","console.log(1)"]]',
      '"inlinedScripts":[["/src/a.astro","x = \\"]\\"; y = [1]"]]',
    );
    const out = sortManifestAssets(code);
    assert.ok(out.includes(JSON.stringify(["/a[1].js", '/z "q".js'])));
    assert.ok(out.includes('x = \\"]\\"; y = [1]'));
  });

  it("leaves a non-string assets array alone", () => {
    const code = '"inlinedScripts":[],"assets":[2,1]';
    assert.equal(sortManifestAssets(code), code);
  });
});

describe("normalizeServerOutput", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("rewrites only the server chunks that carry the manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run402-ssr-determinism-"));
    dirs.push(dir);
    mkdirSync(join(dir, "chunks"));
    writeFileSync(join(dir, "chunks", "manifest_abc.mjs"), astroManifestChunk(["/b", "/a"]));
    writeFileSync(join(dir, "entry.mjs"), 'export const assets = {"assets":["/b","/a"]};');
    const changed = await normalizeServerOutput(dir);
    assert.deepEqual(changed, [join(dir, "chunks", "manifest_abc.mjs")]);
    assert.equal(readFileSync(join(dir, "chunks", "manifest_abc.mjs"), "utf-8"), astroManifestChunk(["/a", "/b"]));
    assert.equal(readFileSync(join(dir, "entry.mjs"), "utf-8"), 'export const assets = {"assets":["/b","/a"]};');
    assert.deepEqual(await normalizeServerOutput(dir), []);
  });

  it("is a no-op for a missing directory", async () => {
    assert.deepEqual(await normalizeServerOutput(join(tmpdir(), "run402-does-not-exist-xyz")), []);
  });
});

describe("astroKeyWarning", () => {
  it("warns when ASTRO_KEY is unset", () => {
    const warning = astroKeyWarning({});
    assert.ok(warning);
    assert.match(warning, /ASTRO_KEY is not set/);
    assert.match(warning, /redeployed on every\s+deploy/);
    assert.match(warning, /npx astro create-key/);
  });

  it("is silent when ASTRO_KEY is set", () => {
    assert.equal(astroKeyWarning({ ASTRO_KEY: "c2VjcmV0" }), null);
  });
});
