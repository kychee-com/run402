/**
 * `subdomains` namespace — `*.run402.com` subdomain claims pointing at
 * deployments. `claim` and `delete` accept an optional `projectId` for
 * ownership tracking; `list` requires one.
 */

import type { Client } from "../kernel.js";
import { ProjectNotFound } from "../errors.js";

export interface SubdomainClaimOptions {
  /** Optional project ID. If provided, the SDK sends the project's service key as bearer auth. */
  projectId?: string;
}

export interface SubdomainClaimResult {
  name: string;
  deployment_id: string;
  url: string;
  deployment_url: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubdomainSummary {
  name: string;
  url: string;
  deployment_id: string;
  deployment_url: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}

export interface SubdomainDeleteResult {
  name: string;
  deployment_id: string;
  project_id: string;
  deleted_at: string;
}

export class Subdomains {
  constructor(private readonly client: Client) {}

  /** Claim a subdomain and point it at a deployment. */
  async claim(
    name: string,
    deploymentId: string,
    opts: SubdomainClaimOptions = {},
  ): Promise<SubdomainClaimResult> {
    const headers: Record<string, string> = {};
    if (opts.projectId) {
      const project = await this.client.getProject(opts.projectId);
      if (!project) throw new ProjectNotFound(opts.projectId, "claiming subdomain");
      headers.Authorization = `Bearer ${project.service_key}`;
    }

    return this.client.request<SubdomainClaimResult>("/subdomains/v1", {
      method: "POST",
      headers,
      body: { name, deployment_id: deploymentId },
      context: "claiming subdomain",
    });
  }

  /** Release a subdomain. */
  async delete(
    name: string,
    opts: SubdomainClaimOptions = {},
  ): Promise<SubdomainDeleteResult> {
    const headers: Record<string, string> = {};
    if (opts.projectId) {
      const project = await this.client.getProject(opts.projectId);
      if (!project) throw new ProjectNotFound(opts.projectId, "deleting subdomain");
      headers.Authorization = `Bearer ${project.service_key}`;
    }

    return this.client.request<SubdomainDeleteResult>(
      `/subdomains/v1/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers,
        context: "deleting subdomain",
      },
    );
  }

  /** List all subdomains claimed by a project. */
  async list(projectId: string): Promise<SubdomainSummary[]> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing subdomains");

    // Gateway responds `{ subdomains: [...] }`; unwrap so callers get the
    // array shape the type promises (regression: GH-163).
    const body = await this.client.request<{ subdomains: SubdomainSummary[] }>(
      "/subdomains/v1",
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "listing subdomains",
      },
    );
    return body.subdomains ?? [];
  }
}
