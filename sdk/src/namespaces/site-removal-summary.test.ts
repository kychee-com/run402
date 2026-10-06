import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isContentHashedPath,
  summarizeSiteRemoval,
  withSiteRemovalSummaries,
} from "./site-removal-summary.js";
import type { WarningEntry } from "./deploy.types.js";

describe("isContentHashedPath", () => {
  it("recognizes bundler content hashes", () => {
    for (const path of [
      "_astro/Foo.Ds5BwtTY.js",
      "_astro/index.CzEebLVq.css",
      "assets/index-a3f9c2e1.js",
      "/_next/static/chunks/main.0123abcd4567.js",
      "static/js/main.8f2c1a9b.chunk.js",
    ]) {
      assert.equal(isContentHashedPath(path), true, path);
    }
  });

  it("does not mistake plain names for hashes", () => {
    for (const path of [
      "index.html",
      "about/index.html",
      "js/my-component.js",
      "css/user-profile.min.css",
      "images/logo.png",
      "robots.txt",
      ".well-known/security.txt",
      "_astro/page.Ds5BwtTY.html",
    ]) {
      assert.equal(isContentHashedPath(path), false, path);
    }
  });
});

describe("summarizeSiteRemoval", () => {
  it("flags a removal made only of renamed bundles", () => {
    const summary = summarizeSiteRemoval(["_astro/Foo.Ds5BwtTY.js", "_astro/Bar.BT3mQ2xa.css"]);
    assert.equal(summary.total, 2);
    assert.equal(summary.content_hashed_build_assets, 2);
    assert.equal(summary.pages, 0);
    assert.equal(summary.only_content_hashed_build_assets, true);
    assert.deepEqual(summary.by_top_level_dir, { _astro: 2 });
    assert.equal(summary.confidence, "heuristic");
  });

  it("separates pages and other files from hashed bundles", () => {
    const summary = summarizeSiteRemoval([
      "events/index.html",
      "/about.html",
      "_astro/Foo.Ds5BwtTY.js",
      "images/old-banner.png",
    ]);
    assert.equal(summary.pages, 2);
    assert.deepEqual(summary.page_paths, ["events/index.html", "/about.html"]);
    assert.equal(summary.content_hashed_build_assets, 1);
    assert.equal(summary.other, 1);
    assert.deepEqual(summary.other_paths, ["images/old-banner.png"]);
    assert.equal(summary.only_content_hashed_build_assets, false);
    assert.deepEqual(summary.by_top_level_dir, { events: 1, ".": 1, _astro: 1, images: 1 });
  });

  it("caps the page sample at 20", () => {
    const summary = summarizeSiteRemoval(Array.from({ length: 25 }, (_, i) => `p${i}.html`));
    assert.equal(summary.pages, 25);
    assert.equal(summary.page_paths.length, 20);
  });
});

describe("withSiteRemovalSummaries", () => {
  const bulk: WarningEntry = {
    code: "DESTRUCTIVE_SITE_BULK_REMOVAL",
    severity: "high",
    requires_confirmation: true,
    message: "This plan removes more than ten percent of current site paths.",
    affected: ["_astro/Foo.Ds5BwtTY.js"],
  };

  it("adds removed_paths_summary to bulk-removal warnings", () => {
    const [out] = withSiteRemovalSummaries([bulk]);
    const summary = out!.details?.removed_paths_summary as { only_content_hashed_build_assets: boolean };
    assert.equal(summary.only_content_hashed_build_assets, true);
    assert.equal(out!.requires_confirmation, true, "never changes whether the warning blocks");
  });

  it("omits by_top_level_dir when the gateway sends counted_removed_by_dir", () => {
    const gatewayShaped = {
      ...bulk,
      details: { base_paths: 120, removed: 34, replaced_fingerprinted: 33, counted_removed: 1, threshold: 0.1, counted_removed_by_dir: { _astro: 1 } },
    };
    const [out] = withSiteRemovalSummaries([gatewayShaped]);
    const summary = out!.details?.removed_paths_summary as Record<string, unknown>;
    assert.equal(summary.total, 1);
    assert.equal("by_top_level_dir" in summary, false);
    assert.deepEqual(out!.details?.counted_removed_by_dir, { _astro: 1 }, "gateway details kept");
  });

  it("keeps a gateway-supplied summary and other warnings untouched", () => {
    const gatewaySummary = { ...bulk, details: { removed_paths_summary: { total: 1 } } };
    const other: WarningEntry = { code: "DESTRUCTIVE_FUNCTION_REMOVAL", severity: "high", requires_confirmation: true, message: "x", affected: ["api"] };
    const input = [gatewaySummary, other];
    assert.equal(withSiteRemovalSummaries(input), input);
  });
});
