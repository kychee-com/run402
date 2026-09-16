import { relative, resolve } from "node:path";
import { LocalError } from "../errors.js";
import type { NormalizedDeployManifest } from "./deploy-manifest.js";

export function manifestExportUnsupported(path: string, reason: string): never {
  throw new LocalError(`Cannot export ${path}: ${reason}`, "exporting authoring manifest", {
    code: "MANIFEST_EXPORT_UNSUPPORTED", details: { field_paths: [path], reason },
    next_actions: [{ type: "edit_manifest", why: "Use supported declarative release inputs, then retry --print-manifest. --print-spec is SDK-native inspection only." }],
  });
}

/** Export relative to the original manifest directory, never the caller's cwd. */
export function serializeDeployManifest(loaded: NormalizedDeployManifest, baseDir: string, explicitProject?: string | null): Record<string, unknown> {
  if (loaded.config?.env_accessed.length) manifestExportUnsupported("config.env", "evaluated environment values may contain secrets; keep them in the trusted config");
  const secrets = loaded.spec.secrets;
  if (secrets && Object.keys(secrets).some((key) => !["require", "delete"].includes(key))) manifestExportUnsupported("secrets", "embedded secret values are not exportable");
  const aliases: Record<string, string> = { timeoutSeconds: "timeout_seconds", memoryMb: "memory_mb", contentType: "content_type", requireAuth: "require_auth", requireRole: "require_role", idColumn: "id_column", roleColumn: "role_column", cacheTtl: "cache_ttl", onDeny: "on_deny", signInPath: "sign_in_path", defaultLocale: "default_locale", unknownLocalePolicy: "unknown_locale_policy" };
  const seen = new Set<object>();
  function visit(value: unknown, path: string, content = false): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
    if (value instanceof Uint8Array) return { data: Buffer.from(value).toString("base64"), encoding: "base64" };
    if (value instanceof ArrayBuffer) return { data: Buffer.from(value).toString("base64"), encoding: "base64" };
    if (typeof value !== "object" || value === undefined) return manifestExportUnsupported(path, "executable or non-JSON value");
    if (seen.has(value)) return manifestExportUnsupported(path, "cyclic object");
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}[${index}]`));
      const record = value as Record<string, unknown>;
      if (record.__source === "fs-file") return { path: relative(baseDir, record.path as string).split("\\").join("/"), ...(record.contentType ? { content_type: record.contentType } : {}) };
      if (record.__source === "local-dir") return manifestExportUnsupported(path, "directory enumeration is dynamic; use explicit file entries for a reloadable JSON export");
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return manifestExportUnsupported(path, "streams and runtime objects are not declarative JSON");
      const isNamedMap = /^(functions\.(replace|patch\.set)|site\.(replace|patch\.put))$/.test(path) || path.endsWith(".files");
      const schemaAliases = path === "i18n" || /^functions\.(?:replace|patch\.set)\.[^.]+(?:\.config|\.requireRole)?$/.test(path) || content;
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record)) {
        if (child === undefined) continue;
        result[isNamedMap || !schemaAliases ? key : aliases[key] ?? key] = visit(child, path ? `${path}.${key}` : key, (isNamedMap && !path.startsWith("functions.")) || path.endsWith(".files") || (key === "source" && /^(functions|assets)\./.test(path)) || (key === "data" && content));
      }
      // ContentSource {data: Uint8Array} wraps bytes; its authoring encoding
      // belongs alongside data, not in a second nested data wrapper.
      if (record.data instanceof Uint8Array || record.data instanceof ArrayBuffer) {
        Object.assign(result, visit(record.data, `${path}.data`));
      }
      return result;
    } finally { seen.delete(value); }
  }
  const { project: _project, ...spec } = loaded.spec;
  const result = visit(spec, "") as Record<string, unknown>;
  const project = explicitProject ?? loaded.manifest.project_id ?? loaded.manifest.project;
  if (project) result.project_id = project;
  if (loaded.idempotencyKey) result.idempotency_key = loaded.idempotencyKey;
  if (loaded.verify) result.verify = visit(loaded.verify, "verify");
  const migrations = (result.database as { migrations?: Record<string, unknown>[] } | undefined)?.migrations;
  loaded.manifest.database?.migrations?.forEach((migration, index) => {
    const path = migration.sql_path ?? migration.sql_file;
    if (path && migrations?.[index]) {
      delete migrations[index].sql;
      migrations[index].sql_path = relative(baseDir, resolve(baseDir, path)).split("\\").join("/");
    }
  });
  return result;
}
