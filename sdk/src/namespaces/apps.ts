/**
 * `apps` namespace — bundle deploy, marketplace browse/fork, and app
 * version publishing.
 */

import type { Client } from "../kernel.js";
import { ProjectNotFound } from "../errors.js";
import type { RlsTemplate, RlsTableSpec } from "./projects.types.js";
import type { SiteFile } from "./sites.js";

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
}

export interface AppSummary {
  id: string;
  project_name: string;
  description: string | null;
  tags: string[];
  fork_allowed: boolean;
  fork_pricing?: Record<string, string>;
  created_at: string;
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

export interface PublishedVersion {
  id: string;
  project_id: string;
  project_name: string;
  description: string | null;
  tags: string[];
  visibility: string;
  fork_allowed: boolean;
  created_at: string;
}

export interface VersionSummary {
  id: string;
  description: string | null;
  tags: string[];
  visibility: string;
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

export interface AppDetails {
  id: string;
  project_name: string;
  description: string | null;
  tags: string[];
  fork_allowed: boolean;
  min_tier: string;
  table_count: number;
  function_count: number;
  site_file_count: number;
  required_secrets: Array<{ key: string; description: string }>;
  created_at: string;
}

export class Apps {
  constructor(private readonly client: Client) {}

  /**
   * Deploy to an existing project: runs migrations, applies RLS, sets
   * secrets, deploys functions, deploys a static site, and claims a
   * subdomain. Payment flows through x402 when the project lease needs
   * renewal.
   */
  async bundleDeploy(projectId: string, opts: BundleDeployOptions = {}): Promise<BundleDeployResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deploying bundle");

    const body: Record<string, unknown> = { project_id: projectId };
    if (opts.migrations !== undefined) body.migrations = opts.migrations;
    if (opts.rls !== undefined) body.rls = opts.rls;
    if (opts.secrets !== undefined) body.secrets = opts.secrets;
    if (opts.functions !== undefined) body.functions = opts.functions;
    if (opts.files !== undefined) body.files = opts.files;
    if (opts.subdomain !== undefined) body.subdomain = opts.subdomain;
    if (opts.inherit) body.inherit = true;

    return this.client.request<BundleDeployResult>("/deploy/v1", {
      method: "POST",
      body,
      context: "deploying bundle",
    });
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
