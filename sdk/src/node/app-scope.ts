import { loadDeployManifest, normalizeDeployManifest, type DeployManifestInput } from "./deploy-manifest.js";
import { stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const APPLICATION_MANIFESTS = ["run402.json", "run402.deploy.json", "app.json"] as const;

/** Resolve one app locally. Never select a sibling or inherit a parent app. */
export async function resolveApplicationScope(input: { cwd?: string; dir?: string; manifest?: string } = {}) {
  const directory = resolve(input.cwd ?? process.cwd(), input.dir ?? ".");
  if (input.manifest) {
    const manifest = resolve(directory, input.manifest);
    return { app_root: dirname(manifest), manifest_path: manifest, selected: true };
  }
  for (const name of APPLICATION_MANIFESTS) {
    const manifest = resolve(directory, name);
    try {
      if ((await stat(manifest)).isFile()) return { app_root: directory, manifest_path: manifest, selected: true };
    } catch { /* Discovery is local and absence is reported by the caller. */ }
  }
  return { app_root: directory, manifest_path: null, selected: false };
}

export function materializeTemplates(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => values[key] ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => materializeTemplates(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        materializeTemplates(nested, values),
      ]),
    );
  }
  return value;
}


export async function loadApplicationScanInput(manifestPath: string) {
  const raw = manifestPath.endsWith(".json") ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
  const isApp = raw?.app && raw?.release;
  const buildDeferred = Boolean(isApp && raw.build?.commands?.length);
  if (buildDeferred) return { spec: {}, build_deferred: true };
  const normalized = isApp
    ? await normalizeDeployManifest(materializeTemplates(raw.release, {}) as DeployManifestInput, { baseDir: dirname(manifestPath), manifestPath, defaultProject: "prj_up_preflight_placeholder", validateFiles: true })
    : await loadDeployManifest(manifestPath, { defaultProject: "prj_up_preflight_placeholder", validateFiles: true });
  return { spec: normalized.spec, build_deferred: false };
}
