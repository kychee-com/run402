/**
 * `domains` namespace — custom domains (BYODomain) mapped to run402
 * subdomains. Manages the registration/verification lifecycle and DNS
 * instructions surfaced back to the user's DNS provider.
 */

import type { Client } from "../kernel.js";
import { ProjectNotFound } from "../errors.js";

export interface DnsInstructions {
  cname_target?: string;
  txt_name?: string;
  txt_value?: string;
}

export interface CustomDomainAddResult {
  domain: string;
  subdomain_name: string;
  url: string;
  subdomain_url: string;
  status: string;
  dns_instructions: DnsInstructions | null;
  project_id: string | null;
  created_at: string;
}

export interface CustomDomainSummary {
  domain: string;
  subdomain_name: string;
  url: string;
  subdomain_url: string;
  status: string;
  created_at: string;
}

export interface CustomDomainListResult {
  domains: CustomDomainSummary[];
}

export interface CustomDomainStatusResult {
  domain: string;
  subdomain_name: string;
  url: string;
  subdomain_url: string;
  status: string;
  dns_instructions: DnsInstructions | null;
  created_at: string;
}

export interface CustomDomainRemoveOptions {
  projectId?: string;
}

export interface CustomDomainRemoveResult {
  status: string;
  domain: string;
}

export class Domains {
  constructor(private readonly client: Client) {}

  /** Register a custom domain. Returns DNS records the user must add at their DNS provider. */
  async add(
    projectId: string,
    domain: string,
    subdomainName: string,
  ): Promise<CustomDomainAddResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "registering custom domain");

    return this.client.request<CustomDomainAddResult>("/domains/v1", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: { domain, subdomain_name: subdomainName },
      context: "registering custom domain",
    });
  }

  /** List all custom domains registered for a project. */
  async list(projectId: string): Promise<CustomDomainListResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing custom domains");

    return this.client.request<CustomDomainListResult>("/domains/v1", {
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "listing custom domains",
    });
  }

  /** Check verification/SSL status for a specific custom domain. */
  async status(projectId: string, domain: string): Promise<CustomDomainStatusResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "checking domain status");

    return this.client.request<CustomDomainStatusResult>(
      `/domains/v1/${encodeURIComponent(domain)}`,
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "checking domain status",
      },
    );
  }

  /** Release a custom domain. `projectId` is optional for ownership-free removal. */
  async remove(
    domain: string,
    opts: CustomDomainRemoveOptions = {},
  ): Promise<CustomDomainRemoveResult> {
    const headers: Record<string, string> = {};
    if (opts.projectId) {
      const project = await this.client.getProject(opts.projectId);
      if (!project) throw new ProjectNotFound(opts.projectId, "removing custom domain");
      headers.Authorization = `Bearer ${project.service_key}`;
    }

    return this.client.request<CustomDomainRemoveResult>(
      `/domains/v1/${encodeURIComponent(domain)}`,
      {
        method: "DELETE",
        headers,
        context: "removing custom domain",
      },
    );
  }
}
