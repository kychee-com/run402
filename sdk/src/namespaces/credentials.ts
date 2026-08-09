/**
 * `credentials` namespace — TWO surfaces that must not be confused.
 *
 *   r.credentials.<verb>              the GATEWAY's project credentials
 *   r.credentials.projectKeys.<verb>  the LOCAL key cache on this machine
 *
 * A **project credential** (`r402_…`) is a ROW on the gateway: named, listable,
 * expiring, individually revocable, and several may be live per kind at once —
 * that overlap IS zero-downtime rotation. It is the replacement for the legacy
 * `anon_key` / `service_key`, which are DERIVED from the platform signing key,
 * never expire, and cannot be revoked one at a time. The signing key behind the
 * legacy pair is being retired.
 *
 * These methods existed on the gateway and in the OpenAPI document with no
 * client at all, so an agent that wanted off the legacy keys had to hand-roll a
 * SIWX-signed request — which is exactly the "hidden manual step" the project
 * exists to remove. `r.credentials.status()` is the one to poll; it answers
 * "am I still on the retiring key" without any privileged role.
 *
 * The secret is returned EXACTLY ONCE, from `issue()` / `rotate()` /
 * `mintToken()`. There is no read that returns it. Never write one of these
 * responses to a result cache, tmp file, or expansion handle.
 */
import type { ProjectCredentialCacheInfo, ProjectKeys } from "../credentials.js";
import { LocalError } from "../errors.js";
import type { Client } from "../kernel.js";
import { requireProjectCredentials } from "../project-credentials.js";
import type {
  IssueProjectCredentialInput,
  ProjectCredentialIssued,
  ProjectCredentialListResult,
  ProjectCredentialRecord,
  ProjectCredentialRevoked,
  ProjectCredentialStatus,
  ProjectTokenIssued,
  ProjectCredentialKind,
} from "./credentials.types.js";

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
  /** The LOCAL key cache on this machine. Not project inventory. */
  readonly projectKeys: ProjectKeysCache;

  constructor(private readonly client: Client) {
    this.projectKeys = new ProjectKeysCache(client);
  }

  /**
   * Issue a named project credential
   * (`POST /projects/v1/:project_id/credentials`).
   *
   * Requires owner membership on the project's owning org PLUS a fresh
   * step-up, and a delegate can never satisfy it — a scoped agent credential
   * must not be able to escalate itself into a permanent root. If you are
   * running unattended and hold only a delegate, use {@link mintToken}.
   *
   * The returned `secret` is shown ONCE. Persist it before doing anything
   * else; there is no read that returns it, only `rotate()` for a new one.
   */
  async issue(projectId: string, input: IssueProjectCredentialInput): Promise<ProjectCredentialIssued> {
    if (!projectId) {
      throw new LocalError("credentials.issue requires a projectId", "issuing project credential");
    }
    if (input?.kind !== "anon" && input?.kind !== "service") {
      throw new LocalError(
        'credentials.issue requires { kind: "anon" | "service" }',
        "issuing project credential",
        { code: "BAD_USAGE", details: { project_id: projectId } },
      );
    }
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new LocalError(
        "credentials.issue requires a non-empty { name } — it is how you identify and rotate this credential later",
        "issuing project credential",
        { code: "BAD_USAGE", details: { project_id: projectId } },
      );
    }
    const body: Record<string, unknown> = { kind: input.kind, name: input.name.trim() };
    if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;
    return this.client.request<ProjectCredentialIssued>(
      `/projects/v1/${encodeURIComponent(projectId)}/credentials`,
      { method: "POST", body, context: "issuing project credential" },
    );
  }

  /**
   * List a project's credentials (`GET /projects/v1/:project_id/credentials`).
   * Metadata only — never a secret or a secret hash. `project.read` is enough.
   */
  async list(
    projectId: string,
    opts: { includeRevoked?: boolean } = {},
  ): Promise<ProjectCredentialListResult> {
    if (!projectId) {
      throw new LocalError("credentials.list requires a projectId", "listing project credentials");
    }
    const qs = opts.includeRevoked ? "?include_revoked=true" : "";
    return this.client.request<ProjectCredentialListResult>(
      `/projects/v1/${encodeURIComponent(projectId)}/credentials${qs}`,
      { method: "GET", context: "listing project credentials" },
    );
  }

  /**
   * Rotation posture (`GET /projects/v1/:project_id/credential-status`) — the
   * surface to poll deliberately, rather than waiting to notice the
   * `X-Run402-Key-Rotation` advisory header.
   *
   * `state: "legacy"` means the project still depends on the derived
   * anon/service keys signed by the retiring platform key. Only `project.read`
   * is required: knowing you should rotate is not a privileged act, and gating
   * it behind the owner role would hide the warning from the automation that
   * most needs it.
   */
  async status(projectId: string): Promise<ProjectCredentialStatus> {
    if (!projectId) {
      throw new LocalError("credentials.status requires a projectId", "reading credential status");
    }
    return this.client.request<ProjectCredentialStatus>(
      `/projects/v1/${encodeURIComponent(projectId)}/credential-status`,
      { method: "GET", context: "reading credential status" },
    );
  }

  /**
   * Rotate a credential
   * (`POST /projects/v1/:project_id/credentials/:credential_id/rotate`) — mint
   * a replacement and revoke the old one in a single transaction, keeping the
   * name and recording `replacement_of`.
   *
   * For a rotation with NO downtime window, prefer `issue()` a second live
   * credential, deploy it, then `revoke()` the first: several credentials may
   * be live per kind at once, and that overlap is the whole point. `rotate()`
   * is the right call when the old secret is already compromised.
   */
  async rotate(projectId: string, credentialId: string): Promise<ProjectCredentialIssued> {
    if (!projectId) {
      throw new LocalError("credentials.rotate requires a projectId", "rotating project credential");
    }
    if (!credentialId) {
      throw new LocalError("credentials.rotate requires a credentialId", "rotating project credential");
    }
    return this.client.request<ProjectCredentialIssued>(
      `/projects/v1/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}/rotate`,
      { method: "POST", context: "rotating project credential" },
    );
  }

  /**
   * Revoke a credential immediately
   * (`DELETE /projects/v1/:project_id/credentials/:credential_id`). Frees the
   * name for reuse. Owner + step-up, same as `issue()`.
   */
  async revoke(
    projectId: string,
    credentialId: string,
    opts: { reason?: string } = {},
  ): Promise<ProjectCredentialRevoked> {
    if (!projectId) {
      throw new LocalError("credentials.revoke requires a projectId", "revoking project credential");
    }
    if (!credentialId) {
      throw new LocalError("credentials.revoke requires a credentialId", "revoking project credential");
    }
    return this.client.request<ProjectCredentialRevoked>(
      `/projects/v1/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}`,
      {
        method: "DELETE",
        ...(opts.reason ? { body: { reason: opts.reason } } : {}),
        context: "revoking project credential",
      },
    );
  }

  /**
   * Mint a SHORT-LIVED project token (`POST /projects/v1/:project_id/tokens`).
   *
   * This is the cold-restart recovery path, and the one credential call a
   * delegate CAN make with no human present: an agent that lost its local
   * state but still holds a delegate gets back to work unattended. There is no
   * step-up, because there is nobody to prompt; what it hands back expires, so
   * it cannot become a durable root.
   *
   * Defaults to `service` — the kind an agent needs to deploy.
   */
  async mintToken(
    projectId: string,
    opts: { kind?: ProjectCredentialKind } = {},
  ): Promise<ProjectTokenIssued> {
    if (!projectId) {
      throw new LocalError("credentials.mintToken requires a projectId", "minting project token");
    }
    return this.client.request<ProjectTokenIssued>(
      `/projects/v1/${encodeURIComponent(projectId)}/tokens`,
      {
        method: "POST",
        body: { kind: opts.kind ?? "service" },
        context: "minting project token",
      },
    );
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
