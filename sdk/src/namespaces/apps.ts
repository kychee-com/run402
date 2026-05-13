/**
 * `apps` namespace — marketplace browse/fork and app version publishing.
 */

import type { Client } from "../kernel.js";
import { ProjectNotFound } from "../errors.js";
import type { ProjectTier } from "./projects.types.js";

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
