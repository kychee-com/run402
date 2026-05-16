import { readFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  resolve as resolvePath,
} from "node:path";
import { LocalError } from "../errors.js";
import { ROUTE_HTTP_METHODS } from "../namespaces/deploy.types.js";
import type {
  ContentRef,
  ContentSource,
  DatabaseSpec,
  FileSet,
  FunctionSpec,
  ReleaseRoutesSpec,
  ReleaseSpec,
  SitePublicPathsSpec,
} from "../namespaces/deploy.types.js";

const CONTEXT = "normalizing deploy manifest";

const MANIFEST_FIELDS = new Set([
  "$schema",
  "project",
  "project_id",
  "idempotency_key",
  "idempotencyKey",
  "base",
  "database",
  "secrets",
  "functions",
  "site",
  "subdomains",
  "routes",
  "checks",
]);
const MANIFEST_DATABASE_FIELDS = new Set(["migrations", "expose", "zero_downtime"]);
const MANIFEST_MIGRATION_FIELDS = new Set([
  "id",
  "checksum",
  "sql",
  "sql_ref",
  "sql_path",
  "sql_file",
  "transaction",
]);
const MANIFEST_FUNCTIONS_FIELDS = new Set(["replace", "patch"]);
const MANIFEST_FUNCTIONS_PATCH_FIELDS = new Set(["set", "delete"]);
const MANIFEST_FUNCTION_FIELDS = new Set([
  "runtime",
  "source",
  "files",
  "entrypoint",
  "config",
  "schedule",
]);
const MANIFEST_SITE_FIELDS = new Set(["replace", "patch", "public_paths"]);
const MANIFEST_SITE_PATCH_FIELDS = new Set(["put", "delete"]);
const MANIFEST_SITE_PUBLIC_PATHS_FIELDS = new Set(["mode", "replace"]);
const MANIFEST_PUBLIC_STATIC_PATH_FIELDS = new Set(["asset", "cache_class"]);
const MANIFEST_ROUTES_FIELDS = new Set(["replace"]);
const MANIFEST_ROUTE_ENTRY_FIELDS = new Set(["pattern", "methods", "target", "acknowledge_readonly"]);
const MANIFEST_FUNCTION_ROUTE_TARGET_FIELDS = new Set(["type", "name"]);
const MANIFEST_STATIC_ROUTE_TARGET_FIELDS = new Set(["type", "file"]);
const ROUTE_METHOD_SET = new Set<string>(ROUTE_HTTP_METHODS);

export type DeployManifestFileEntry =
  | ContentSource
  | {
      path: string;
      contentType?: string;
      data?: never;
    }
  | {
      data: string | ContentSource;
      encoding?: "utf-8" | "base64";
      contentType?: string;
    };

export type DeployManifestFileSet = Record<string, DeployManifestFileEntry>;

export interface DeployManifestMigrationSpec {
  id: string;
  checksum?: string;
  sql?: string;
  sql_ref?: ContentRef;
  sql_path?: string;
  sql_file?: string;
  transaction?: "required" | "none";
}

export interface DeployManifestDatabaseSpec {
  migrations?: DeployManifestMigrationSpec[];
  expose?: DatabaseSpec["expose"];
  zero_downtime?: boolean;
}

export interface DeployManifestFunctionSpec
  extends Omit<FunctionSpec, "source" | "files"> {
  source?: DeployManifestFileEntry;
  files?: DeployManifestFileSet;
}

export interface DeployManifestFunctionsSpec {
  replace?: Record<string, DeployManifestFunctionSpec>;
  patch?: {
    set?: Record<string, DeployManifestFunctionSpec>;
    delete?: string[];
  };
}

export type DeployManifestSiteSpec =
  | { replace: DeployManifestFileSet; patch?: never; public_paths?: SitePublicPathsSpec }
  | { patch: { put?: DeployManifestFileSet; delete?: string[] }; replace?: never; public_paths?: SitePublicPathsSpec }
  | { public_paths: SitePublicPathsSpec; replace?: never; patch?: never };

export interface DeployManifestInput
  extends Omit<ReleaseSpec, "project" | "database" | "functions" | "site"> {
  /** JSON Schema metadata for editors. Stripped before deploy planning. */
  $schema?: string;
  /** SDK-native project field. `project_id` is also accepted for MCP/CLI parity. */
  project?: string;
  /** MCP/CLI-friendly project field, normalized to `ReleaseSpec.project`. */
  project_id?: string;
  database?: DeployManifestDatabaseSpec;
  functions?: DeployManifestFunctionsSpec;
  site?: DeployManifestSiteSpec;
  /** CLI/MCP manifest idempotency key, returned separately for deploy options. */
  idempotency_key?: string;
  /** JS-friendly alias for `idempotency_key`. */
  idempotencyKey?: string;
}

export interface NormalizeDeployManifestOptions {
  /** Base directory for relative `{ path }`, `sql_path`, and `sql_file` entries. Defaults to `process.cwd()`. */
  baseDir?: string;
  /** Explicit project override, equivalent to CLI `--project`. Conflicts with a different manifest project. */
  project?: string;
  /** Fallback project used only when the manifest omits both `project` and `project_id`. */
  defaultProject?: string;
}

export interface LoadDeployManifestOptions
  extends Omit<NormalizeDeployManifestOptions, "baseDir"> {}

export interface NormalizedDeployManifest {
  /** SDK-native deploy spec ready for `r.deploy.apply(spec, opts)`. */
  spec: ReleaseSpec;
  /** Optional idempotency key from `idempotency_key` / `idempotencyKey`. */
  idempotencyKey?: string;
  /** Parsed manifest object supplied by the caller or loaded from disk. */
  manifest: DeployManifestInput;
  /** Absolute path when produced by `loadDeployManifest(path)`. */
  manifestPath?: string;
}

export async function loadDeployManifest(
  path: string,
  opts: LoadDeployManifestOptions = {},
): Promise<NormalizedDeployManifest> {
  const manifestPath = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (err) {
    throw new LocalError(
      `Failed to read deploy manifest '${path}': ${(err as Error).message}`,
      "loading deploy manifest",
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LocalError(
      `Deploy manifest is not valid JSON: ${(err as Error).message}`,
      "parsing deploy manifest",
      err,
    );
  }

  const normalized = await normalizeDeployManifest(parsed as DeployManifestInput, {
    ...opts,
    baseDir: dirname(manifestPath),
  });
  return { ...normalized, manifestPath };
}

export async function normalizeDeployManifest(
  input: DeployManifestInput,
  opts: NormalizeDeployManifestOptions = {},
): Promise<NormalizedDeployManifest> {
  assertPlainRecord(input, "Deploy manifest");

  const manifest = input as DeployManifestInput;
  assertKnownFields(manifest, "Deploy manifest", MANIFEST_FIELDS, {
    subdomain: "Use `subdomains: { set: [name] }`.",
  });
  const project = resolveProject(manifest, opts);
  const spec: ReleaseSpec = { project };

  if (manifest.base !== undefined) spec.base = manifest.base;
  if (manifest.subdomains !== undefined) spec.subdomains = manifest.subdomains;
  if (manifest.secrets !== undefined) spec.secrets = manifest.secrets;
  if (manifest.routes !== undefined) spec.routes = mapRoutes(manifest.routes);
  if (manifest.checks !== undefined) spec.checks = manifest.checks;

  if (manifest.database !== undefined) {
    spec.database = await mapDatabase(manifest.database, opts);
  }
  if (manifest.functions !== undefined) {
    spec.functions = mapFunctions(manifest.functions, opts);
  }
  if (manifest.site !== undefined) {
    spec.site = mapSite(manifest.site, opts);
  }

  const idempotencyKey = resolveIdempotencyKey(manifest);
  return idempotencyKey === undefined
    ? { spec, manifest }
    : { spec, idempotencyKey, manifest };
}

function resolveProject(
  manifest: DeployManifestInput,
  opts: NormalizeDeployManifestOptions,
): string {
  if (
    manifest.project !== undefined &&
    manifest.project_id !== undefined &&
    manifest.project !== manifest.project_id
  ) {
    throw new LocalError(
      `project conflict: manifest.project=${manifest.project} but manifest.project_id=${manifest.project_id}`,
      CONTEXT,
    );
  }

  const manifestProject = manifest.project ?? manifest.project_id;
  if (
    opts.project !== undefined &&
    manifestProject !== undefined &&
    opts.project !== manifestProject
  ) {
    throw new LocalError(
      `project conflict: manifest project=${manifestProject} but override project=${opts.project}`,
      CONTEXT,
    );
  }

  const project = opts.project ?? manifestProject ?? opts.defaultProject;
  if (!project) {
    throw new LocalError(
      "Deploy manifest requires project_id (or project). Pass a project override or set a default project before normalizing.",
      CONTEXT,
    );
  }
  return project;
}

function resolveIdempotencyKey(
  manifest: DeployManifestInput,
): string | undefined {
  if (
    manifest.idempotency_key !== undefined &&
    manifest.idempotencyKey !== undefined &&
    manifest.idempotency_key !== manifest.idempotencyKey
  ) {
    throw new LocalError(
      "idempotency key conflict: idempotency_key and idempotencyKey differ",
      CONTEXT,
    );
  }
  return manifest.idempotency_key ?? manifest.idempotencyKey;
}

async function mapDatabase(
  database: DeployManifestDatabaseSpec,
  opts: NormalizeDeployManifestOptions,
): Promise<NonNullable<ReleaseSpec["database"]>> {
  assertPlainRecord(database, "Deploy manifest database");
  assertKnownFields(database, "Deploy manifest database", MANIFEST_DATABASE_FIELDS);
  const raw = database as DeployManifestDatabaseSpec;
  const out: NonNullable<ReleaseSpec["database"]> = {};
  if (raw.expose !== undefined) out.expose = raw.expose;
  if (raw.zero_downtime !== undefined) {
    out.zero_downtime = raw.zero_downtime;
  }
  if (raw.migrations !== undefined) {
    if (!Array.isArray(raw.migrations)) {
      throw new LocalError(
        "Deploy manifest database.migrations must be an array",
        CONTEXT,
      );
    }
    out.migrations = [];
    for (const migration of raw.migrations) {
      out.migrations.push(await mapMigration(migration, opts));
    }
  }
  return out;
}

async function mapMigration(
  migration: DeployManifestMigrationSpec,
  opts: NormalizeDeployManifestOptions,
): Promise<NonNullable<NonNullable<ReleaseSpec["database"]>["migrations"]>[number]> {
  assertPlainRecord(migration, "Deploy manifest database.migrations[]");
  assertKnownFields(
    migration,
    "Deploy manifest database.migrations[]",
    MANIFEST_MIGRATION_FIELDS,
  );
  const out: NonNullable<NonNullable<ReleaseSpec["database"]>["migrations"]>[number] = {
    id: migration.id,
  };
  if (migration.sql !== undefined) out.sql = migration.sql;
  if (migration.sql_ref !== undefined) out.sql_ref = migration.sql_ref;
  if (migration.checksum !== undefined) out.checksum = migration.checksum;
  if (migration.transaction !== undefined) out.transaction = migration.transaction;

  const sqlPath = migration.sql_path ?? migration.sql_file;
  if (
    migration.sql_path !== undefined &&
    migration.sql_file !== undefined &&
    migration.sql_path !== migration.sql_file
  ) {
    throw new LocalError(
      `Migration ${migration.id} has both sql_path and sql_file with different values`,
      CONTEXT,
    );
  }
  if (out.sql === undefined && sqlPath !== undefined) {
    const field = migration.sql_path !== undefined ? "sql_path" : "sql_file";
    const abs = resolveLocalPath(sqlPath, opts.baseDir);
    try {
      out.sql = await readFile(abs, "utf-8");
    } catch (err) {
      throw new LocalError(
        `Failed to read migration ${field} '${sqlPath}': ${(err as Error).message}`,
        CONTEXT,
        err,
      );
    }
  }

  return out;
}

function mapFunctions(
  functions: DeployManifestFunctionsSpec,
  opts: NormalizeDeployManifestOptions,
): NonNullable<ReleaseSpec["functions"]> {
  assertPlainRecord(functions, "Deploy manifest functions");
  assertKnownFields(functions, "Deploy manifest functions", MANIFEST_FUNCTIONS_FIELDS);
  const out: NonNullable<ReleaseSpec["functions"]> = {};
  const replace = functions.replace;
  if (replace !== undefined) {
    assertPlainRecord(replace, "Deploy manifest functions.replace");
    out.replace = mapFunctionMap(
      replace as Record<string, DeployManifestFunctionSpec>,
      opts,
    );
  }
  const patch = functions.patch;
  if (patch !== undefined) {
    assertPlainRecord(patch, "Deploy manifest functions.patch");
    assertKnownFields(
      patch,
      "Deploy manifest functions.patch",
      MANIFEST_FUNCTIONS_PATCH_FIELDS,
    );
    out.patch = {};
    if (patch.set !== undefined) {
      assertPlainRecord(patch.set, "Deploy manifest functions.patch.set");
      out.patch.set = mapFunctionMap(
        patch.set as Record<string, DeployManifestFunctionSpec>,
        opts,
      );
    }
    if (patch.delete !== undefined) {
      if (!Array.isArray(patch.delete)) {
        throw new LocalError(
          "Deploy manifest functions.patch.delete must be an array",
          CONTEXT,
        );
      }
      out.patch.delete = patch.delete;
    }
  }
  return out;
}

function mapFunctionMap(
  map: Record<string, DeployManifestFunctionSpec>,
  opts: NormalizeDeployManifestOptions,
): Record<string, FunctionSpec> {
  const out: Record<string, FunctionSpec> = {};
  for (const [name, fn] of Object.entries(map)) {
    out[name] = mapFunction(fn, opts);
  }
  return out;
}

function mapFunction(
  fn: DeployManifestFunctionSpec,
  opts: NormalizeDeployManifestOptions,
): FunctionSpec {
  assertPlainRecord(fn, "Deploy manifest function entry");
  assertKnownFields(fn, "Deploy manifest function entry", MANIFEST_FUNCTION_FIELDS);
  const raw = fn as DeployManifestFunctionSpec;
  const out: FunctionSpec = {};
  if (raw.runtime !== undefined) out.runtime = raw.runtime;
  if (raw.source !== undefined) {
    out.source = fileEntryToContentSource(raw.source, opts, "functions.source");
  }
  if (raw.files !== undefined) out.files = mapFileSet(raw.files, opts);
  if (raw.entrypoint !== undefined) out.entrypoint = raw.entrypoint;
  if (raw.config !== undefined) out.config = raw.config;
  if (raw.schedule !== undefined) out.schedule = raw.schedule;
  return out;
}

function mapSite(
  site: DeployManifestSiteSpec,
  opts: NormalizeDeployManifestOptions,
): NonNullable<ReleaseSpec["site"]> {
  assertPlainRecord(site, "Deploy manifest site");
  assertKnownFields(site, "Deploy manifest site", MANIFEST_SITE_FIELDS, {
    file: "Use `site.replace` or `site.patch.put` with a path-keyed file map.",
    files: "Use `site.replace` or `site.patch.put` with a path-keyed file map.",
  });
  const raw = site as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(raw, "replace") &&
    Object.prototype.hasOwnProperty.call(raw, "patch")
  ) {
    throw new LocalError(
      "Deploy manifest site must use either replace or patch, not both",
      CONTEXT,
    );
  }
  const publicPaths = Object.prototype.hasOwnProperty.call(raw, "public_paths")
    ? mapSitePublicPaths(raw.public_paths)
    : undefined;
  if (Object.prototype.hasOwnProperty.call(raw, "replace")) {
    if (raw.replace === undefined) {
      throw new LocalError("Deploy manifest site.replace is undefined", CONTEXT);
    }
    return {
      replace: mapFileSet(raw.replace as DeployManifestFileSet, opts),
      ...(publicPaths ? { public_paths: publicPaths } : {}),
    };
  }
  if (Object.prototype.hasOwnProperty.call(raw, "patch")) {
    const patch: { put?: FileSet; delete?: string[] } = {};
    assertPlainRecord(raw.patch, "Deploy manifest site.patch");
    const rawPatch = raw.patch as { put?: unknown; delete?: unknown };
    assertKnownFields(rawPatch, "Deploy manifest site.patch", MANIFEST_SITE_PATCH_FIELDS);
    if (rawPatch.put !== undefined) {
      patch.put = mapFileSet(rawPatch.put as DeployManifestFileSet, opts);
    }
    if (rawPatch.delete !== undefined) {
      if (!Array.isArray(rawPatch.delete)) {
        throw new LocalError(
          "Deploy manifest site.patch.delete must be an array",
          CONTEXT,
        );
      }
      patch.delete = rawPatch.delete as string[];
    }
    return {
      patch,
      ...(publicPaths ? { public_paths: publicPaths } : {}),
    };
  }
  if (publicPaths) {
    return { public_paths: publicPaths };
  }
  throw new LocalError(
    "Deploy manifest site must include replace, patch, or public_paths",
    CONTEXT,
  );
}

function mapSitePublicPaths(value: unknown): SitePublicPathsSpec {
  assertPlainRecord(value, "Deploy manifest site.public_paths");
  assertKnownFields(
    value,
    "Deploy manifest site.public_paths",
    MANIFEST_SITE_PUBLIC_PATHS_FIELDS,
  );
  if (value.mode !== "implicit" && value.mode !== "explicit") {
    throw new LocalError(
      'Deploy manifest site.public_paths.mode must be "implicit" or "explicit"',
      CONTEXT,
    );
  }
  if (value.mode === "implicit") {
    if (Object.prototype.hasOwnProperty.call(value, "replace")) {
      throw new LocalError(
        "Deploy manifest site.public_paths.replace is invalid for implicit mode",
        CONTEXT,
      );
    }
    return { mode: "implicit" };
  }

  if (!Object.prototype.hasOwnProperty.call(value, "replace")) {
    throw new LocalError(
      "Deploy manifest site.public_paths with mode explicit requires a complete replace map",
      CONTEXT,
    );
  }
  assertPlainRecord(
    value.replace,
    "Deploy manifest site.public_paths.replace",
  );
  const replace: Record<string, { asset: string; cache_class?: string }> = {};
  for (const [publicPath, entry] of Object.entries(value.replace)) {
    const label = `Deploy manifest site.public_paths.replace[${JSON.stringify(publicPath)}]`;
    assertPlainRecord(entry, label);
    assertKnownFields(entry, label, MANIFEST_PUBLIC_STATIC_PATH_FIELDS);
    if (typeof entry.asset !== "string" || entry.asset.length === 0) {
      throw new LocalError(`${label}.asset must be a non-empty release static asset path`, CONTEXT);
    }
    if (entry.cache_class !== undefined && typeof entry.cache_class !== "string") {
      throw new LocalError(`${label}.cache_class must be a string`, CONTEXT);
    }
    replace[publicPath] =
      entry.cache_class === undefined
        ? { asset: entry.asset }
        : { asset: entry.asset, cache_class: entry.cache_class };
  }
  return { mode: "explicit", replace };
}

function mapRoutes(routes: unknown): ReleaseRoutesSpec {
  if (routes === null) return null;
  assertPlainRecord(routes, "Deploy manifest routes");
  assertKnownFields(routes, "Deploy manifest routes", MANIFEST_ROUTES_FIELDS, routeShapeHints(routes));
  if (!Object.prototype.hasOwnProperty.call(routes, "replace")) {
    throw new LocalError(
      "Deploy manifest routes must be null or { \"replace\": [{ \"pattern\": \"/api/*\", \"target\": { \"type\": \"function\", \"name\": \"api\" } }, { \"pattern\": \"/events\", \"methods\": [\"GET\"], \"target\": { \"type\": \"static\", \"file\": \"events.html\" } }] }. Path-keyed route maps are not supported.",
      CONTEXT,
    );
  }
  const replace = routes.replace;
  if (!Array.isArray(replace)) {
    throw new LocalError("Deploy manifest routes.replace must be an array", CONTEXT);
  }
  replace.forEach((route, index) => validateManifestRouteEntry(route, index));
  return routes as ReleaseRoutesSpec;
}

function routeShapeHints(obj: Record<string, unknown>): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith("/")) {
      hints[key] = "Use routes.replace[] entries like { pattern, target: { type: \"function\", name } } or { pattern, methods: [\"GET\"], target: { type: \"static\", file } } instead of a path-keyed route map.";
    }
  }
  return hints;
}

function validateManifestRouteEntry(route: unknown, index: number): void {
  const label = `Deploy manifest routes.replace[${index}]`;
  assertPlainRecord(route, label);
  assertKnownFields(route, label, MANIFEST_ROUTE_ENTRY_FIELDS);
  if (typeof route.pattern !== "string" || route.pattern.length === 0) {
    throw new LocalError(`${label}.pattern must be a non-empty string`, CONTEXT);
  }
  if (route.methods !== undefined) {
    if (!Array.isArray(route.methods)) {
      throw new LocalError(`${label}.methods must be an array of HTTP methods`, CONTEXT);
    }
    if (route.methods.length === 0) {
      throw new LocalError(`${label}.methods must not be empty; omit methods to allow all supported methods`, CONTEXT);
    }
    for (const method of route.methods) {
      if (typeof method !== "string" || !ROUTE_METHOD_SET.has(method)) {
        throw new LocalError(
          `${label}.methods contains unsupported method ${JSON.stringify(method)}. Supported methods: ${ROUTE_HTTP_METHODS.join(", ")}`,
          CONTEXT,
        );
      }
    }
    const seen = new Set<string>();
    for (const method of route.methods) {
      if (seen.has(method as string)) {
        throw new LocalError(`${label}.methods contains duplicate method ${JSON.stringify(method)}`, CONTEXT);
      }
      seen.add(method as string);
    }
  }
  const targetType = validateManifestRouteTarget(route.target, `${label}.target`);
  validateManifestRouteReadOnlyAcknowledgement(route, targetType, label);
  if (targetType === "static") validateManifestStaticRouteEntry(route, label);
}

function validateManifestRouteReadOnlyAcknowledgement(
  route: Record<string, unknown>,
  targetType: "function" | "static",
  label: string,
): void {
  if (route.acknowledge_readonly === undefined) return;
  if (route.acknowledge_readonly !== true) {
    throw new LocalError(`${label}.acknowledge_readonly must be true when present`, CONTEXT);
  }
  if (
    targetType !== "function" ||
    typeof route.pattern !== "string" ||
    !isFinalWildcardRoutePattern(route.pattern) ||
    !isReadOnlyRouteMethods(route.methods)
  ) {
    throw new LocalError(
      `${label}.acknowledge_readonly applies only to GET/HEAD final-wildcard function routes`,
      CONTEXT,
    );
  }
}

function isFinalWildcardRoutePattern(pattern: string): boolean {
  return pattern.endsWith("/*");
}

function isReadOnlyRouteMethods(methods: unknown): boolean {
  if (!Array.isArray(methods) || methods.length === 0) return false;
  return methods.every((method) => method === "GET" || method === "HEAD");
}

function validateManifestRouteTarget(target: unknown, label: string): "function" | "static" {
  assertPlainRecord(target, label);
  if (
    (Object.prototype.hasOwnProperty.call(target, "function") ||
      Object.prototype.hasOwnProperty.call(target, "static")) &&
    !Object.prototype.hasOwnProperty.call(target, "type")
  ) {
    throw new LocalError(`${label} uses unsupported target shorthand. Use { "type": "function", "name": "api" } or { "type": "static", "file": "events.html" }.`, CONTEXT);
  }
  if (target.type === undefined) {
    throw new LocalError(`${label}.type is required; use "function" or "static"`, CONTEXT);
  }
  if (target.type === "function") {
    assertKnownFields(target, label, MANIFEST_FUNCTION_ROUTE_TARGET_FIELDS);
    if (typeof target.name !== "string" || target.name.length === 0) {
      throw new LocalError(`${label}.name is required for function route targets`, CONTEXT);
    }
    return "function";
  }
  if (target.type === "static") {
    assertKnownFields(target, label, MANIFEST_STATIC_ROUTE_TARGET_FIELDS);
    if (typeof target.file !== "string" || target.file.length === 0) {
      throw new LocalError(`${label}.file is required for static route targets`, CONTEXT);
    }
    validateManifestStaticTargetFile(target.file, `${label}.file`);
    return "static";
  }
  throw new LocalError(`${label}.type must be "function" or "static"; got ${JSON.stringify(target.type)}`, CONTEXT);
}

function validateManifestStaticRouteEntry(route: Record<string, unknown>, label: string): void {
  const pattern = route.pattern as string;
  if (pattern.includes("*")) {
    throw new LocalError(`${label}.pattern uses a static route target, so it must be an exact path pattern; wildcard static route targets such as /docs/* are not supported`, CONTEXT);
  }
  if (route.methods === undefined) {
    throw new LocalError(`${label}.methods is required for static route targets; use ["GET"] or ["GET", "HEAD"]`, CONTEXT);
  }
  const methods = route.methods as unknown[];
  const methodSet = new Set(methods);
  const valid =
    methodSet.has("GET") &&
    (methodSet.size === 1 || (methodSet.size === 2 && methodSet.has("HEAD")));
  if (!valid) {
    throw new LocalError(`${label}.methods for static route targets must be ["GET"] or ["GET", "HEAD"]; either form materializes effective GET plus HEAD`, CONTEXT);
  }
}

function validateManifestStaticTargetFile(file: string, label: string): void {
  const invalid =
    file.startsWith("/") ||
    file.includes("?") ||
    file.includes("#") ||
    file.includes("\\") ||
    file.endsWith("/") ||
    file.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
  if (invalid) {
    throw new LocalError(`${label} must be a relative materialized static-site file path without leading slash, query, fragment, traversal, empty segments, backslashes, or directory shorthand`, CONTEXT);
  }
}

function mapFileSet(
  map: DeployManifestFileSet,
  opts: NormalizeDeployManifestOptions,
): FileSet {
  assertPlainRecord(map, "Deploy manifest file map");
  const out: FileSet = {};
  for (const [path, entry] of Object.entries(map)) {
    out[path] = fileEntryToContentSource(entry, opts, path);
  }
  return out;
}

function fileEntryToContentSource(
  entry: DeployManifestFileEntry,
  opts: NormalizeDeployManifestOptions,
  label: string,
): ContentSource {
  if (typeof entry === "string") return entry;
  if (entry instanceof Uint8Array) return entry;
  if (entry instanceof ArrayBuffer) return entry;
  if (typeof Blob !== "undefined" && entry instanceof Blob) return entry;
  if (isReadableStream(entry)) return entry;
  if (isContentRef(entry)) return { ...entry };

  if (!isRecord(entry) || Array.isArray(entry)) {
    return entry as ContentSource;
  }

  const rec = entry as Record<string, unknown>;
  const encoding = rec.encoding;
  if (
    encoding !== undefined &&
    encoding !== "utf-8" &&
    encoding !== "base64"
  ) {
    throw new LocalError(
      `Unsupported encoding for ${label}: ${String(encoding)}`,
      CONTEXT,
    );
  }

  if (
    typeof rec.path === "string" &&
    !Object.prototype.hasOwnProperty.call(rec, "data")
  ) {
    const source = {
      __source: "fs-file" as const,
      path: resolveLocalPath(rec.path, opts.baseDir),
    };
    return typeof entry.contentType === "string"
      ? { ...source, contentType: entry.contentType }
      : source;
  }

  if (encoding === "base64") {
    if (typeof rec.data !== "string") {
      throw new LocalError(
        `Base64 file entry for ${label} must use a string data field`,
        CONTEXT,
      );
    }
    const bytes = base64ToBytes(rec.data);
    return typeof entry.contentType === "string"
      ? { data: bytes, contentType: entry.contentType }
      : bytes;
  }

  if (Object.prototype.hasOwnProperty.call(rec, "data")) {
    if (rec.data === undefined) {
      throw new LocalError(`File entry for ${label} is missing data`, CONTEXT);
    }
    const data = rec.data as ContentSource;
    return typeof entry.contentType === "string"
      ? { data, contentType: entry.contentType }
      : data;
  }

  return entry as ContentSource;
}

function base64ToBytes(value: string): Uint8Array {
  const buf = Buffer.from(value, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function resolveLocalPath(path: string, baseDir = process.cwd()): string {
  return isAbsolute(path) ? path : resolvePath(baseDir, path);
}

function isContentRef(value: unknown): value is ContentRef {
  return (
    isRecord(value) &&
    typeof value.sha256 === "string" &&
    typeof value.size === "number"
  );
}

function isReadableStream(
  value: unknown,
): value is ReadableStream<Uint8Array> {
  return (
    typeof ReadableStream !== "undefined" &&
    value instanceof ReadableStream
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new LocalError(`${label} must be a JSON object`, CONTEXT);
  }
}

function assertKnownFields(
  value: object,
  label: string,
  allowed: Set<string>,
  hints: Record<string, string> = {},
): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    const hint = hints[key] ? ` ${hints[key]}` : "";
    throw new LocalError(`Unknown ${label} field: ${key}.${hint}`, CONTEXT);
  }
}
