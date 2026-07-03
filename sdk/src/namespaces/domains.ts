/**
 * `domains` namespace — ProjectDomain lifecycle.
 *
 * Domain operations are project-scoped control-plane actions. They use the
 * SDK credential provider's server auth (SIWX, control-plane session, or
 * delegate) and deliberately do not require local project-key cache entries.
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";

export type ProjectDomainStatus = "action_required" | "waiting" | "active" | "needs_repair" | "failed";
export type ProjectDomainReceiveStrategy = "auto" | "outbound_only" | "forwarding_mode" | "subdomain_mode" | "full_receive_takeover";
export type ProjectDomainMailboxAddressMode = "primary" | "alias" | "managed" | "none";
export type ProjectDomainActivationMode = "automatic_when_ready" | "manual";
export type ProjectDomainWaitUntil = "active" | "safe" | "receive-active";

export interface ProjectDomainMailboxAddressBinding {
  local_part: string;
  mailbox_slug: string;
  create_mailbox?: boolean;
}

export interface ProjectDomainDesired {
  web?: {
    enabled: boolean;
    target?: string;
    role?: "primary" | "alias";
  };
  email?: {
    send?: { enabled: boolean };
    receive?: {
      enabled: boolean;
      strategy?: ProjectDomainReceiveStrategy;
      resolved_strategy?: ProjectDomainReceiveStrategy;
      observed_mx_fingerprint?: string;
      mail_subdomain?: string;
    };
    mailbox_addresses?: {
      mode: ProjectDomainMailboxAddressMode;
      addresses: ProjectDomainMailboxAddressBinding[];
    };
    activation?: ProjectDomainActivationMode;
  };
}

export interface ProjectDomainCheck {
  id: string;
  status: "unknown" | "pending" | "passed" | "failed" | "drifted" | "blocked";
  blocking: boolean;
  reason_code?: string;
  summary?: string;
  blocked_by?: string[];
  checked_at?: string;
}

export interface ProjectDomainDnsRecord {
  id: string;
  purpose: string;
  type: string;
  name: string;
  value: string;
  priority?: number;
  required: boolean;
  status: "unknown" | "missing" | "present" | "conflict";
  safety: {
    safe_to_auto_run: boolean;
    confirmation_required: boolean;
    destructive: boolean;
    external_required: boolean;
    conflict_policy?: string;
    [key: string]: unknown;
  };
  bind?: string;
}

export interface ProjectDomainNextAction {
  type: string;
  method?: string;
  path?: string;
  auth?: string;
  why?: string;
  safe_to_auto_run?: boolean;
  destructive?: boolean;
  confirmation_required?: boolean;
  external_required?: boolean;
  affected_record_ids?: string[];
  [key: string]: unknown;
}

export interface ProjectDomainReceiveTest {
  id: string;
  local_part: string;
  address: string;
  target_managed_address: string;
  token: string;
  status: "pending" | "passed" | "failed" | "stale";
  created_at: string;
  passed_at?: string | null;
}

export interface ProjectDomain {
  project_id: string;
  domain: string;
  status: ProjectDomainStatus;
  desired: ProjectDomainDesired;
  observed: Record<string, unknown>;
  effective: Record<string, unknown>;
  authority: {
    recommended_mode: string;
    options: Array<Record<string, unknown>>;
  };
  dns_records: ProjectDomainDnsRecord[];
  checks: ProjectDomainCheck[];
  next_action: ProjectDomainNextAction | null;
  alternate_actions: ProjectDomainNextAction[];
  provenance: {
    project: "server_control_plane";
    desired: "server_control_plane";
    observed_dns: "public_dns_resolvers";
    effective: "run402_control_plane";
    local_cache: "not_used";
  };
  created_at?: string;
  updated_at?: string;
}

export interface ProjectDomainListResult {
  domains: ProjectDomain[];
}

export interface ProjectDomainEnsureOptions {
  desired: ProjectDomainDesired;
}

export interface ProjectDomainTestReceiveResult extends ProjectDomain {
  receive_test: ProjectDomainReceiveTest;
}

export interface ProjectDomainWaitOptions {
  until?: ProjectDomainWaitUntil;
  timeoutMs?: number;
  intervalMs?: number;
}

export type DomainAddOptions = {
  domain: string;
  subdomainName?: string;
};

export type DomainRequestOptions = Record<string, never>;
export type CustomDomainRemoveOptions = { projectId?: string };

function domainPath(projectId: string, domain: string): string {
  return `/projects/v1/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`;
}

function authMeta(method: string, projectId: string) {
  return { method, target: { project_id: projectId } };
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

function waitSatisfied(domain: ProjectDomain, until: ProjectDomainWaitUntil): boolean {
  if (until === "active") return domain.status === "active";
  if (until === "receive-active") {
    const email = domain.effective.email as { receive?: { active?: unknown } } | undefined;
    return email?.receive?.active === true;
  }
  return domain.checks.every((check) => !check.blocking || check.status === "passed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Domains {
  constructor(private readonly client: Client) {}

  async ensure(projectId: string, domain: string, opts: ProjectDomainEnsureOptions): Promise<ProjectDomain> {
    return this.client.request<ProjectDomain>(domainPath(projectId, domain), {
      method: "PUT",
      body: { desired: opts.desired },
      authMeta: authMeta("domains.ensure", projectId),
      context: "ensuring project domain",
    });
  }

  async get(projectId: string, domain: string): Promise<ProjectDomain> {
    return this.client.request<ProjectDomain>(domainPath(projectId, domain), {
      authMeta: authMeta("domains.get", projectId),
      context: "getting project domain",
    });
  }

  async list(projectId: string): Promise<ProjectDomainListResult> {
    return this.client.request<ProjectDomainListResult>(
      `/projects/v1/${encodeURIComponent(projectId)}/domains`,
      {
        authMeta: authMeta("domains.list", projectId),
        context: "listing project domains",
      },
    );
  }

  async check(projectId: string, domain: string): Promise<ProjectDomain> {
    return this.client.request<ProjectDomain>(`${domainPath(projectId, domain)}/actions/check`, {
      method: "POST",
      authMeta: authMeta("domains.check", projectId),
      context: "checking project domain",
    });
  }

  async apply(projectId: string, domain: string): Promise<ProjectDomain> {
    return this.client.request<ProjectDomain>(`${domainPath(projectId, domain)}/actions/apply`, {
      method: "POST",
      authMeta: authMeta("domains.apply", projectId),
      context: "applying project domain",
    });
  }

  async repair(projectId: string, domain: string): Promise<ProjectDomain> {
    return this.client.request<ProjectDomain>(`${domainPath(projectId, domain)}/actions/repair`, {
      method: "POST",
      authMeta: authMeta("domains.repair", projectId),
      context: "repairing project domain",
    });
  }

  async testReceive(projectId: string, domain: string, to: string): Promise<ProjectDomainTestReceiveResult> {
    return this.client.request<ProjectDomainTestReceiveResult>(`${domainPath(projectId, domain)}/actions/test_receive`, {
      method: "POST",
      body: { to },
      authMeta: authMeta("domains.testReceive", projectId),
      context: "creating project domain receive test",
    });
  }

  async activate(projectId: string, domain: string): Promise<ProjectDomain> {
    return this.client.request<ProjectDomain>(`${domainPath(projectId, domain)}/actions/activate_mailbox_addresses`, {
      method: "POST",
      authMeta: authMeta("domains.activate", projectId),
      context: "activating project domain mailbox addresses",
    });
  }

  async disconnect(projectId: string, domain: string): Promise<{ status: string; domain: string }> {
    return this.client.request<{ status: string; domain: string }>(domainPath(projectId, domain), {
      method: "DELETE",
      authMeta: authMeta("domains.disconnect", projectId),
      context: "disconnecting project domain",
    });
  }

  async wait(projectId: string, domain: string, opts: ProjectDomainWaitOptions = {}): Promise<ProjectDomain> {
    const until = opts.until ?? "active";
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const intervalMs = opts.intervalMs ?? 5_000;
    const started = Date.now();
    let last = await this.check(projectId, domain);
    while (!waitSatisfied(last, until)) {
      if (Date.now() - started >= timeoutMs) {
        throw new LocalError(
          `Timed out waiting for project domain ${domain} to reach ${until}`,
          "waiting for project domain",
          {
            code: "DOMAIN_WAIT_TIMEOUT",
            details: { project_id: projectId, domain, until, last_status: last.status, checks: last.checks },
            next_actions: [{ type: "check", command: `run402 domains check ${domain} --project ${projectId}` }],
          },
        );
      }
      await sleep(intervalMs);
      last = await this.check(projectId, domain);
    }
    return last;
  }

  /** @deprecated Removed. Use ensure(projectId, domain, { desired }). */
  async add(projectId: string, opts: DomainAddOptions): Promise<never>;
  /** @deprecated Removed. Use ensure(projectId, domain, { desired }). */
  async add(projectId: string, domain: string, subdomainName: string): Promise<never>;
  async add(projectId: string, domainOrOpts: string | DomainAddOptions): Promise<never> {
    const domain = typeof domainOrOpts === "string" ? domainOrOpts : domainOrOpts.domain;
    return removed("domains.add", `run402 domains connect ${domain} --project ${projectId} --web`);
  }

  /** @deprecated Removed. Use get(projectId, domain). */
  async status(projectId: string, domain: string): Promise<never> {
    return removed("domains.status", `run402 domains status ${domain} --project ${projectId}`);
  }

  /** @deprecated Removed. Use disconnect(projectId, domain). */
  async remove(domain: string, opts: CustomDomainRemoveOptions = {}): Promise<never> {
    return removed("domains.remove", `run402 domains disconnect ${domain}${opts.projectId ? ` --project ${opts.projectId}` : ""} --confirm`);
  }
}
