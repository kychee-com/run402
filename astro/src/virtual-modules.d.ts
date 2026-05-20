/**
 * Ambient declaration for the `virtual:run402-assetmap` Vite virtual
 * module. The Vite plugin's `resolveId` + `load` hooks produce the
 * runtime content; this declaration tells tsc what shape to expect
 * when `Image.astro` and downstream code import it.
 *
 * The module's default export is a `Map<absolutePath, AssetRef>`
 * baked at build time. In `astro dev` it may be empty (the Vite
 * plugin populates the singleton-registry path instead), so the
 * component falls through to `registry.getAssetRef` for that mode.
 */
declare module "virtual:run402-assetmap" {
  const entries: Map<string, import("./types.js").AssetRef>;
  export default entries;
}
