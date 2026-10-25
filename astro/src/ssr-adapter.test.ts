import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { createRun402Adapter, nodeEnvWarning, type Run402SsrFunctionOptions } from "./ssr-adapter.js";

type CapturedAdapter = {
  name?: string;
  entrypointResolution?: unknown;
  serverEntrypoint?: unknown;
  exports?: unknown;
  adapterFeatures?: { buildOutput?: unknown } & Record<string, unknown>;
  supportedAstroFeatures?: Record<string, unknown>;
};

function runConfigDone(integration: ReturnType<typeof createRun402Adapter>): CapturedAdapter {
  const captured: { adapter?: CapturedAdapter } = {};
  const fakeOutDir = new URL("file:///tmp/run402-astro-test/dist/");
  const hook = integration.hooks["astro:config:done"];
  if (!hook) throw new Error("expected astro:config:done hook");
  (hook as (params: unknown) => unknown)({
    setAdapter: (a: CapturedAdapter) => {
      captured.adapter = a;
    },
    config: { outDir: fakeOutDir },
    logger: { info() {}, warn() {}, error() {} },
    setRoutes() {},
  });
  if (!captured.adapter) throw new Error("setAdapter was not called");
  return captured.adapter;
}

describe("createRun402Adapter — Astro 6 shape (kychee-com/run402#403)", () => {
  it("declares entrypointResolution: 'auto'", () => {
    const adapter = runConfigDone(createRun402Adapter());
    assert.equal(
      adapter.entrypointResolution,
      "auto",
      "must opt into Astro 6 auto resolution; explicit is deprecated and prints a warning on every build",
    );
  });

  it("does not pass deprecated `exports` field", () => {
    const adapter = runConfigDone(createRun402Adapter());
    assert.equal(
      adapter.exports,
      undefined,
      "the `exports` array is only used by the deprecated explicit mode; auto mode reads exports from the runtime module directly",
    );
  });

  it("does not force adapterFeatures.buildOutput", () => {
    const adapter = runConfigDone(createRun402Adapter());
    assert.equal(
      adapter.adapterFeatures?.buildOutput,
      undefined,
      "leave buildOutput unset so Astro derives it from output + per-page prerender",
    );
  });

  it("declares sharpImageService so default-sharp users don't get an [ERROR]", () => {
    const adapter = runConfigDone(createRun402Adapter());
    assert.equal(
      adapter.supportedAstroFeatures?.sharpImageService,
      "stable",
      "Astro 6 will print '[config] adapter does not currently support sharp' otherwise",
    );
  });

  it("declares static + server + hybrid output support", () => {
    const adapter = runConfigDone(createRun402Adapter());
    const feats = adapter.supportedAstroFeatures ?? {};
    assert.equal(feats.staticOutput, "stable");
    assert.equal(feats.serverOutput, "stable");
    assert.equal(feats.hybridOutput, "stable");
  });

  it("points serverEntrypoint at an installed runtime file", () => {
    const adapter = runConfigDone(createRun402Adapter());
    assert.equal(typeof adapter.serverEntrypoint, "string");
    assert.equal(path.isAbsolute(adapter.serverEntrypoint as string), true);
    assert.match(adapter.serverEntrypoint as string, /runtime\/server\.js$/);
  });
});

type ManifestRoutes = Array<{ pattern: string; prerender: boolean; pathname?: string; type?: string }>;

async function buildAdapterJson(opts: {
  resolvedRoutes?: unknown[];
  pages: Array<{ pathname: string }>;
  routes?: unknown[];
}): Promise<ManifestRoutes> {
  const root = mkdtempSync(path.join(tmpdir(), "r402-adapter-routes-"));
  try {
    const integration = createRun402Adapter();
    const hooks = integration.hooks as Record<string, ((params: unknown) => unknown) | undefined>;
    await hooks["astro:config:done"]!({
      setAdapter() {},
      config: { outDir: pathToFileURL(root + "/") },
      logger: { info() {}, warn() {}, error() {} },
    });
    if (opts.resolvedRoutes) {
      await hooks["astro:routes:resolved"]!({ routes: opts.resolvedRoutes, logger: {} });
    }
    await hooks["astro:build:done"]!({ pages: opts.pages, routes: opts.routes, logger: { warn() {} } });
    const manifest = JSON.parse(readFileSync(path.join(root, "run402", "adapter.json"), "utf-8"));
    return manifest.routes as ManifestRoutes;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("createRun402Adapter — adapter.json routes", () => {
  it("records SSR routes from astro:routes:resolved (Astro 5+ no longer passes routes to build:done)", async () => {
    const routes = await buildAdapterJson({
      resolvedRoutes: [
        { pattern: "/", isPrerendered: false, pathname: "/", type: "page", origin: "project" },
        { pattern: "/notes/[id]", isPrerendered: false, type: "page", origin: "project" },
        { pattern: "/api/notes", isPrerendered: false, pathname: "/api/notes", type: "endpoint", origin: "project" },
        { pattern: "/_image", isPrerendered: false, pathname: "/_image", type: "endpoint", origin: "internal" },
        { pattern: "/old", isPrerendered: false, pathname: "/old", type: "redirect", origin: "project" },
      ],
      pages: [],
    });
    assert.deepEqual(routes, [
      { pattern: "/", prerender: false, type: "page" },
      { pattern: "/notes/[id]", prerender: false, type: "page" },
      { pattern: "/api/notes", prerender: false, type: "endpoint" },
    ]);
  });

  it("hybrid: prerendered entries come from pages[] (incl. dynamic getStaticPaths), typed by their resolved route", async () => {
    const routes = await buildAdapterJson({
      resolvedRoutes: [
        { pattern: "/", isPrerendered: false, pathname: "/", type: "page", origin: "project" },
        { pattern: "/about", isPrerendered: true, pathname: "/about", type: "page", origin: "project" },
        { pattern: "/blog/[slug]", isPrerendered: true, type: "page", origin: "project" },
        { pattern: "/rss.xml", isPrerendered: true, pathname: "/rss.xml", type: "endpoint", origin: "project" },
      ],
      pages: [{ pathname: "about/" }, { pathname: "blog/first/" }, { pathname: "rss.xml" }],
    });
    assert.deepEqual(routes, [
      { pattern: "/", prerender: false, type: "page" },
      { pattern: "/about", prerender: true, pathname: "about/", type: "page" },
      { pattern: "blog/first/", prerender: true, pathname: "blog/first/", type: "page" },
      { pattern: "/rss.xml", prerender: true, pathname: "rss.xml", type: "endpoint" },
    ]);
  });

  it("hybrid: keeps a prerendered endpoint that Astro 7 leaves out of pages[]", async () => {
    const routes = await buildAdapterJson({
      resolvedRoutes: [
        { pattern: "/about", isPrerendered: true, pathname: "/about", type: "page", origin: "project" },
        { pattern: "/rss.xml", isPrerendered: true, pathname: "/rss.xml", type: "endpoint", origin: "project" },
      ],
      pages: [{ pathname: "about/" }],
    });
    assert.deepEqual(routes, [
      { pattern: "/about", prerender: true, pathname: "about/", type: "page" },
      { pattern: "/rss.xml", prerender: true, pathname: "/rss.xml", type: "endpoint" },
    ]);
  });

  it("falls back to build:done routes (Astro 4) when routes:resolved never fired", async () => {
    const routes = await buildAdapterJson({
      routes: [
        { route: "/about", pathname: "/about", prerender: true, type: "page" },
        { route: "/[slug]", prerender: false, type: "page" },
      ],
      pages: [{ pathname: "about/" }],
    });
    assert.deepEqual(routes, [
      { pattern: "/about", prerender: true, pathname: "/about", type: "page" },
      { pattern: "/[slug]", prerender: false, type: "page" },
    ]);
  });

  it("falls back to pages[] when neither routes source is available", async () => {
    const routes = await buildAdapterJson({ pages: [{ pathname: "about/" }] });
    assert.deepEqual(routes, [{ pattern: "about/", prerender: true, pathname: "about/", type: "page" }]);
  });
});

describe("createRun402Adapter — adapter.json nodeEnv (kychee-com/run402-private#838)", () => {
  async function buildManifestUnder(nodeEnv: string | undefined): Promise<Record<string, unknown>> {
    const root = mkdtempSync(path.join(tmpdir(), "r402-adapter-nodeenv-"));
    const saved = process.env.NODE_ENV;
    try {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      const integration = createRun402Adapter();
      const hooks = integration.hooks as Record<string, ((params: unknown) => unknown) | undefined>;
      await hooks["astro:config:done"]!({
        setAdapter() {},
        config: { outDir: pathToFileURL(root + "/") },
        logger: { info() {}, warn() {}, error() {} },
      });
      await hooks["astro:build:done"]!({ pages: [], logger: { warn() {} } });
      return JSON.parse(readFileSync(path.join(root, "run402", "adapter.json"), "utf-8"));
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("records the NODE_ENV the build ran under", async () => {
    assert.equal((await buildManifestUnder("production")).nodeEnv, "production");
    assert.equal((await buildManifestUnder("development")).nodeEnv, "development");
  });

  it("omits nodeEnv when the build had none", async () => {
    assert.equal("nodeEnv" in (await buildManifestUnder(undefined)), false);
  });

  it("warns only for a build that is not production", () => {
    assert.equal(nodeEnvWarning("production"), null);
    assert.equal(nodeEnvWarning(undefined), null);
    assert.match(nodeEnvWarning("development") ?? "", /NODE_ENV is "development"/);
  });
});

describe("createRun402Adapter — adapter.json ssr function settings", () => {
  async function buildManifestWith(ssr: Run402SsrFunctionOptions | undefined): Promise<Record<string, unknown>> {
    const root = mkdtempSync(path.join(tmpdir(), "r402-adapter-ssr-"));
    try {
      const integration = createRun402Adapter(ssr === undefined ? {} : { ssr });
      const hooks = integration.hooks as Record<string, ((params: unknown) => unknown) | undefined>;
      await hooks["astro:config:done"]!({
        setAdapter() {},
        config: { outDir: pathToFileURL(root + "/") },
        logger: { info() {}, warn() {}, error() {} },
      });
      await hooks["astro:build:done"]!({ pages: [], logger: { warn() {} } });
      return JSON.parse(readFileSync(path.join(root, "run402", "adapter.json"), "utf-8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("records memoryMb and timeoutSeconds", async () => {
    const manifest = await buildManifestWith({ memoryMb: 1769, timeoutSeconds: 30 });
    assert.deepEqual(manifest.ssr, { memoryMb: 1769, timeoutSeconds: 30 });
  });

  it("omits ssr when nothing is set", async () => {
    assert.equal("ssr" in (await buildManifestWith(undefined)), false);
    assert.equal("ssr" in (await buildManifestWith({})), false);
  });

  it("refuses a value that is not a whole number in Lambda's range, naming the field", () => {
    assert.throws(() => createRun402Adapter({ ssr: { memoryMb: 100 } }), /ssr\.memoryMb.*128 to 10240.*got 100/);
    assert.throws(() => createRun402Adapter({ ssr: { memoryMb: 1024.5 } }), /ssr\.memoryMb/);
    assert.throws(() => createRun402Adapter({ ssr: { timeoutSeconds: 0 } }), /ssr\.timeoutSeconds.*1 to 900/);
    assert.throws(
      () => createRun402Adapter({ ssr: { memory: 1024 } as unknown as { memoryMb: number } }),
      /unknown `ssr\.memory`/,
    );
  });
});
