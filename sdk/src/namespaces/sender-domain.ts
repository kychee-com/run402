/**
 * `senderDomain` namespace — removed compatibility shim.
 *
 * Sender-domain APIs are now folded into the project-scoped ProjectDomain
 * lifecycle under `domains`. Methods remain present so existing imports fail
 * loudly and locally with a replacement path instead of calling retired
 * `/email/v1/domains` endpoints.
 */

import { LocalError } from "../errors.js";

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

  constructor(_client: unknown) {
    this.inboundEnable = this.enableInbound.bind(this);
    this.inboundDisable = this.disableInbound.bind(this);
  }

  /** @deprecated Use `domains.ensure(projectId, domain, { desired })`. */
  async register(projectId: string, domain: string): Promise<SenderDomainRegisterResult> {
    return removed(
      "senderDomain.register",
      `run402 domains connect ${domain} --project ${projectId} --email-send`,
    );
  }

  /** @deprecated Use `domains.list(projectId)` or `domains.get(projectId, domain)`. */
  async status(projectId: string): Promise<SenderDomainStatusResult> {
    return removed(
      "senderDomain.status",
      `run402 domains list --project ${projectId}`,
    );
  }

  /** @deprecated Use `domains.disconnect(projectId, domain)`. */
  async remove(projectId: string): Promise<void> {
    return removed(
      "senderDomain.remove",
      `run402 domains disconnect <domain> --project ${projectId} --confirm`,
    );
  }

  /** @deprecated Use `domains.ensure(..., { desired: { email: { receive: ... }}})`. */
  async enableInbound(projectId: string, domain: string): Promise<InboundEnableResult> {
    return removed(
      "senderDomain.enableInbound",
      `run402 domains connect ${domain} --project ${projectId} --email-receive`,
    );
  }

  /** @deprecated Use `domains.ensure` with receive disabled or `domains.disconnect`. */
  async disableInbound(projectId: string, domain: string): Promise<DisableInboundResult> {
    return removed(
      "senderDomain.disableInbound",
      `run402 domains disconnect ${domain} --project ${projectId} --confirm`,
    );
  }
}

function removed(command: string, replacement: string): never {
  throw new LocalError(
    `${command} has been removed. Use ${replacement}.`,
    command,
    {
      code: "COMMAND_REMOVED",
      details: { command, replacement },
      next_actions: [{ type: "use_replacement_command", command: replacement }],
    },
  );
}
