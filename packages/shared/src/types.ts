// === Project types ===

export interface DemoConfig {
  max_row_inserts: number;
  max_auth_users: number;
  max_storage_files: number;
  max_row_deletes: number;
  max_function_invocations: number;
  reset_interval_hours: number;
  allow_edits: boolean;
  allow_deletes: boolean;
  banner_text: string;
}

export const DEFAULT_DEMO_CONFIG: DemoConfig = {
  max_row_inserts: 50,
  max_auth_users: 3,
  max_storage_files: 5,
  max_row_deletes: 20,
  max_function_invocations: 100,
  reset_interval_hours: 4,
  allow_edits: true,
  allow_deletes: true,
  banner_text: "Live demo — shared, resets every 4 hours. Fork for your own permanent copy.",
};

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
  txHash?: string;
  walletAddress?: string;
  pinned: boolean;
  createdAt: Date;
  demoMode: boolean;
  demoConfig?: DemoConfig;
  demoSourceVersionId?: string;
  demoLastResetAt?: Date;
  allowPasswordSet: boolean;
}

export type ProjectStatus =
  | "active"
  | "past_due"
  | "frozen"
  | "dormant"
  | "purging"
  | "purged"
  | "archived"
  | "expired"
  | "deleted";
export type TierName = "prototype" | "hobby" | "team";

export interface TierConfig {
  price: string;
  priceUsdMicros: number;
  leaseDays: number;
  storageMb: number;
  apiCalls: number;
  maxFunctions: number;
  functionTimeoutSec: number;
  functionMemoryMb: number;
  maxSecrets: number;
  emailsPerDay: number;
  uniqueRecipientsPerLease: number;
  maxScheduledFunctions: number;
  minScheduleIntervalMinutes: number;
  description: string;
}

// === Auth types ===

export interface UserRecord {
  id: string;
  projectId: string;
  email: string;
  emailVerifiedAt?: Date;
  displayName?: string;
  avatarUrl?: string;
  lastSignInAt?: Date;
  createdAt: Date;
}

export interface OAuthProviderInfo {
  name: string;
  enabled: boolean;
  display_name: string;
}

export interface OAuthIdentity {
  provider: string;
  provider_sub: string;
  provider_email?: string;
  created_at: Date;
}

export interface TokenPayload {
  sub?: string;
  role: "anon" | "authenticated" | "service_role" | "project_admin";
  project_id: string;
  email?: string;
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
}

export interface UsageResponse {
  project_id: string;
  tier: TierName;
  api_calls: number;
  api_calls_limit: number;
  storage_bytes: number;
  storage_limit_bytes: number;
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

// === Wallet tier types ===

export interface WalletTierInfo {
  wallet: string;
  tier: TierName | null;
  lease_started_at: string | null;
  lease_expires_at: string | null;
  active: boolean;
  pool_usage: {
    projects: number;
    total_api_calls: number;
    total_storage_bytes: number;
    api_calls_limit: number;
    storage_bytes_limit: number;
  };
}

// === Metering types ===

export interface MeteringCounter {
  projectId: string;
  apiCalls: number;
  lastFlushed: number;
}

// === Functions types ===

export interface ScheduleMeta {
  last_run_at?: string;
  last_status?: number;
  next_run_at?: string | null;
  run_count: number;
  last_error?: string | null;
}

export interface FunctionRecord {
  name: string;
  url: string;
  lambda_arn: string;
  runtime: string;
  timeout: number;
  memory: number;
  code_hash: string;
  deps: string[];
  schedule?: string | null;
  schedule_meta?: ScheduleMeta | null;
  created_at: string;
  updated_at: string;
}

export interface SecretRecord {
  key: string;
  created_at: string;
  updated_at: string;
}
