import type {
  ContentSource,
  FsFileSource,
  FunctionSpec,
  LocalDirRef,
  ReleaseSpec,
} from "./namespaces/deploy.types.js";

export type Run402ExecutionMode =
  | "apply"
  | "check"
  | "printSpec"
  | "plan"
  | { kind: "applyReviewed"; planId: string; planFingerprint?: string };

export interface Run402ReviewedPlanRequirement {
  planId: string;
  planFingerprint?: string;
}

export interface Run402FileConfigOptions {
  contentType?: string;
  content_type?: string;
}

export interface Run402DirConfigOptions {
  prefix?: string;
  ignore?: ReadonlyArray<string>;
  includeSensitive?: boolean;
}

export interface Run402SqlFileConfigOptions {
  id?: string;
  checksum?: string;
  transaction?: "required" | "none";
}

export interface Run402NodeFunctionConfigOptions
  extends Omit<FunctionSpec, "source" | "files" | "runtime"> {
  runtime?: "node22";
  source?: never;
  files?: never;
}

export interface Run402FileConfigSource extends FsFileSource {
  readonly content_type?: string;
}

export interface Run402SqlFileConfigMigration {
  id: string;
  sql_file: string;
  checksum?: string;
  transaction?: "required" | "none";
}

export type Run402ReleaseConfig = Omit<ReleaseSpec, "project"> & {
  project?: string;
  project_id?: string;
  idempotency_key?: string;
};

export interface Run402ConfigEnv {
  readonly accessed: readonly string[];
  get(name: string): string | undefined;
  required(name: string): string;
  readonly [name: `RUN402_${string}`]: string | undefined;
}

export interface Run402ConfigContext {
  manifestPath: string;
  rootDir: string;
  env: Run402ConfigEnv;
}

export type Run402ExecutableConfigExport =
  | Run402ReleaseConfig
  | ((context: Run402ConfigContext) => Run402ReleaseConfig | Promise<Run402ReleaseConfig>);

export function defineConfig<const T extends Run402ExecutableConfigExport>(config: T): T {
  return config;
}

export function dir(path: string, options: Run402DirConfigOptions = {}): LocalDirRef {
  return {
    __source: "local-dir",
    path,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    ...(options.ignore !== undefined ? { ignore: [...options.ignore] } : {}),
    ...(options.includeSensitive !== undefined ? { includeSensitive: options.includeSensitive } : {}),
  };
}

export function file(path: string, options: Run402FileConfigOptions = {}): Run402FileConfigSource {
  return {
    __source: "fs-file",
    path,
    ...(options.contentType !== undefined
      ? { contentType: options.contentType }
      : options.content_type !== undefined
        ? { contentType: options.content_type }
        : {}),
    ...(options.content_type !== undefined ? { content_type: options.content_type } : {}),
  };
}

export function sqlFile(
  path: string,
  options: Run402SqlFileConfigOptions = {},
): Run402SqlFileConfigMigration {
  return {
    id: options.id ?? defaultIdFromPath(path),
    sql_file: path,
    ...(options.checksum !== undefined ? { checksum: options.checksum } : {}),
    ...(options.transaction !== undefined ? { transaction: options.transaction } : {}),
  };
}

export function nodeFunction(
  path: string,
  options: Run402NodeFunctionConfigOptions = {},
): FunctionSpec {
  return {
    runtime: options.runtime ?? "node22",
    source: file(path) satisfies ContentSource,
    ...(options.entrypoint !== undefined ? { entrypoint: options.entrypoint } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.deps !== undefined ? { deps: [...options.deps] } : {}),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    ...(options.class !== undefined ? { class: options.class } : {}),
    ...(options.capabilities !== undefined ? { capabilities: [...options.capabilities] } : {}),
    ...(options.requireAuth !== undefined ? { requireAuth: options.requireAuth } : {}),
    ...(options.requireRole !== undefined ? { requireRole: options.requireRole } : {}),
  };
}

function defaultIdFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const base = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  return base.replace(/\.[^.]*$/, "") || base;
}
