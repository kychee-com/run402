import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssetManifest } from "./manifest.js";
import { renderPicture, resolveVariants } from "./manifest.js";
import type { AssetRef } from "./types.js";

const webpVariant = (width: number, height: number) => ({
  url: `https://example.com/v${width}.webp`,
  cdn_url: `https://cdn.example.com/v${width}.webp`,
  width_px: width,
  height_px: height,
  format: "webp" as const,
  sha256: `${width}`.padEnd(64, "0"),
});

const jpegRef: AssetRef = {
  key: "astro/hero.jpg",
  sha256: "a".repeat(64),
  size_bytes: 100000,
  content_type: "image/jpeg",
  url: "https://example.com/hero.jpg",
  cdn_url: "https://cdn.example.com/hero.jpg",
  width_px: 1600,
  height_px: 1200,
  blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
  variant_spec_version: "v1",
  display_url: "https://cdn.example.com/hero.jpg",
  variants: {
    thumb: webpVariant(320, 240),
    medium: webpVariant(800, 600),
    large: webpVariant(1920, 1440),
  },
};

const manifest: AssetManifest = {
  version: 1,
  project_id: "prj_test",
  asset_prefix: "astro/",
  generated_at: "2026-05-20T13:30:00.000Z",
  assets: {
    "hero.jpg": jpegRef,
    "nested/photo.jpg": jpegRef,
  },
};

describe("resolveVariants", () => {
  it("returns AssetRef for known keys", () => {
    const got = resolveVariants(manifest, "hero.jpg");
    assert.ok(got);
    assert.equal(got.cdn_url, "https://cdn.example.com/hero.jpg");
  });

  it("returns AssetRef for nested keys (path-separator preserved)", () => {
    const got = resolveVariants(manifest, "nested/photo.jpg");
    assert.ok(got);
  });

  it("returns null for unknown keys", () => {
    assert.equal(resolveVariants(manifest, "missing.jpg"), null);
  });

  it("returns null for unknown manifest versions (forward-compat)", () => {
    const future = { ...manifest, version: 2 } as unknown as AssetManifest;
    assert.equal(resolveVariants(future, "hero.jpg"), null);
  });

  it("returns null for missing/empty/null manifest", () => {
    assert.equal(resolveVariants(undefined as unknown as AssetManifest, "k"), null);
    assert.equal(resolveVariants(null as unknown as AssetManifest, "k"), null);
    assert.equal(
      resolveVariants({ version: 1, project_id: "p", asset_prefix: "a", generated_at: "t", assets: {} }, "k"),
      null,
    );
  });
});

describe("renderPicture", () => {
  it("emits the same shape as the <Image> component", () => {
    const html = renderPicture(jpegRef, { alt: "test alt", sizes: "100vw" });
    assert.match(html, /^<picture>/);
    assert.match(html, /<source type="image\/webp" srcset="/);
    assert.match(html, /v320\.webp 320w/);
    assert.match(html, /v800\.webp 800w/);
    assert.match(html, /v1920\.webp 1920w/);
    assert.match(html, /<img src="https:\/\/cdn\.example\.com\/hero\.jpg"/);
    assert.match(html, /alt="test alt"/);
    assert.match(html, /width="1600"/);
    assert.match(html, /height="1200"/);
    assert.match(html, /loading="lazy"/);
  });

  it("honors priority + class + placeholder=none options", () => {
    const html = renderPicture(jpegRef, {
      alt: "hero",
      priority: true,
      class: "hero-img",
      placeholder: "none",
    });
    assert.match(html, /loading="eager"/);
    assert.match(html, /fetchpriority="high"/);
    assert.match(html, /class="hero-img"/);
    assert.doesNotMatch(html, /background-image/);
  });

  it("threads pictureAttrs through to the <picture> wrapper", () => {
    const html = renderPicture(jpegRef, {
      alt: "hero",
      pictureAttrs: { "data-hero-picture": "", "data-hero-aspect": "21/9" },
    });
    assert.match(html, /^<picture data-hero-picture="" data-hero-aspect="21\/9">/);
  });
});
