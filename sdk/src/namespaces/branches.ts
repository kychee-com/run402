import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  ProjectBranchCreateOptions,
  ProjectBranchCreateResult,
  ProjectBranchDto,
  ProjectBranchesListResult,
  ProjectBranchRenewOptions,
} from "./branches.types.js";

export class Branches {
  constructor(private readonly client: Client) {}

  async create(projectId: string, opts: ProjectBranchCreateOptions = {}): Promise<ProjectBranchCreateResult> {
    assertProjectId(projectId, "creating project branch");
    const body: Record<string, unknown> = {};
    if (opts.fromSnapshotId !== undefined) body.from_snapshot_id = opts.fromSnapshotId;
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.emailMode !== undefined) body.email_mode = opts.emailMode;
    if (opts.enableCron !== undefined) body.enable_cron = opts.enableCron;
    if (opts.ttlDays !== undefined) body.ttl_days = opts.ttlDays;
    const result = await this.client.request<ProjectBranchCreateResult>(branchCollectionPath(projectId), {
      method: "POST",
      body,
      authMeta: {
        method: "branches.create",
        capability: "project.branches.manage",
        target: { project_id: projectId },
      },
      context: "creating project branch",
    });
    if (this.client.credentials.saveProject) {
      await this.client.credentials.saveProject(result.branch_project_id, {
        anon_key: result.anon_key,
        service_key: result.service_key,
        ...(result.branch_url ? { site_url: result.branch_url } : {}),
      });
    }
    return result;
  }

  async list(projectId: string): Promise<ProjectBranchesListResult> {
    assertProjectId(projectId, "listing project branches");
    return this.client.request<ProjectBranchesListResult>(branchCollectionPath(projectId), {
      authMeta: {
        method: "branches.list",
        capability: "project.branches.manage",
        target: { project_id: projectId },
      },
      context: "listing project branches",
    });
  }

  async renew(projectId: string, branchProjectId: string, opts: ProjectBranchRenewOptions = {}): Promise<ProjectBranchDto> {
    assertProjectId(projectId, "renewing project branch");
    assertProjectId(branchProjectId, "renewing project branch");
    const body: Record<string, unknown> = {};
    if (opts.ttlDays !== undefined) body.ttl_days = opts.ttlDays;
    return this.client.request<ProjectBranchDto>(`${branchPath(projectId, branchProjectId)}/renew`, {
      method: "POST",
      body,
      authMeta: {
        method: "branches.renew",
        capability: "project.branches.manage",
        target: { project_id: projectId },
      },
      context: "renewing project branch",
    });
  }

  async delete(projectId: string, branchProjectId: string): Promise<void> {
    assertProjectId(projectId, "deleting project branch");
    assertProjectId(branchProjectId, "deleting project branch");
    await this.client.request<unknown>(branchPath(projectId, branchProjectId), {
      method: "DELETE",
      authMeta: {
        method: "branches.delete",
        capability: "project.branches.manage",
        target: { project_id: projectId },
      },
      context: "deleting project branch",
    });
  }
}

function branchCollectionPath(projectId: string): string {
  return `/projects/v1/${encodeURIComponent(projectId)}/branches`;
}

function branchPath(projectId: string, branchProjectId: string): string {
  return `${branchCollectionPath(projectId)}/${encodeURIComponent(branchProjectId)}`;
}

function assertProjectId(value: string, context: string): void {
  if (!value || typeof value !== "string") {
    throw new LocalError("branches helper requires a projectId", context);
  }
}
