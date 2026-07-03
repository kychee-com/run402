import type { ProjectCredentialCacheInfo, ProjectKeys } from "../credentials.js";
import { LocalError } from "../errors.js";
import type { Client } from "../kernel.js";
import { requireProjectCredentials } from "../project-credentials.js";

export interface ProjectKeyCacheStatus extends ProjectCredentialCacheInfo {
  project_id: string;
  configured: boolean;
  has_anon_key: boolean;
  has_service_key: boolean;
  anon_key_prefix: string | null;
  service_key_prefix: string | null;
  anon_key_fingerprint: string | null;
  service_key_fingerprint: string | null;
  site_url: string | null;
  cached_at: string | null;
}

export interface ProjectKeyCacheListResult extends ProjectCredentialCacheInfo {
  projects: ProjectKeyCacheStatus[];
}

export interface ProjectKeyCacheExportOptions {
  /** Required to emit secret key material. */
  reveal?: boolean;
}

export interface ProjectKeyCacheExportResult extends ProjectCredentialCacheInfo, ProjectKeys {
  project_id: string;
  revealed: true;
}

export interface ProjectKeyCacheImportOptions {
  anonKey?: string;
  serviceKey: string;
  siteUrl?: string;
}

export interface ProjectKeyCacheMutationResult extends ProjectKeyCacheStatus {
  imported?: boolean;
  removed?: boolean;
}

export class Credentials {
  readonly projectKeys: ProjectKeysCache;

  constructor(client: Client) {
    this.projectKeys = new ProjectKeysCache(client);
  }
}

export class ProjectKeysCache {
  constructor(private readonly client: Client) {}

  async list(): Promise<ProjectKeyCacheListResult> {
    const listProjectCredentials = this.client.credentials.listProjectCredentials;
    if (!listProjectCredentials) {
      throw unsupported("listing local project-key cache", "listProjectCredentials");
    }
    const entries = await listProjectCredentials.call(this.client.credentials);
    const projects = await Promise.all(
      Object.entries(entries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([projectId, entry]) => redactedEntry(projectId, entry, provenance(this.client))),
    );
    return { projects, ...provenance(this.client) };
  }

  async status(projectId: string): Promise<ProjectKeyCacheStatus> {
    const entry = await this.client.getProjectCredentials(projectId);
    return redactedEntry(projectId, entry, provenance(this.client));
  }

  async import(projectId: string, opts: ProjectKeyCacheImportOptions): Promise<ProjectKeyCacheMutationResult> {
    if (!this.client.credentials.saveProject) {
      throw unsupported("importing local project keys", "saveProject");
    }
    if (!opts || typeof opts !== "object" || typeof opts.serviceKey !== "string" || opts.serviceKey.length === 0) {
      throw new LocalError("credentials.projectKeys.import requires a non-empty serviceKey", "importing local project keys", {
        code: "BAD_USAGE",
        details: { project_id: projectId },
      });
    }
    const existing = await this.client.getProjectCredentials(projectId);
    await this.client.credentials.saveProject(projectId, {
      anon_key: opts.anonKey ?? existing?.anon_key ?? "",
      service_key: opts.serviceKey,
      ...(opts.siteUrl ?? existing?.site_url ? { site_url: opts.siteUrl ?? existing?.site_url } : {}),
      cached_at: new Date().toISOString(),
    });
    const entry = await this.client.getProjectCredentials(projectId);
    return { imported: true, ...(await redactedEntry(projectId, entry, provenance(this.client))) };
  }

  async export(projectId: string, opts: ProjectKeyCacheExportOptions = {}): Promise<ProjectKeyCacheExportResult> {
    if (opts.reveal !== true) {
      throw new LocalError("Exporting full project keys requires { reveal: true }", "exporting local project keys", {
        code: "REVEAL_REQUIRED",
        details: { project_id: projectId, ...provenance(this.client) },
      });
    }
    const keys = await requireProjectCredentials(this.client, projectId, "exporting local project keys");
    return {
      project_id: projectId,
      ...keys,
      ...provenance(this.client),
      revealed: true,
    };
  }

  async remove(projectId: string): Promise<ProjectKeyCacheMutationResult> {
    if (!this.client.credentials.removeProject) {
      throw unsupported("removing local project keys", "removeProject");
    }
    const existed = await this.client.getProjectCredentials(projectId);
    await this.client.credentials.removeProject(projectId);
    return { removed: Boolean(existed), ...(await redactedEntry(projectId, null, provenance(this.client))) };
  }
}

function provenance(client: Client): ProjectCredentialCacheInfo {
  return {
    source: "local_cache",
    ...(client.credentials.getProjectCredentialCacheInfo?.() ?? {}),
  };
}

async function redactedEntry(
  projectId: string,
  entry: ProjectKeys | null,
  info: ProjectCredentialCacheInfo,
): Promise<ProjectKeyCacheStatus> {
  return {
    project_id: projectId,
    configured: Boolean(entry),
    has_anon_key: Boolean(entry?.anon_key),
    has_service_key: Boolean(entry?.service_key),
    anon_key_prefix: prefix(entry?.anon_key),
    service_key_prefix: prefix(entry?.service_key),
    anon_key_fingerprint: await fingerprint(entry?.anon_key),
    service_key_fingerprint: await fingerprint(entry?.service_key),
    site_url: entry?.site_url ?? null,
    cached_at: entry?.cached_at ?? null,
    ...info,
  };
}

function prefix(value: string | undefined): string | null {
  if (!value) return null;
  return `${value.slice(0, 8)}...`;
}

async function fingerprint(value: string | undefined): Promise<string | null> {
  if (!value || !globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function unsupported(context: string, method: string): LocalError {
  return new LocalError(
    `The configured credential provider does not support ${method}(). Use @run402/sdk/node for local project-key cache operations.`,
    context,
    {
      code: "LOCAL_CREDENTIAL_CACHE_UNSUPPORTED",
      details: { method, source: "local_cache" },
    },
  );
}
