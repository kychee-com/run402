// === Project types ===

export interface ProjectInfo {
  id: string;
  name: string;
  schemaSlot: string;
  tier: TierName;
  status: ProjectStatus;
  anonKey: string;
  serviceKey: string;
  apiCalls: number;
  storageBytes: number;
  leaseStartedAt: Date;
  leaseExpiresAt: Date;
  txHash?: string;
  createdAt: Date;
}

export type ProjectStatus = "active" | "archived" | "expired" | "deleted";
export type TierName = "prototype" | "hobby" | "team";

export interface TierConfig {
  price: string;
  leaseDays: number;
  storageMb: number;
  apiCalls: number;
  description: string;
}

// === Auth types ===

export interface UserRecord {
  id: string;
  projectId: string;
  email: string;
  createdAt: Date;
}

export interface TokenPayload {
  sub?: string;
  role: "anon" | "authenticated" | "service_role";
  project_id: string;
  iss: string;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  projectId: string;
  expiresAt: Date;
  used: boolean;
}

// === API response types ===

export interface CreateProjectResponse {
  project_id: string;
  url: string;
  anon_key: string;
  service_key: string;
  schema_slot: string;
  tier: TierName;
  lease_expires_at: string;
}

export interface UsageResponse {
  project_id: string;
  tier: TierName;
  api_calls: number;
  api_calls_limit: number;
  storage_bytes: number;
  storage_limit_bytes: number;
  lease_expires_at: string;
  status: ProjectStatus;
}

export interface SchemaInfo {
  tables: TableInfo[];
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  rls_enabled: boolean;
  policies: PolicyInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default_value: string | null;
}

export interface ConstraintInfo {
  name: string;
  type: string;
  definition: string;
}

export interface PolicyInfo {
  name: string;
  command: string;
  roles: string[];
  using_expression: string | null;
  check_expression: string | null;
}

// === Metering types ===

export interface MeteringCounter {
  projectId: string;
  apiCalls: number;
  lastFlushed: number;
}
