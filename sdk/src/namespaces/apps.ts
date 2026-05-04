/**
 * `apps` namespace — bundle deploy, marketplace browse/fork, and app
 * version publishing.
 */

import type { Client } from "../kernel.js";
import { ProjectNotFound, Run402DeployError } from "../errors.js";
import type { ProjectTier, RlsTemplate, RlsTableSpec } from "./projects.types.js";
import type { SiteFile } from "./sites.js";
import { Deploy } from "./deploy.js";
import type {
  ContentSource,
  DeployResult,
  ExposeManifest,
  FunctionSpec,
  ReleaseSpec,
  WarningEntry,
} from "./deploy.types.js";
import { Secrets } from "./secrets.js";

const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SECRET_VALUE_LIMIT_BYTES = 4 * 1024;

export interface BundleRlsOptions {
  template: RlsTemplate;
  tables: RlsTableSpec[];
  i_understand_this_is_unrestricted?: boolean;
}

export interface BundleFunctionSpec {
  name: string;
  code: string;
  config?: { timeout?: number; memory?: number };
  schedule?: string;
}

export interface BundleDeployOptions {
  migrations?: string;
  rls?: BundleRlsOptions;
  secrets?: Array<{ key: string; value: string }>;
  functions?: BundleFunctionSpec[];
  files?: SiteFile[];
  subdomain?: string;
  inherit?: boolean;
}

export interface MigrationsResult {
  tables_created: string[];
  columns_added: string[];
  status: string;
}

export interface BundleDeployResult {
  project_id: string;
  migrations_result?: MigrationsResult;
  site_url?: string;
  deployment_id?: string;
  functions?: Array<{ name: string; url: string; schedule?: string | null }>;
  subdomain_url?: string;
  warnings?: WarningEntry[];
}

export interface AppSummary {
  id: string;
  project_id: string;
  version: number;
  name: string;
  description: string | null;
  visibility: "public" | "unlisted" | "private";
  fork_allowed: boolean;
  fork_pricing?: Record<string, string>;
  min_tier: ProjectTier;
  derived_min_tier: ProjectTier;
  status: "published" | "draft" | "archived";
  table_count: number;
  function_count: number;
  site_file_count: number;
  site_total_bytes: number;
  required_secrets: Array<{ key: string; description?: string }>;
  required_actions: Array<{ action: string; description?: string }>;
  tags: string[];
  live_url: string | null;
  bootstrap_variables: unknown[] | null;
  created_at: string;
  compatibility_warnings: string[];
}

export interface BrowseAppsResult {
  apps: AppSummary[];
  total: number;
}

export interface ForkAppOptions {
  versionId: string;
  name: string;
  subdomain?: string;
}

export interface ForkAppResult {
  project_id: string;
  anon_key: string;
  service_key: string;
  schema_slot: string;
  site_url?: string;
  subdomain_url?: string;
  functions?: Array<{ name: string; url: string }>;
}

export interface PublishAppOptions {
  description?: string;
  tags?: string[];
  visibility?: "public" | "unlisted" | "private";
  fork_allowed?: boolean;
}

export type PublishedVersion = AppSummary;

export interface VersionSummary {
  id: string;
  description: string | null;
  tags: string[];
  visibility: "public" | "unlisted" | "private";
  fork_allowed: boolean;
  created_at: string;
}

export interface ListVersionsResult {
  versions: VersionSummary[];
}

export interface UpdateVersionOptions {
  description?: string;
  tags?: string[];
  visibility?: "public" | "unlisted" | "private";
  fork_allowed?: boolean;
}

export type AppDetails = AppSummary;

export class Apps {
  constructor(private readonly client: Client) {}

  /**
   * Deploy to an existing project: runs migrations, applies RLS, writes
   * legacy in-memory secret values through the secrets API, deploys
   * functions, deploys a static site, and claims a subdomain. Payment flows
   * through x402 when the project lease needs renewal.
   *
   * **As of v1.34, this method is a thin compatibility shim over
   * {@link Deploy.apply}.** It translates the legacy bundle options into a
   * v2 {@link ReleaseSpec} and delegates to `r.deploy.apply` — bytes ride
   * through CAS, never inline. The method's input shape and return shape
   * remain unchanged for existing callers.
   *
   * Migrations get a deterministic id `bundle_legacy_<sha256(sql)[0:16]>`.
   * Re-shipping identical SQL is a registry noop on the v2 path; this is
   * the only behavior change vs. v1's blind re-execution and is safe for
   * idempotent migrations (the documented agent norm).
   *
   * Legacy `opts.secrets` are not embedded in the release spec. They are
   * pre-validated, written before deploy, then represented as
   * `secrets.require` keys. Those writes are intentionally not atomic with
   * the later deploy commit.
   *
   * `inherit: true` is silently ignored;
   * patch semantics on `r.deploy.apply` replace it.
   */
  async bundleDeploy(
    projectId: string,
    opts: BundleDeployOptions = {},
  ): Promise<BundleDeployResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deploying bundle");

    const spec = await translateBundleToReleaseSpec(projectId, opts);
    if (opts.secrets !== undefined && opts.secrets.length > 0) {
      validateBundleSecrets(opts.secrets);
      const secrets = new Secrets(this.client);
      for (const { key, value } of opts.secrets) {
        await secrets.set(projectId, key, value);
      }
    }
    const deploy = new Deploy(this.client);
    const result = await deploy.apply(spec);

    return reshapeAsBundleResult(projectId, result);
  }

  /** Browse public forkable apps. Optional `tags` filter is OR-combined. */
  async browse(tags?: string[]): Promise<BrowseAppsResult> {
    const path = tags && tags.length > 0
      ? `/apps/v1?${tags.map((t) => `tag=${encodeURIComponent(t)}`).join("&")}`
      : "/apps/v1";
    return this.client.request<BrowseAppsResult>(path, {
      context: "browsing apps",
      withAuth: false,
    });
  }

  /**
   * Fork a published app into a new project. Payment flows through x402
   * when the fork has a price.
   */
  async fork(opts: ForkAppOptions): Promise<ForkAppResult> {
    const result = await this.client.request<ForkAppResult>("/fork/v1", {
      method: "POST",
      body: {
        version_id: opts.versionId,
        name: opts.name,
        subdomain: opts.subdomain,
      },
      context: "forking app",
    });

    // Persist the new project + make it active, if the provider supports it.
    const creds = this.client.credentials;
    if (creds.saveProject) {
      await creds.saveProject(result.project_id, {
        anon_key: result.anon_key,
        service_key: result.service_key,
      });
    }
    if (creds.setActiveProject) {
      await creds.setActiveProject(result.project_id);
    }
    return result;
  }

  /** Publish a project as a forkable app version. */
  async publish(projectId: string, opts: PublishAppOptions = {}): Promise<PublishedVersion> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "publishing app");

    const body: Record<string, unknown> = {};
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.tags !== undefined) body.tags = opts.tags;
    if (opts.visibility !== undefined) body.visibility = opts.visibility;
    if (opts.fork_allowed !== undefined) body.fork_allowed = opts.fork_allowed;

    return this.client.request<PublishedVersion>(
      `/projects/v1/admin/${projectId}/publish`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body,
        context: "publishing app",
      },
    );
  }

  /** List all published versions of a project. */
  async listVersions(projectId: string): Promise<ListVersionsResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing versions");

    return this.client.request<ListVersionsResult>(
      `/projects/v1/admin/${projectId}/versions`,
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "listing versions",
      },
    );
  }

  /** Update metadata (description/tags/visibility/fork_allowed) of a published version. */
  async updateVersion(
    projectId: string,
    versionId: string,
    opts: UpdateVersionOptions,
  ): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "updating version");

    const body: Record<string, unknown> = {};
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.tags !== undefined) body.tags = opts.tags;
    if (opts.visibility !== undefined) body.visibility = opts.visibility;
    if (opts.fork_allowed !== undefined) body.fork_allowed = opts.fork_allowed;

    await this.client.request<unknown>(
      `/projects/v1/admin/${projectId}/versions/${versionId}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body,
        context: "updating version",
      },
    );
  }

  /** Delete a published version. */
  async deleteVersion(projectId: string, versionId: string): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deleting version");

    await this.client.request<unknown>(
      `/projects/v1/admin/${projectId}/versions/${versionId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "deleting version",
      },
    );
  }

  /** Inspect a published app by version id. Public — no auth. */
  async getApp(versionId: string): Promise<AppDetails> {
    return this.client.request<AppDetails>(`/apps/v1/${versionId}`, {
      context: "fetching app details",
      withAuth: false,
    });
  }
}

// ─── bundleDeploy compat shim helpers ────────────────────────────────────────

async function translateBundleToReleaseSpec(
  projectId: string,
  opts: BundleDeployOptions,
): Promise<ReleaseSpec> {
  const spec: ReleaseSpec = { project: projectId };

  // database (migrations + expose translation)
  if (opts.migrations !== undefined || opts.rls !== undefined) {
    spec.database = {};
    if (opts.migrations !== undefined && opts.migrations.trim().length > 0) {
      const sqlBytes = new TextEncoder().encode(opts.migrations);
      const fullSha = await sha256Hex(sqlBytes);
      const id = `bundle_legacy_${fullSha.slice(0, 16)}`;
      spec.database.migrations = [
        {
          id,
          checksum: fullSha,
          sql: opts.migrations,
        },
      ];
    }
    if (opts.rls !== undefined) {
      if (
        typeof opts.rls !== "object" ||
        opts.rls === null ||
        !Array.isArray((opts.rls as { tables?: unknown }).tables)
      ) {
        throw new Run402DeployError(
          `bundleDeploy: opts.rls must be { template, tables[] } (got ${typeof opts.rls})`,
          {
            code: "INVALID_SPEC",
            phase: "validate",
            resource: "rls",
            retryable: false,
            fix: { action: "set_field", path: "rls" },
            context: "translating bundle to release spec",
          },
        );
      }
      spec.database.expose = translateRlsToExpose(opts.rls);
    }
  }

  // secrets — legacy in-memory values are pre-written by bundleDeploy();
  // the value-free release spec only declares required keys.
  if (opts.secrets !== undefined && opts.secrets.length > 0) {
    spec.secrets = { require: opts.secrets.map(({ key }) => key) };
  }

  // functions — array → replace map
  if (opts.functions !== undefined && opts.functions.length > 0) {
    const replace: Record<string, FunctionSpec> = {};
    for (const fn of opts.functions) {
      const f: FunctionSpec = {
        runtime: "node22",
        source: fn.code,
      };
      if (fn.config) f.config = mapFunctionConfig(fn.config);
      if (fn.schedule !== undefined) f.schedule = fn.schedule ?? null;
      replace[fn.name] = f;
    }
    spec.functions = { replace };
  }

  // files — base64-decoded inline bytes → site.replace FileSet
  if (opts.files !== undefined && opts.files.length > 0) {
    const fileMap: Record<string, ContentSource> = {};
    for (const f of opts.files) {
      fileMap[f.file] = decodeSiteFile(f);
    }
    spec.site = { replace: fileMap };
  }

  // subdomain string → subdomains.set [string]
  if (opts.subdomain !== undefined && opts.subdomain.length > 0) {
    spec.subdomains = { set: [opts.subdomain] };
  }

  return spec;
}

function decodeSiteFile(f: SiteFile): ContentSource {
  if (f.encoding === "base64") {
    const bytes = base64ToBytes(f.data);
    return { data: bytes };
  }
  return f.data;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mapFunctionConfig(
  cfg: { timeout?: number; memory?: number },
): { timeoutSeconds?: number; memoryMb?: number } {
  const out: { timeoutSeconds?: number; memoryMb?: number } = {};
  if (typeof cfg.timeout === "number") out.timeoutSeconds = cfg.timeout;
  if (typeof cfg.memory === "number") out.memoryMb = cfg.memory;
  return out;
}

interface ManifestTableV1 {
  name: string;
  expose: true;
  policy: RlsTemplate;
  owner_column?: string;
  i_understand_this_is_unrestricted?: true;
}

function translateRlsToExpose(
  rls: { template: RlsTemplate; tables: RlsTableSpec[]; i_understand_this_is_unrestricted?: boolean },
): ExposeManifest {
  const tables: ManifestTableV1[] = rls.tables.map((t) => {
    const out: ManifestTableV1 = {
      name: t.table,
      expose: true,
      policy: rls.template,
    };
    if (t.owner_column) out.owner_column = t.owner_column;
    if (
      rls.template === "public_read_write_UNRESTRICTED" &&
      rls.i_understand_this_is_unrestricted
    ) {
      out.i_understand_this_is_unrestricted = true;
    }
    return out;
  });
  return {
    version: "1",
    tables: tables as unknown as Array<Record<string, unknown>>,
    views: [],
    rpcs: [],
  };
}

function reshapeAsBundleResult(
  projectId: string,
  result: DeployResult,
): BundleDeployResult {
  const urls = result.urls ?? {};
  const out: BundleDeployResult = { project_id: projectId };
  if (result.warnings.length > 0) out.warnings = result.warnings;
  if (urls.site) out.site_url = urls.site;
  if (urls.deployment_id) out.deployment_id = urls.deployment_id;
  if (urls.subdomain) out.subdomain_url = urls.subdomain;
  if (urls.functions) {
    try {
      const parsed = JSON.parse(urls.functions);
      if (Array.isArray(parsed)) out.functions = parsed;
    } catch {
      /* not a structured payload — skip */
    }
  }
  return out;
}

function validateBundleSecrets(secrets: Array<{ key: string; value: string }>): void {
  const seen = new Set<string>();
  for (const secret of secrets) {
    const key = secret?.key;
    const value = secret?.value;
    if (typeof key !== "string" || !SECRET_KEY_RE.test(key)) {
      throw new Run402DeployError(
        `bundleDeploy secret keys must match ${SECRET_KEY_RE.source}`,
        {
          code: "INVALID_SPEC",
          phase: "validate",
          resource: "secrets",
          retryable: false,
          fix: { action: "set_field", path: "secrets" },
          context: "validating bundle deploy secrets",
        },
      );
    }
    if (seen.has(key)) {
      throw new Run402DeployError(`bundleDeploy secret ${key} is duplicated`, {
        code: "INVALID_SPEC",
        phase: "validate",
        resource: "secrets",
        retryable: false,
        fix: { action: "set_field", path: "secrets" },
        context: "validating bundle deploy secrets",
      });
    }
    if (typeof value !== "string") {
      throw new Run402DeployError(`bundleDeploy secret ${key} value must be a string`, {
        code: "INVALID_SPEC",
        phase: "validate",
        resource: `secrets.${key}`,
        retryable: false,
        fix: { action: "set_field", path: `secrets.${key}` },
        context: "validating bundle deploy secrets",
      });
    }
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > SECRET_VALUE_LIMIT_BYTES) {
      throw new Run402DeployError(
        `bundleDeploy secret ${key} is ${bytes} bytes; maximum is ${SECRET_VALUE_LIMIT_BYTES} UTF-8 bytes`,
        {
          code: "INVALID_SPEC",
          phase: "validate",
          resource: `secrets.${key}`,
          retryable: false,
          fix: { action: "set_field", path: `secrets.${key}` },
          context: "validating bundle deploy secrets",
        },
      );
    }
    seen.add(key);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
