import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createRun402Adapter } from "./ssr-adapter.js";

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
