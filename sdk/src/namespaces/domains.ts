/**
 * `domains` namespace — custom domains (BYODomain) mapped to run402
 * subdomains. Manages the registration/verification lifecycle and DNS
 * instructions surfaced back to the user's DNS provider.
 */

import type { Client } from "../kernel.js";
import { deprecatePositional } from "../deprecate.js";
import { requireProjectCredentials } from "../project-credentials.js";

export type DomainAuthMode = "principal" | "service_key";

export interface DomainAddOptions {
  domain: string;
  subdomainName: string;
  authMode?: DomainAuthMode;
}

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
  authMode?: DomainAuthMode;
}

export interface CustomDomainRemoveResult {
  status: string;
  domain: string;
}

export interface DomainRequestOptions {
  authMode?: DomainAuthMode;
}

function withProjectId(path: string, projectId: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}project_id=${encodeURIComponent(projectId)}`;
}

export class Domains {
  constructor(private readonly client: Client) {}

  /** Register a custom domain. Returns DNS records the user must add at their DNS provider. */
  async add(projectId: string, opts: DomainAddOptions): Promise<CustomDomainAddResult>;
  /** @deprecated Two same-type strings are swap-prone. Use `add(projectId, { domain, subdomainName })`. */
  async add(projectId: string, domain: string, subdomainName: string): Promise<CustomDomainAddResult>;
  async add(
    projectId: string,
    domainOrOpts: string | DomainAddOptions,
    subdomainName?: string,
  ): Promise<CustomDomainAddResult> {
    let domain: string;
    let subdomain: string;
    let authMode: DomainAuthMode | undefined;
    if (typeof domainOrOpts === "object" && domainOrOpts !== null) {
      domain = domainOrOpts.domain;
      subdomain = domainOrOpts.subdomainName;
      authMode = domainOrOpts.authMode;
    } else {
      deprecatePositional("domains.add", "use add(projectId, { domain, subdomainName })");
      domain = domainOrOpts;
      subdomain = subdomainName as string;
    }

    if (authMode === "service_key") {
      const project = await requireProjectCredentials(this.client, projectId, "registering custom domain");
      return this.client.request<CustomDomainAddResult>("/domains/v1", {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body: { domain, subdomain_name: subdomain },
        context: "registering custom domain",
      });
    }

    return this.client.request<CustomDomainAddResult>("/domains/v1", {
      method: "POST",
      body: { project_id: projectId, domain, subdomain_name: subdomain },
      context: "registering custom domain",
    });
  }

  /** List all custom domains registered for a project. */
  async list(projectId: string, opts: DomainRequestOptions = {}): Promise<CustomDomainListResult> {
    if (opts.authMode === "service_key") {
      const project = await requireProjectCredentials(this.client, projectId, "listing custom domains");
      return this.client.request<CustomDomainListResult>("/domains/v1", {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "listing custom domains",
      });
    }

    return this.client.request<CustomDomainListResult>(withProjectId("/domains/v1", projectId), {
      context: "listing custom domains",
    });
  }

  /** Check verification/SSL status for a specific custom domain. */
  async status(projectId: string, domain: string, opts: DomainRequestOptions = {}): Promise<CustomDomainStatusResult> {
    if (opts.authMode === "service_key") {
      const project = await requireProjectCredentials(this.client, projectId, "checking domain status");
      return this.client.request<CustomDomainStatusResult>(
        `/domains/v1/${encodeURIComponent(domain)}`,
        {
          headers: { Authorization: `Bearer ${project.service_key}` },
          context: "checking domain status",
        },
      );
    }

    return this.client.request<CustomDomainStatusResult>(
      withProjectId(`/domains/v1/${encodeURIComponent(domain)}`, projectId),
      {
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
    if (opts.projectId && opts.authMode === "service_key") {
      const project = await requireProjectCredentials(this.client, opts.projectId, "removing custom domain");
      headers.Authorization = `Bearer ${project.service_key}`;
    }
    const path = opts.projectId && opts.authMode !== "service_key"
      ? withProjectId(`/domains/v1/${encodeURIComponent(domain)}`, opts.projectId)
      : `/domains/v1/${encodeURIComponent(domain)}`;

    return this.client.request<CustomDomainRemoveResult>(
      path,
      {
        method: "DELETE",
        headers,
        context: "removing custom domain",
      },
    );
  }
}
