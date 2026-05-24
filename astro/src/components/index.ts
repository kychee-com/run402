/**
 * Component exports for `@run402/astro/components` (the Astro entry).
 *
 * `.astro` files cannot be exported as JS modules directly — Astro's
 * Vite plugin resolves them via the build system. Users import with:
 *
 *   ```astro
 *   import { Run402Picture, Run402Image } from "@run402/astro/components";
 *   ```
 *
 * The package.json `exports` field maps these to the actual `.astro`
 * source files. This `index.ts` exists so TypeScript's module-resolution
 * recognises the path; the actual resolved module is the `.astro` file.
 *
 * **React consumers** should import from `@run402/astro/react` instead —
 * mixing entries at compile time is caught by the AstroComponent /
 * ReactComponent brand types in `Run402Image/types.ts`.
 */

// @ts-expect-error — .astro files are not type-checked at the
// `@run402/astro` package level; consumers' Astro setups resolve them.
export { default as Run402Picture } from "./Run402Picture.astro";

// @ts-expect-error — same reason as Run402Picture above.
export { default as Run402Image } from "./Run402Image.astro";

// Re-export the prop interface + AssetRef shape + error class so
// consumers can compose project-specific wrappers (e.g., a `<HeroImage>`
// that wraps `<Run402Image>` with project-default `sizes`) without
// dual-importing from a sub-path AND without a separate
// `import type { AssetRef } from "@run402/functions"` line. One import
// line covers the typical wrapper:
//
//   import { Run402Image, type Run402ImageProps, type AssetRef } from "@run402/astro/components";
//   type HeroProps = Pick<Run402ImageProps, "asset" | "alt" | "class">;
//
// (v1.0.1 fix per Kychon DX feedback — symmetric with the React entry's
// matching re-exports in Run402Image/react.tsx.)

export type { AssetRef } from "@run402/functions";
export type {
  Run402ImageProps,
  DataAttributes,
  ImageDefaults,
  PreloadAttrs,
  RenderContext,
  RenderTreeNode,
  DegradationEntry,
} from "./Run402Image/types.js";
export { Run402ImageError } from "./Run402Image/types.js";
