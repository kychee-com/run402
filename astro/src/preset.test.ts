/**
 * The default-export preset, `run402(options)`: every Astro config field it
 * does not read itself reaches Astro unchanged, as through
 * `defineConfig({...})`; `integrations` are added to the preset's; its own
 * options never reach Astro.
 *
 * The last test builds the endpoint-tools fixture with Astro, so the `base`
 * set through `run402({ base })` is the one the adapter applies to a tool's
 * path.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { AstroIntegration } from "astro";

import run402 from "./index.js";

const integration = (name: string): AstroIntegration => ({ name, hooks: {} });

describe("run402() passes Astro's own config fields through", () => {
  it("keeps base, trailingSlash, site, vite, build, srcDir and redirects as given", () => {
    const vite = { define: { __FLAG__: "true" } };
    const build = { format: "file" as const };
    const redirects = { "/old": "/new" };
    const config = run402({
      projectId: "prj_x",
      base: "/app",
      trailingSlash: "never",
      site: "https://example.com",
      vite,
      build,
      srcDir: "./source",
      redirects,
    });
    assert.equal(config.base, "/app");
    assert.equal(config.trailingSlash, "never");
    assert.equal(config.site, "https://example.com");
    assert.equal(config.vite, vite);
    assert.equal(config.build, build);
    assert.equal(config.srcDir, "./source");
    assert.equal(config.redirects, redirects);
  });

  it("keeps its own options out of Astro's config", () => {
    const config = run402({
      projectId: "prj_x",
      assetPrefix: "img/",
      dryRun: true,
      verbose: true,
      credentials: {},
      assetsDir: "assets",
      manifestPath: "manifest.json",
      assetExtensions: [".png"],
      images: true,
      ssr: { memoryMb: 512 },
      base: "/app",
    });
    assert.deepEqual(Object.keys(config).sort(), ["adapter", "base", "integrations", "output"]);
  });

  it("adds the caller's integrations after its image integration, as Astro accepts them", () => {
    const tailwind = integration("tailwind");
    const react = integration("react");
    const config = run402({ integrations: [tailwind, [react], false] });
    assert.equal((config.integrations?.[0] as AstroIntegration).name, "@run402/astro");
    assert.deepEqual(config.integrations?.slice(1), [tailwind, [react], false]);

    assert.deepEqual(run402({ images: false, integrations: [tailwind] }).integrations, [tailwind]);
  });

  it("renders on the server unless `output` says otherwise", () => {
    assert.equal(run402().output, "server");
    assert.equal(run402({ output: "static" }).output, "static");
  });
});

describe("run402() and the adapter", () => {
  it("sets the Run402 SSR adapter, and none with `ssr: false`", () => {
    assert.equal((run402().adapter as AstroIntegration).name, "@run402/astro/adapter");
    assert.equal(run402({ ssr: false }).adapter, undefined);
  });

  it("uses an adapter the caller passes in place of its own, and still adds the image integration", () => {
    const node = integration("node-adapter");
    const config = run402({ adapter: node });
    assert.equal(config.adapter, node);
    assert.equal((config.integrations?.[0] as AstroIntegration).name, "@run402/astro");
    assert.equal(run402({ adapter: node, ssr: false }).adapter, node);
  });

  it("refuses an adapter beside `ssr` settings, which only the Run402 adapter reads", () => {
    const node = integration("node-adapter");
    for (const ssr of [true, { memoryMb: 512 }]) {
      assert.throws(
        () => run402({ adapter: node, ssr }),
        (err: unknown) =>
          err instanceof TypeError && /^@run402\/astro: `adapter` replaces the Run402 SSR adapter, which `ssr` configures/.test(err.message),
      );
    }
  });
});

describe("a site built with run402({ base })", () => {
  const FIXTURE = fileURLToPath(new URL("../test/fixtures/endpoint-tools/", import.meta.url));
  let root: string;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "r402-preset-build-"));
    cpSync(path.join(FIXTURE, "src"), path.join(root, "src"), { recursive: true });
    // The fixture's prerendered endpoint fails the build on purpose.
    rmSync(path.join(root, "src", "pages", "feed.json.ts"));
    // The site resolves `astro` from its own node_modules, where Astro and
    // Vite also keep their caches, so the build writes nothing outside `root`.
    mkdirSync(path.join(root, "node_modules"));
    const astroDir = path.dirname(createRequire(import.meta.url).resolve("astro/package.json"));
    symlinkSync(astroDir, path.join(root, "node_modules", "astro"), "dir");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists each endpoint tool at its route with the base applied, and runs the caller's vite plugins", async () => {
    const { build } = await import("astro");
    let vitePluginRan = false;
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      ...run402({
        images: false,
        base: "/app",
        vite: { plugins: [{ name: "preset-test", configResolved: () => void (vitePluginRan = true) }] },
      }),
    });

    const manifest = JSON.parse(readFileSync(path.join(root, "dist", "run402", "adapter.json"), "utf-8")) as {
      tools: Array<{ name: string; method: string; path: string }>;
    };
    assert.deepEqual(
      manifest.tools.map((t) => `${t.name} ${t.method} ${t.path}`),
      ["list_notes GET /app/api/notes", "add_note POST /app/api/notes", "update_note POST /app/api/notes/{note_id}"],
    );
    assert.equal(vitePluginRan, true);
  });
});
