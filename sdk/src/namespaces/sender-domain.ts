/**
 * `senderDomain` namespace — custom email sending domains with DKIM
 * verification and optional inbound routing.
 */

import type { Client } from "../kernel.js";
import { ProjectNotFound } from "../errors.js";

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
}

export interface SenderDomainRegisterResult {
  domain: string;
  status: string;
  dns_records: DnsRecord[];
  instructions: string;
}

export interface SenderDomainStatusResult {
  domain: string | null;
  status?: string;
  verified_at?: string;
}

export interface InboundEnableResult {
  status: string;
  mx_record?: string;
}

export interface DisableInboundResult {
  status: string;
}

export class SenderDomain {
  readonly inboundEnable: (projectId: string, domain: string) => Promise<InboundEnableResult>;
  readonly inboundDisable: (projectId: string, domain: string) => Promise<DisableInboundResult>;

  constructor(private readonly client: Client) {
    this.inboundEnable = this.enableInbound.bind(this);
    this.inboundDisable = this.disableInbound.bind(this);
  }

  /** Register a custom email sending domain. Returns DKIM + SPF/DMARC DNS records. */
  async register(projectId: string, domain: string): Promise<SenderDomainRegisterResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "registering sender domain");

    return this.client.request<SenderDomainRegisterResult>("/email/v1/domains", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: { domain },
      context: "registering sender domain",
    });
  }

  /** Get the project's current sender-domain registration state (polls SES). */
  async status(projectId: string): Promise<SenderDomainStatusResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "checking sender domain status");

    return this.client.request<SenderDomainStatusResult>("/email/v1/domains", {
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "checking sender domain status",
    });
  }

  /** Remove the custom sender domain; email reverts to `@mail.run402.com`. */
  async remove(projectId: string): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "removing sender domain");

    await this.client.request<unknown>("/email/v1/domains", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "removing sender domain",
    });
  }

  /** Enable inbound email on a verified custom sender domain. */
  async enableInbound(projectId: string, domain: string): Promise<InboundEnableResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "enabling inbound email");

    return this.client.request<InboundEnableResult>("/email/v1/domains/inbound", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: { domain },
      context: "enabling inbound email",
    });
  }

  /** Disable inbound email for a custom sender domain. */
  async disableInbound(projectId: string, domain: string): Promise<DisableInboundResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "disabling inbound email");

    return this.client.request<DisableInboundResult>("/email/v1/domains/inbound", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body: { domain },
      context: "disabling inbound email",
    });
  }
}
