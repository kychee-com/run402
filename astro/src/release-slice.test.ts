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
  // esbuild bundles this; the source must be valid ESM. The Astro
  // server entry in production exports `handler` + `default` — match
  // that shape so the bundled output looks right.
  writeFileSync(
    entryAbs,
    "export const handler = async () => new Response('ok');\nexport default handler;\n",
  );
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

describe("buildAstroReleaseSlice — happy path", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r402-release-slice-build-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("emits site (LocalDirRef), functions (bundled source), and omits routes", async () => {
    const { distDir } = writeFixture(root, {
      output: "server",
      routes: [
        { pattern: "/about", pathname: "/about", prerender: true, type: "page" },
        { pattern: "/[slug]", prerender: false, type: "page" },
      ],
    });

    const slice = await buildAstroReleaseSlice(distDir);

    // site — LocalDirRef pointing at dist/run402/client/
    const siteReplace = (slice.site as { replace: unknown }).replace as {
      __source: string;
      path: string;
    };
    assert.equal(siteReplace.__source, "local-dir");
    assert.match(siteReplace.path, /dist[/\\]run402[/\\]client$/);

    // functions — single ssr function with bundled source (string)
    assert.deepEqual(Object.keys(slice.functions.replace), ["ssr"]);
    const fn = slice.functions.replace.ssr;
    assert.equal(fn.runtime, "node22");
    assert.equal((fn as { class?: string }).class, "ssr");
    assert.deepEqual((fn as { capabilities?: string[] }).capabilities, ["astro.ssr.v1"]);
    assert.equal(
      typeof fn.source,
      "string",
      "functions.replace.ssr.source must be a string (bundled ESM)",
    );
    assert.ok(
      typeof fn.source === "string" && fn.source.includes("handler"),
      "bundled source should reference the entrypoint's `handler` export",
    );
    assert.equal(
      fn.files,
      undefined,
      "v1.2 slice must NOT emit files+entrypoint — the gateway rejects multi-file specs",
    );
    assert.equal(
      fn.entrypoint,
      undefined,
      "v1.2 slice must NOT emit entrypoint — the bundle is self-contained",
    );

    // routes — OMITTED (not `{ replace: [] }`). The gateway's class:'ssr'
    // auto-fallback routes unmatched paths to the ssr function automatically,
    // and prerendered pages resolve via the static manifest's implicit
    // public-paths mode. Omitting `routes` carries forward any base-release
    // routes instead of clearing them, and keeps the slice CI-safe.
    assert.equal(
      slice.routes,
      undefined,
      "slice must omit routes so base routes carry forward and CI sessions aren't rejected",
    );
  });

  it("emits an executable ESM SSR bundle when CommonJS deps require Node builtins", async () => {
    const { distDir, entryAbs } = writeFixture(root, { routes: [] });
    const serverDir = join(distDir, "run402", "server");
    writeFileSync(
      join(serverDir, "needs-util.cjs"),
      "const util = require('util');\nmodule.exports = () => util.format('ok:%s', 'util');\n",
    );
    writeFileSync(
      entryAbs,
      "import message from './needs-util.cjs';\n" +
        "export const handler = async () => new Response(message());\n" +
        "export default handler;\n",
    );

    const slice = await buildAstroReleaseSlice(distDir);
    const source = slice.functions.replace.ssr.source;
    assert.equal(typeof source, "string");

    const bundledPath = join(root, "bundled-ssr.mjs");
    writeFileSync(bundledPath, source);
    const mod = await import(`file://${bundledPath}?t=${Date.now()}`);
    const handler = mod.default as () => Promise<Response>;
    const response = await handler();

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok:util");
  });

  it("functionName option flows through to functions key", async () => {
    const { distDir } = writeFixture(root, { routes: [] });
    const slice = await buildAstroReleaseSlice(distDir, { functionName: "render" });
    assert.deepEqual(Object.keys(slice.functions.replace), ["render"]);
    assert.equal(slice.routes, undefined);
  });

  it("passes requireAuth + requireRole through verbatim onto the ssr function", async () => {
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
});

describe("buildAstroReleaseSlice — explicit cacheClass option", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r402-release-slice-cache-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
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

  it("defaults to public_paths { mode: 'implicit' } so the release opts out of inherited explicit paths", async () => {
    const { distDir } = writeFixture(root, {
      routes: [{ pattern: "/about", pathname: "/about", prerender: true, type: "page" }],
    });
    const slice = await buildAstroReleaseSlice(distDir);
    const publicPaths = (slice.site as { public_paths?: unknown }).public_paths as {
      mode: string;
      replace?: unknown;
    };
    assert.equal(
      publicPaths?.mode,
      "implicit",
      "default mode must be 'implicit' to avoid carry-forward of prior explicit public_paths",
    );
    assert.equal(
      publicPaths.replace,
      undefined,
      "implicit mode must NOT carry a replace map",
    );
  });

  it("normalizes Astro's empty-string root pathname to / in explicit public_paths", async () => {
    const { distDir } = writeFixture(root, {
      routes: [{ pattern: "", pathname: "", prerender: true, type: "page" }],
    });
    const slice = await buildAstroReleaseSlice(distDir, { cacheClass: "html" });
    const publicPaths = (slice.site as { public_paths?: unknown }).public_paths as {
      mode: string;
      replace: Record<string, { asset: string; cache_class?: string }>;
    };
    assert.deepEqual(publicPaths.replace, {
      "/": { asset: "index.html", cache_class: "html" },
    });
  });
});
