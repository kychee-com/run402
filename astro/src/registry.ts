/**
 * Build-time AssetRef registry.
 *
 * The `<Image>` component looks up its resolved AssetRef from this registry
 * at render time, keyed by the rewritten `src` prop value. The Vite
 * plugin populates the registry during `buildStart` (or the dev-mode lazy
 * resolver) by rewriting every `<Image src="./relative">` to point at the
 * resolved file's project-root-relative path (`assetMapKey`).
 *
 * The registry is module-level singleton state. Astro/Vite builds are
 * single-process, single-build, so a module-level Map is correct. If we
 * ever support concurrent multi-build pipelines (e.g., an Astro project
 * building multiple sites in one process), this becomes a per-build object
 * passed via Vite's plugin context.
 *
 * The registry is cleared between dev-server restarts (process exits) but
 * NOT between hot module reloads — we want incremental builds to keep the
 * already-resolved AssetRefs alive across HMR cycles.
 */

import type { AssetRef } from "./types.js";

const registry = new Map<string, AssetRef>();

/** Store an AssetRef under its project-root-relative key. */
export function setAssetRef(key: string, ref: AssetRef): void {
  registry.set(key, ref);
}

/**
 * Look up an AssetRef by its project-root-relative key. Returns null if
 * not registered — the component caller decides whether to throw or warn.
 */
export function getAssetRef(key: string): AssetRef | null {
  return registry.get(key) ?? null;
}

/** Test-only: snapshot the registry state. */
export function dumpRegistry(): ReadonlyMap<string, AssetRef> {
  return new Map(registry);
}

/** Test-only: clear the registry between test cases. */
export function clearRegistry(): void {
  registry.clear();
}

/** Test-only: count entries. */
export function registrySize(): number {
  return registry.size;
}
