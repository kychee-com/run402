/** Types and constants for GitHub Actions OIDC federation (`/ci/v1/*`). */

export const CI_GITHUB_ACTIONS_PROVIDER = "github-actions" as const;
export const CI_GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com" as const;
export const CI_AUDIENCE = "https://api.run402.com" as const;
export const DEFAULT_CI_DELEGATION_CHAIN_ID = "eip155:84532" as const;

export const V1_CI_ALLOWED_ACTIONS = ["deploy"] as const;
export const V1_CI_ALLOWED_EVENTS_DEFAULT = ["push", "workflow_dispatch"] as const;

export type CiProvider = typeof CI_GITHUB_ACTIONS_PROVIDER;
export type CiAllowedAction = (typeof V1_CI_ALLOWED_ACTIONS)[number];
export type CiAllowedEvent =
  | (typeof V1_CI_ALLOWED_EVENTS_DEFAULT)[number]
  | (string & {});

export type CiBindingErrorCode =
  | "nonce_replay"
  | "delegation_statement_mismatch"
  | "delegation_resource_uri_mismatch"
  | "signer_mismatch"
  | "delegation_oversized"
  | "delegation_parse_failed"
  | "delegation_signature_invalid"
  | "delegation_nonce_invalid"
  | "duplicate";

export type CiTokenExchangeErrorCode =
  | "invalid_request"
  | "invalid_token"
  | "access_denied"
  | "event_not_allowed"
  | "repository_id_mismatch"
  | "ambiguous_binding";

export type CiDeployErrorCode =
  | "payment_required"
  | "insufficient_scope"
  | "forbidden_spec_field"
  | "forbidden_plan";

export type CiErrorCode =
  | CiBindingErrorCode
  | CiTokenExchangeErrorCode
  | CiDeployErrorCode
  | (string & {});

export interface ParsedDelegation {
  payload: Record<string, unknown>;
  raw: string;
  signer: string;
  verified_at: string;
}

export interface CiBindingRow {
  id: string;
  project_id: string;
  issuer: string;
  subject_match: string;
  allowed_actions: string[];
  allowed_events: string[];
  github_repository_id: string | null;
  created_by: string;
  nonce: string;
  created_sig?: ParsedDelegation | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
}

export interface CiCreateBindingInput {
  project_id: string;
  provider: CiProvider;
  subject_match: string;
  allowed_actions: readonly CiAllowedAction[];
  allowed_events: readonly CiAllowedEvent[];
  github_repository_id?: string | null;
  expires_at?: string | null;
  nonce: string;
  signed_delegation: string;
}

export interface CiListBindingsInput {
  project: string;
}

export interface CiListBindingsResult {
  bindings: CiBindingRow[];
}

export interface CiTokenExchangeInput {
  project_id: string;
  subject_token: string;
}

export interface CiTokenExchangeRequestBody extends CiTokenExchangeInput {
  grant_type: "urn:ietf:params:oauth:grant-type:token-exchange";
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt";
}

export interface CiTokenExchangeResponse {
  access_token: string;
  token_type: "Bearer" | (string & {});
  expires_in: number;
  scope: string;
}

export interface CiDelegationValues {
  project_id: string;
  issuer?: string;
  audience?: string;
  subject_match: string;
  allowed_actions: readonly string[];
  allowed_events: readonly string[];
  expires_at?: string | null;
  github_repository_id?: string | null;
  nonce: string;
}

export interface NormalizedCiDelegationValues {
  project_id: string;
  issuer: string;
  audience: string;
  subject_match: string;
  allowed_actions: CiAllowedAction[];
  allowed_events: string[];
  expires_at: string | null;
  github_repository_id: string | null;
  nonce: string;
}
