export type ProjectBranchEmailMode = "sandbox" | "off";

export interface ProjectBranchNextAction {
  type: string;
  command?: string;
  message: string;
  [key: string]: unknown;
}

export interface ProjectBranchDto {
  branch_project_id: string;
  parent_project_id: string;
  name: string;
  branch_url: string | null;
  subdomain: string | null;
  status: "active" | (string & {});
  email_mode: ProjectBranchEmailMode | (string & {});
  enable_cron: boolean;
  data_from: {
    snapshot_id: string | null;
    captured_at: string | null;
  };
  release: {
    parent_release_id: string | null;
    branch_release_id: string | null;
  };
  expires_at: string;
  created_at: string;
  next_actions: ProjectBranchNextAction[];
}

export interface ProjectBranchCreateOptions {
  fromSnapshotId?: string;
  name?: string;
  emailMode?: ProjectBranchEmailMode;
  enableCron?: boolean;
  ttlDays?: number;
}

export interface ProjectBranchCreateResult extends ProjectBranchDto {
  operation_id: string;
  materialization_id: string;
  anon_key: string;
  service_key: string;
}

export interface ProjectBranchesListResult {
  branches: ProjectBranchDto[];
}

export interface ProjectBranchRenewOptions {
  ttlDays?: number;
}
