/**
 * `<Run402Picture>` rendered through Astro's Container API, compiled the way
 * `SignIn.test.ts` compiles its component.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transform } from "@astrojs/compiler";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import ts from "typescript";

async function loadAstroComponent(astroFileUrl: URL): Promise<unknown> {
  const filename = fileURLToPath(astroFileUrl);
  const result = await transform(readFileSync(filename, "utf8"), {
    filename,
    sourcemap: false,
    internalURL: "astro/runtime/server/index.js",
  });
  let code = ts.transpileModule(result.code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  code = code.replace(/^import\s+["'][^"']*\?astro&type=style[^"']*["'];?\s*$/gm, "");
  code = code.replace(/,\s*createMetadata as \$\$createMetadata/, "");
  code = code.replace(/const \$\$metadata = \$\$createMetadata\([\s\S]*?\);\n/, "");
  const tmpUrl = new URL(`./__rendered_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`, astroFileUrl);
  writeFileSync(fileURLToPath(tmpUrl), code, "utf8");
  try {
    return ((await import(tmpUrl.href)) as { default: unknown }).default;
  } finally {
    rmSync(fileURLToPath(tmpUrl), { force: true });
  }
}

async function render(props: Record<string, unknown>): Promise<string> {
  const Component = await loadAstroComponent(new URL("./Run402Picture.astro", import.meta.url));
  const container = await AstroContainer.create();
  return container.renderToString(Component as never, { props } as never);
}

function variant(url: string, width: number | undefined) {
  return { url, cdn_url: url, format: "webp", ...(width === undefined ? {} : { width_px: width }) };
}

function srcset(html: string): string {
  return /<source type="image\/webp" srcset="([^"]*)"/.exec(html)?.[1] ?? "";
}

describe("<Run402Picture> srcset", () => {
  it("writes each variant's own width_px, so a capped large reads as its real width", async () => {
    const html = await render({
      alt: "a photo",
      asset: {
        cdn_url: "https://x.test/o.jpg",
        width_px: 1001,
        height_px: 667,
        variants: {
          thumb: variant("https://x.test/t.webp", 320),
          medium: variant("https://x.test/m.webp", 800),
          large: variant("https://x.test/l.webp", 1001),
        },
      },
    });
    assert.equal(srcset(html), "https://x.test/t.webp 320w, https://x.test/m.webp 800w, https://x.test/l.webp 1001w");
  });

  it("lists a width once when a capped medium and large share it", async () => {
    const html = await render({
      alt: "a photo",
      asset: {
        cdn_url: "https://x.test/o.jpg",
        width_px: 500,
        height_px: 333,
        variants: {
          thumb: variant("https://x.test/t.webp", 320),
          medium: variant("https://x.test/m.webp", 500),
          large: variant("https://x.test/l.webp", 500),
        },
      },
    });
    assert.equal(srcset(html), "https://x.test/t.webp 320w, https://x.test/m.webp 500w");
  });

  it("falls back to the ladder width for a variant without width_px", async () => {
    const html = await render({
      alt: "a photo",
      asset: {
        cdn_url: "https://x.test/o.jpg",
        variants: {
          thumb: variant("https://x.test/t.webp", undefined),
          medium: variant("https://x.test/m.webp", undefined),
          large: variant("https://x.test/l.webp", undefined),
        },
      },
    });
    assert.equal(srcset(html), "https://x.test/t.webp 320w, https://x.test/m.webp 800w, https://x.test/l.webp 1920w");
  });
});
