import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LeadingSlashSrcError, SourceNotFoundError, UnsupportedExtensionError } from "./errors.js";
import { extensionOf, loadAliasConfig, resolveImageSrc } from "./resolver.js";

describe("resolver", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r402-resolver-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves relative ./ paths against the importing file", () => {
    mkdirSync(join(root, "src", "pages"), { recursive: true });
    mkdirSync(join(root, "src", "images"), { recursive: true });
    writeFileSync(join(root, "src", "images", "hero.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const importing = join(root, "src", "pages", "index.astro");
    const resolved = resolveImageSrc("../images/hero.jpg", importing, null);
    assert.equal(resolved, join(root, "src", "images", "hero.jpg"));
  });

  it("resolves ./ paths in same directory", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const importing = join(root, "src", "page.astro");
    const resolved = resolveImageSrc("./logo.png", importing, null);
    assert.equal(resolved, join(root, "src", "logo.png"));
  });

  it("throws LeadingSlashSrcError for /-rooted paths", () => {
    const importing = join(root, "src", "index.astro");
    assert.throws(
      () => resolveImageSrc("/images/hero.jpg", importing, null),
      (err) => err instanceof LeadingSlashSrcError && err.code === "RUN402_ASTRO_LEADING_SLASH_SRC",
    );
  });

  it("throws UnsupportedExtensionError for non-image extensions", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const importing = join(root, "src", "page.astro");
    assert.throws(
      () => resolveImageSrc("./doc.pdf", importing, null),
      (err) =>
        err instanceof UnsupportedExtensionError &&
        err.code === "RUN402_ASTRO_UNSUPPORTED_EXTENSION" &&
        err.ext === ".pdf",
    );
  });

  it("throws SourceNotFoundError when the resolved path does not exist", () => {
    const importing = join(root, "src", "page.astro");
    assert.throws(
      () => resolveImageSrc("./missing.jpg", importing, null),
      (err) => err instanceof SourceNotFoundError && err.code === "RUN402_ASTRO_SOURCE_NOT_FOUND",
    );
  });

  it("resolves tsconfig path aliases (@/*)", () => {
    mkdirSync(join(root, "src", "images"), { recursive: true });
    writeFileSync(join(root, "src", "images", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["./src/*"] },
        },
      }),
    );
    const aliases = loadAliasConfig(root);
    assert.ok(aliases, "expected aliases to be loaded");
    const importing = join(root, "src", "pages", "index.astro");
    const resolved = resolveImageSrc("@/images/logo.png", importing, aliases);
    assert.equal(resolved, join(root, "src", "images", "logo.png"));
  });

  it("loadAliasConfig returns null when no tsconfig.json present", () => {
    assert.equal(loadAliasConfig(root), null);
  });

  it("loadAliasConfig handles JSONC comments + trailing commas", () => {
    mkdirSync(join(root, "src", "images"), { recursive: true });
    writeFileSync(join(root, "src", "images", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(
      join(root, "tsconfig.json"),
      `{
        // line comment
        /* block comment */
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["./src/*"],
          },
        },
      }`,
    );
    const aliases = loadAliasConfig(root);
    assert.ok(aliases);
    assert.equal(aliases.paths.get("@/*")?.[0], "./src/*");
  });

  it("extensionOf returns lowercased extension or null", () => {
    assert.equal(extensionOf("/path/to/foo.JPG"), ".jpg");
    assert.equal(extensionOf("/path/to/foo.HEIC"), ".heic");
    assert.equal(extensionOf("/path/to/no-dot"), null);
    assert.equal(extensionOf("/path/to/foo.pdf"), null);
  });
});
