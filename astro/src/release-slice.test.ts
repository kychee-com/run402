import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  buildAstroReleaseSlice,
  loadAstroAdapterManifest,
  Run402AstroAdapterManifestError,
} from "./release-slice.js";
import type { Run402AdapterManifest } from "./ssr-adapter.js";

function writeFixture(
  root: string,
  manifest: Partial<Run402AdapterManifest> | string | null,
): { distDir: string; entryAbs: string } {
  const distDir = join(root, "dist");
  const serverDir = join(distDir, "run402", "server");
  const clientDir = join(distDir, "run402", "client");
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(clientDir, { recursive: true });
  const entryAbs = join(serverDir, "entry.mjs");
  writeFileSync(entryAbs, "export const handler = async () => new Response('ok');\n");
  writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>home</title>");

  if (manifest !== null) {
    const adapterPath = join(distDir, "run402", "adapter.json");
    const body =
      typeof manifest === "string"
        ? manifest
        : JSON.stringify({
            version: "1.0",
            astroVersion: "6.1.3",
            output: "server",
            serverEntrypoint: entryAbs,
            clientDir,
            routes: [],
            features: { middleware: true, serverIslands: false, sessions: false, mdx: true },
            ...manifest,
          });
    writeFileSync(adapterPath, body);
  }

  return { distDir, entryAbs };
}

describe("loadAstroAdapterManifest", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r402-release-slice-load-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns parsed manifest on the happy path", async () => {
    const { distDir, entryAbs } = writeFixture(root, {});
    const m = await loadAstroAdapterManifest(distDir);
    assert.equal(m.version, "1.0");
    assert.equal(m.serverEntrypoint, entryAbs);
    assert.equal(m.output, "server");
  });

  it("throws R402_ASTRO_ADAPTER_MANIFEST_MISSING when adapter.json is absent", async () => {
    const { distDir } = writeFixture(root, null);
    await assert.rejects(
      () => loadAstroAdapterManifest(distDir),
      (err: unknown) => {
        assert.ok(err instanceof Run402AstroAdapterManifestError);
        assert.equal(err.code, "R402_ASTRO_ADAPTER_MANIFEST_MISSING");
        assert.match(err.file, /dist[/\\]run402[/\\]adapter\.json$/);
        assert.equal(
          err.docs,
          "https://docs.run402.com/errors#R402_ASTRO_ADAPTER_MANIFEST_MISSING",
        );
        assert.ok(typeof err.suggestedFix === "string" && err.suggestedFix.length > 0);
        return true;
      },
    );
  });

  it("throws R402_ASTRO_ADAPTER_MANIFEST_MISSING when adapter.json is not valid JSON", async () => {
    const { distDir } = writeFixture(root, "this { is not json");
    await assert.rejects(
      () => loadAstroAdapterManifest(distDir),
      (err: unknown) => {
        assert.ok(err instanceof Run402AstroAdapterManifestError);
        assert.equal(err.code, "R402_ASTRO_ADAPTER_MANIFEST_MISSING");
        return true;
      },
    );
  });

  it("throws R402_ASTRO_ADAPTER_MANIFEST_MISSING when adapter.json is not an object", async () => {
    const { distDir } = writeFixture(root, "[1,2,3]");
    await assert.rejects(
      () => loadAstroAdapterManifest(distDir),
      (err: unknown) => {
        assert.ok(err instanceof Run402AstroAdapterManifestError);
        assert.equal(err.code, "R402_ASTRO_ADAPTER_MANIFEST_MISSING");
        return true;
      },
    );
  });

  it("throws R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED when version is outside the supported set", async () => {
    const { distDir } = writeFixture(root, { version: "2.0" } as unknown as Partial<Run402AdapterManifest>);
    await assert.rejects(
      () => loadAstroAdapterManifest(distDir),
      (err: unknown) => {
        assert.ok(err instanceof Run402AstroAdapterManifestError);
        assert.equal(err.code, "R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED");
        assert.equal(err.observedVersion, "2.0");
        assert.equal(
          err.docs,
          "https://docs.run402.com/errors#R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED",
        );
        return true;
      },
    );
  });
});

describe("buildAstroReleaseSlice — happy path + prerender truth", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r402-release-slice-build-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns site/functions/routes from a hybrid build", async () => {
    const { distDir } = writeFixture(root, {
      output: "server",
      routes: [
        { pattern: "/about", pathname: "/about", prerender: true, type: "page" },
        { pattern: "/[slug]", prerender: false, type: "page" },
      ],
    });

    const slice = await buildAstroReleaseSlice(distDir);

    // site
    const siteReplace = (slice.site as { replace: unknown }).replace as {
      __source: string;
      path: string;
    };
    assert.equal(siteReplace.__source, "local-dir");
    assert.match(siteReplace.path, /dist[/\\]run402[/\\]client$/);

    // functions
    assert.deepEqual(Object.keys(slice.functions.replace), ["ssr"]);
    const fn = slice.functions.replace.ssr;
    assert.equal(fn.runtime, "node22");
    assert.equal((fn as { class?: string }).class, "ssr");
    assert.equal(fn.entrypoint, "entry.mjs");
    assert.ok(
      fn.files && typeof fn.files === "object",
      "functions.replace.ssr.files must be a FileSet",
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(fn.files, "entry.mjs"),
      "FileSet must contain the entry.mjs key",
    );

    // routes — prerendered /about gets a static alias, /[slug] falls through
    // to the catchall (no per-route entry), then catchall last. Static aliases
    // are constrained to GET/HEAD per the SDK's static-route validator.
    assert.deepEqual(slice.routes.replace, [
      {
        pattern: "/about",
        methods: ["GET", "HEAD"],
        target: { type: "static", file: "about/index.html" },
      },
      { pattern: "/*", target: { type: "function", name: "ssr" } },
    ]);
  });

  it("maps / → index.html and routes ending in .html keep the extension", async () => {
    const { distDir } = writeFixture(root, {
      routes: [
        { pattern: "/", pathname: "/", prerender: true, type: "page" },
        { pattern: "/sitemap.xml", pathname: "/sitemap.xml", prerender: true, type: "endpoint" },
        { pattern: "/legacy.html", pathname: "/legacy.html", prerender: true, type: "page" },
      ],
    });

    const slice = await buildAstroReleaseSlice(distDir);
    const aliases = slice.routes.replace.filter((r) => r.target.type === "static");
    assert.deepEqual(aliases, [
      { pattern: "/", methods: ["GET", "HEAD"], target: { type: "static", file: "index.html" } },
      {
        pattern: "/sitemap.xml",
        methods: ["GET", "HEAD"],
        target: { type: "static", file: "sitemap.xml/index.html" },
      },
      {
        pattern: "/legacy.html",
        methods: ["GET", "HEAD"],
        target: { type: "static", file: "legacy.html" },
      },
    ]);
  });

  it("skips redirect and fallback route types", async () => {
    const { distDir } = writeFixture(root, {
      routes: [
        { pattern: "/old", prerender: true, type: "redirect" },
        { pattern: "/404", prerender: true, type: "fallback" },
        { pattern: "/keep", pathname: "/keep", prerender: true, type: "page" },
      ],
    });
    const slice = await buildAstroReleaseSlice(distDir);
    const aliases = slice.routes.replace.filter((r) => r.target.type === "static");
    assert.deepEqual(aliases, [
      {
        pattern: "/keep",
        methods: ["GET", "HEAD"],
        target: { type: "static", file: "keep/index.html" },
      },
    ]);
  });
});

describe("buildAstroReleaseSlice — option surface", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r402-release-slice-opts-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("respects functionName override across functions + routes", async () => {
    const { distDir } = writeFixture(root, { routes: [] });
    const slice = await buildAstroReleaseSlice(distDir, { functionName: "render" });
    assert.deepEqual(Object.keys(slice.functions.replace), ["render"]);
    assert.deepEqual(slice.routes.replace, [
      { pattern: "/*", target: { type: "function", name: "render" } },
    ]);
  });

  it("passes requireAuth + requireRole through verbatim", async () => {
    const { distDir } = writeFixture(root, { routes: [] });
    const slice = await buildAstroReleaseSlice(distDir, {
      requireAuth: true,
      requireRole: {
        table: "users",
        idColumn: "id",
        roleColumn: "role",
        allowed: ["admin", "editor"],
        cacheTtl: 30,
      },
    });
    const fn = slice.functions.replace.ssr;
    assert.equal(fn.requireAuth, true);
    assert.deepEqual(fn.requireRole, {
      table: "users",
      idColumn: "id",
      roleColumn: "role",
      allowed: ["admin", "editor"],
      cacheTtl: 30,
    });
  });

  it("emits explicit public_paths for prerendered routes when cacheClass is set", async () => {
    const { distDir } = writeFixture(root, {
      routes: [
        { pattern: "/about", pathname: "/about", prerender: true, type: "page" },
        { pattern: "/[slug]", prerender: false, type: "page" },
      ],
    });
    const slice = await buildAstroReleaseSlice(distDir, { cacheClass: "revalidating_asset" });
    const publicPaths = (slice.site as { public_paths?: unknown }).public_paths as {
      mode: string;
      replace: Record<string, { asset: string; cache_class?: string }>;
    };
    assert.equal(publicPaths.mode, "explicit");
    assert.deepEqual(publicPaths.replace, {
      "/about": { asset: "about/index.html", cache_class: "revalidating_asset" },
    });
  });

  it("does not emit public_paths when cacheClass is not provided", async () => {
    const { distDir } = writeFixture(root, {
      routes: [{ pattern: "/about", pathname: "/about", prerender: true, type: "page" }],
    });
    const slice = await buildAstroReleaseSlice(distDir);
    assert.equal(
      (slice.site as { public_paths?: unknown }).public_paths,
      undefined,
      "public_paths must remain implicit unless the caller asked for cacheClass overrides",
    );
  });
});
