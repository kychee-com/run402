/**
 * Snapshot-style tests for the HTML emission of the <Image> component.
 *
 * The .astro file is a thin wrapper around `buildPictureHtml` — we test the
 * pure function directly so the assertions don't depend on Astro's compiler.
 * The .astro file's contract is exercised in test/fixtures/minimal-site/
 * which runs against a real Astro build (separately, not as a unit test).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPictureHtml } from "./picture-builder.js";
import type { AssetRef, ImageProps } from "./types.js";

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

const heicRef: AssetRef = {
  ...jpegRef,
  key: "astro/photo.heic",
  content_type: "image/heic",
  url: "https://example.com/photo.heic",
  cdn_url: "https://cdn.example.com/photo.heic",
  display_url: "https://cdn.example.com/photo-display.jpg",
  variants: {
    thumb: webpVariant(320, 240),
    medium: webpVariant(800, 600),
    large: webpVariant(1920, 1440),
    display_jpeg: {
      url: "https://example.com/photo-display.jpg",
      cdn_url: "https://cdn.example.com/photo-display.jpg",
      width_px: 1600,
      height_px: 1200,
      format: "jpeg",
      sha256: "b".repeat(64),
    },
  },
};

const subSmallRef: AssetRef = {
  key: "astro/icon.png",
  sha256: "c".repeat(64),
  size_bytes: 1234,
  content_type: "image/png",
  url: "https://example.com/icon.png",
  cdn_url: "https://cdn.example.com/icon.png",
  width_px: 200,
  height_px: 200,
  blurhash: "L0xx",
  variant_spec_version: "v1",
  display_url: "https://cdn.example.com/icon.png",
  // No variants — sub-320 falls back to single <img>.
};

const baseProps: ImageProps = { src: "./hero.jpg", alt: "test alt" };

describe("buildPictureHtml", () => {
  it("emits <picture> with WebP source ladder for a JPEG asset", () => {
    const { html, warnings } = buildPictureHtml({ ref: jpegRef, props: baseProps });
    assert.equal(warnings.length, 0);
    assert.match(html, /^<picture>/);
    assert.match(html, /<source type="image\/webp" srcset="/);
    assert.match(html, /v320\.webp 320w/);
    assert.match(html, /v800\.webp 800w/);
    assert.match(html, /v1920\.webp 1920w/);
    assert.match(html, /sizes="100vw"/);
    assert.match(html, /<img src="https:\/\/cdn\.example\.com\/hero\.jpg"/);
    assert.match(html, /width="1600"/);
    assert.match(html, /height="1200"/);
    assert.match(html, /loading="lazy"/);
    assert.match(html, /alt="test alt"/);
  });

  it("HEIC source: <img> fallback uses display_jpeg.cdn_url, NOT raw HEIC url", () => {
    const { html } = buildPictureHtml({ ref: heicRef, props: { ...baseProps, src: "./photo.heic" } });
    assert.match(html, /<img src="https:\/\/cdn\.example\.com\/photo-display\.jpg"/);
    assert.doesNotMatch(html, /photo\.heic"/);
    // WebP ladder still present
    assert.match(html, /<source type="image\/webp"/);
  });

  it("sub-320 source: single <img> with warning", () => {
    const { html, warnings } = buildPictureHtml({ ref: subSmallRef, props: baseProps });
    assert.doesNotMatch(html, /<picture>/);
    assert.match(html, /^<img/);
    assert.match(html, /width="200"/);
    assert.match(html, /height="200"/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /below the 320-pixel/);
  });

  it("priority opt-in emits fetchpriority=high + loading=eager", () => {
    const { html } = buildPictureHtml({ ref: jpegRef, props: { ...baseProps, priority: true } });
    assert.match(html, /loading="eager"/);
    assert.match(html, /fetchpriority="high"/);
  });

  it("loading=eager without priority emits eager but no fetchpriority", () => {
    const { html } = buildPictureHtml({ ref: jpegRef, props: { ...baseProps, loading: "eager" } });
    assert.match(html, /loading="eager"/);
    assert.doesNotMatch(html, /fetchpriority/);
  });

  it("placeholder=none omits style", () => {
    const { html } = buildPictureHtml({
      ref: jpegRef,
      props: { ...baseProps, placeholder: "none" },
    });
    assert.doesNotMatch(html, /background-image/);
    assert.doesNotMatch(html, /background-color/);
  });

  it("placeholder=color emits background-color", () => {
    const { html } = buildPictureHtml({
      ref: jpegRef,
      props: { ...baseProps, placeholder: "color" },
    });
    assert.match(html, /background-color:#[0-9a-fA-F]{6}/);
    assert.doesNotMatch(html, /background-image/);
  });

  it("default placeholder emits background-image data URI", () => {
    const { html } = buildPictureHtml({ ref: jpegRef, props: baseProps });
    assert.match(html, /background-image:url\(data:image\/png;base64,/);
  });

  it("class prop passes through to the <img>", () => {
    const { html } = buildPictureHtml({
      ref: jpegRef,
      props: { ...baseProps, class: "hero-image lg:w-full" },
    });
    assert.match(html, /class="hero-image lg:w-full"/);
  });

  it("width override warns and recomputes height", () => {
    const { html, warnings } = buildPictureHtml({
      ref: jpegRef,
      props: { ...baseProps, width: 800 },
    });
    assert.match(html, /width="800"/);
    // 800 × (1200/1600) = 600
    assert.match(html, /height="600"/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /width override/);
  });

  it("height override warns and recomputes width", () => {
    const { html, warnings } = buildPictureHtml({
      ref: jpegRef,
      props: { ...baseProps, height: 600 },
    });
    assert.match(html, /height="600"/);
    // 600 × (1600/1200) = 800
    assert.match(html, /width="800"/);
    assert.match(warnings[0]!, /height override/);
  });

  it("escapes alt text properly", () => {
    const { html } = buildPictureHtml({
      ref: jpegRef,
      props: { ...baseProps, alt: 'A "tricky" <one>' },
    });
    assert.match(html, /alt="A &quot;tricky&quot; &lt;one&gt;"/);
  });

  it("uses custom sizes prop", () => {
    const { html } = buildPictureHtml({
      ref: jpegRef,
      props: { ...baseProps, sizes: "(min-width: 768px) 50vw, 100vw" },
    });
    assert.match(html, /sizes="\(min-width: 768px\) 50vw, 100vw"/);
  });

  it("pictureAttrs splices data-* attrs onto the <picture> element", () => {
    const { html } = buildPictureHtml({
      ref: jpegRef,
      props: {
        ...baseProps,
        pictureAttrs: { "data-hero-picture": "", "data-hero-aspect": "21/9" },
      },
    });
    assert.match(html, /^<picture data-hero-picture="" data-hero-aspect="21\/9">/);
    // None of the inner elements should pick up the attrs.
    assert.doesNotMatch(html, /<source[^>]*data-hero/);
    assert.doesNotMatch(html, /<img[^>]*data-hero/);
  });

  it("pictureAttrs values are HTML-attribute-escaped", () => {
    const { html } = buildPictureHtml({
      ref: jpegRef,
      props: { ...baseProps, pictureAttrs: { "data-meta": 'A "tricky" <value>' } },
    });
    assert.match(html, /data-meta="A &quot;tricky&quot; &lt;value&gt;"/);
  });

  it("pictureAttrs silently drops keys outside the safe HTML attribute pattern", () => {
    const { html } = buildPictureHtml({
      ref: jpegRef,
      props: {
        ...baseProps,
        pictureAttrs: {
          // Valid — kept.
          "data-keep": "yes",
          // Invalid — would let a value break out of the tag.
          "evil onclick": "alert(1)",
          'evil"': "x",
          "1leading-digit": "x",
        },
      },
    });
    assert.match(html, /<picture data-keep="yes">/);
    assert.doesNotMatch(html, /onclick/);
    assert.doesNotMatch(html, /alert/);
    assert.doesNotMatch(html, /leading-digit/);
  });

  it("pictureAttrs lands on the <img> when the source falls back (sub-320)", () => {
    const { html } = buildPictureHtml({
      ref: subSmallRef,
      props: { ...baseProps, pictureAttrs: { "data-hero-picture": "" } },
    });
    // No <picture> wrapper in the fallback path — attrs go on the <img>.
    assert.doesNotMatch(html, /<picture/);
    assert.match(html, /^<img/);
    assert.match(html, /data-hero-picture=""/);
  });
});
