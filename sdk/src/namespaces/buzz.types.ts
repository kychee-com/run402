export type BuzzHumanAdoptionStatus = "pending" | "completed" | "expired" | "cancelled";
export type BuzzHumanAdoptionOfferStatus = "available" | "completed" | "cancelled" | "ineligible";
export type BuzzHumanAdoptionOfferIneligibleReason =
  | "agent_inactive"
  | "agent_not_sole_owner"
  | "human_owner_exists"
  | "identity_link_inactive"
  | "owner_attestation_missing"
  | "active_adoption_exists"
  | "direct_adoption_pending";
export type BuzzCommunityInstallationStatus = "pending" | "active" | "expired" | "revoked";
export type BuzzAgentEnrollmentStatus = "pending" | "active" | "denied" | "expired" | "cancelled" | "revoked";
export type BuzzEnrollmentMode = "manual" | "automatic";
export type BuzzGrantCapability =
  | "read"
  | "deploy"
  | "project:archives:export"
  | "functions:write"
  | "secrets:read"
  | "secrets:write"
  | "domains:write"
  | "mailbox:write";

export interface BuzzNextAction {
  type: string;
  method?: string;
  path?: string;
  field?: string;
  auth: string;
  why: string;
  safe_to_auto_execute: boolean;
  requires_approval: boolean;
  destructive: boolean;
  idempotent: boolean;
  spend_impact: { currency: "USD"; max_amount: "0" };
}

export interface BuzzNostrEvent {
  id: string;
  pubkey: string;
  created_at: number; // Signed NIP-01 Unix seconds; converting it changes the event id and signature.
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface BuzzCommunityAuthorityProof {
  buzz_community_subject: string;
  approval_event: BuzzNostrEvent;
  relay_url: string;
}

export interface BuzzSafePolicySummary {
  mode: BuzzEnrollmentMode;
  requires_current_community_membership: true;
  allowed_capabilities: BuzzGrantCapability[] | null;
  max_grant_ttl_seconds: number | null;
}

export interface BuzzEnrollmentPolicy {
  mode: BuzzEnrollmentMode;
  requires_current_community_membership: true;
  allowed_capabilities?: BuzzGrantCapability[];
  max_grant_ttl_seconds?: number;
}

export interface BuzzCommunityDescriptor {
  api_origin: string;
  buzz_community_installation_id: string;
  buzz_community_subject: string;
  content_hash: string;
  default_for_enrollment: boolean;
  descriptor_revision: number;
  issued_at: string;
  org_id: string;
  provider: "run402";
  safe_policy_summary: BuzzSafePolicySummary;
  status: "active" | "revoked";
}

export interface BuzzHumanAdoption {
  buzz_human_adoption_id: string;
  buzz_human_adoption_offer_id?: string | null;
  org_id: string;
  initiating_agent_principal_id?: string;
  identity_link_id?: string;
  initiating_agent_identity_link_id?: string;
  human_identity_link_id?: string | null;
  expected_buzz_owner_subject?: string;
  status: BuzzHumanAdoptionStatus;
  owner_proof_content: {
    deep_link: string;
    challenge_id: string;
    nonce: string;
    verification_code: string;
    audience: "buzz:nostr-identity";
    action: "bind_nostr_identity";
    protocol: "buzz-nostr-identity";
    version: "1";
    origin: string;
    expires_at: string;
    return: "clipboard" | "browser_fragment_v1";
    callback_url: string | null;
  } | null;
  owner_proof_event_id: string | null;
  adopting_human_principal_id: string | null;
  target_human_principal_id?: string | null;
  membership_id: string | null;
  authority_effects: {
    human_membership_role: "owner";
    initiating_agent_membership_changed: false;
    organization_ownership_transferred: false;
    projects_transferred: false;
    credentials_shared: false;
  } | null;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  activated_at: string | null;
  completed_at: string | null;
  expired_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  drift: Record<string, unknown>[];
  next_actions: BuzzNextAction[];
}

export interface BuzzCommunityInstallation {
  buzz_community_installation_id: string;
  org_id: string;
  buzz_community_subject: string;
  buzz_community_authority_subject?: string;
  relay_url?: string;
  relay_self: string | null;
  status: BuzzCommunityInstallationStatus;
  descriptor: BuzzCommunityDescriptor | null;
  approval_event_id: string | null;
  authority_membership_event_id: string | null;
  descriptor_revision: number;
  descriptor_hash: string | null;
  default_for_enrollment: boolean;
  enrollment_policy: BuzzEnrollmentPolicy;
  policy_revision: number;
  evidence_observed_at: string | null;
  authority_proof_content: {
    challenge_id: string;
    nonce: string;
    verification_code: string;
    descriptor_state: "proposed";
    descriptor: BuzzCommunityDescriptor;
    event_kind: 1;
    event_content: string;
    publish_with: string;
    relay_url: string;
    origin: string;
    expires_at: string;
  } | null;
  issued_at: string;
  expires_at: string;
  activated_at: string | null;
  expired_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  drift: Record<string, unknown>[];
  next_actions: BuzzNextAction[];
  unaffected_effects?: { active_enrollments: number; active_project_grants: number };
}

export interface BuzzPublicCommunityDescriptor extends BuzzCommunityDescriptor {
  approval_event: BuzzNostrEvent;
  authority_membership: {
    event_id: string;
    event_created_at: string;
    role: "owner" | "admin";
    observed_at: string;
  };
  relay_self: string;
}

export interface BuzzProjectGrantRequest {
  project_id: string;
  capability: BuzzGrantCapability;
  policy?: Record<string, unknown>;
  expires_at: string;
}

export interface BuzzAgentEnrollment {
  buzz_agent_enrollment_id: string;
  buzz_community_installation_id: string;
  org_id: string;
  requesting_agent_principal_id?: string;
  identity_link_id?: string;
  identity_public_subject?: string;
  status: BuzzAgentEnrollmentStatus;
  requested_grants: BuzzProjectGrantRequest[];
  approved_grants: BuzzProjectGrantRequest[] | null;
  project_grant_ids: string[];
  identity_evidence: Record<string, unknown>;
  installation_descriptor_revision: number;
  installation_policy_revision: number;
  expires_at: string;
  decided_by_principal_id: string | null;
  decision_reason: string | null;
  activated_at: string | null;
  denied_at: string | null;
  expired_at: string | null;
  cancelled_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  drift: Record<string, unknown>[];
  next_actions: BuzzNextAction[];
  revoked_project_grant_count?: number;
}

export interface BuzzHumanAdoptionCreateInput {
  organizationId: string;
  identityLinkId: string;
  idempotencyKey?: string;
}

export interface BuzzHumanAdoptionDeploymentContext {
  project_id: string;
  release_id: string;
  live_url: string;
  source_revision: string;
  verified_at: string;
}

export interface BuzzHumanAdoptionOffer {
  buzz_human_adoption_offer_id: string;
  org_id: string;
  initiating_agent_principal_id: string;
  identity_link_id: string;
  expected_buzz_owner: {
    nostr_subject: string;
    evidence: "nip_oa_owner_attestation";
    authoritative_for_run402: false;
  };
  status: BuzzHumanAdoptionOfferStatus;
  handoff_url: string | null;
  deployment_context: BuzzHumanAdoptionDeploymentContext | null;
  current_buzz_human_adoption_id: string | null;
  completed_buzz_human_adoption: {
    buzz_human_adoption_id: string;
    status: "completed";
    consent_receipt: {
      status: "completed";
      completed_at: string | null;
    };
    public_identity_attribution: {
      human_identity_link_id: string | null;
      authority_for_organization: false;
      revoke_independently: true;
    };
    organization_authority: {
      membership_id: string | null;
      role: "owner";
      source: "org_membership";
      revoke_independently: true;
    };
    authority_effects: NonNullable<BuzzHumanAdoption["authority_effects"]>;
  } | null;
  latest_attempt_receipt?: {
    attempt_reference: string;
    status: BuzzHumanAdoptionStatus;
    issued_at: string | null;
    expires_at: string | null;
    expired_at: string | null;
    cancelled_at: string | null;
    activated_at: string | null;
    diagnosis_code: string;
    last_observed_stage: string | null;
    last_trace_id: string | null;
    milestones: Array<{
      stage: string;
      observed_at: string;
      trace_id?: string;
      result_code?: string;
    }>;
  } | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  ineligible_at: string | null;
  ineligible_reason: BuzzHumanAdoptionOfferIneligibleReason | null;
  next_actions: BuzzNextAction[];
}

export interface BuzzHumanAdoptionOfferCreateInput {
  organizationId: string;
  identityLinkId: string;
  deploymentContext?: BuzzHumanAdoptionDeploymentContext;
  idempotencyKey?: string;
}

export interface BuzzHumanAdoptionAttemptCreateInput {
  callbackUrl: string;
  idempotencyKey?: string;
}

export interface BuzzCommunityInstallationCreateInput {
  organizationId: string;
  buzzCommunitySubject: string;
  buzzCommunityAuthoritySubject: string;
  enrollmentPolicy?: BuzzEnrollmentPolicy;
  idempotencyKey?: string;
}

export interface BuzzCommunityInstallationUpdateInput {
  defaultForEnrollment: boolean;
  enrollmentPolicy: BuzzEnrollmentPolicy;
  policyRevision: number;
  idempotencyKey?: string;
}

export interface BuzzAgentEnrollmentCreateInput {
  buzzCommunityInstallationId: string;
  identityLinkId: string;
  requestedGrants: BuzzProjectGrantRequest[];
  expiresAt: string;
  idempotencyKey?: string;
}

export interface BuzzAgentEnrollmentApprovalInput {
  approvedGrants: BuzzProjectGrantRequest[];
  installationDescriptorRevision: number;
  installationPolicyRevision: number;
  idempotencyKey?: string;
}

export interface BuzzCapabilityStatus {
  supported: boolean;
  protocol: "run402.buzz-control-plane.v1";
  reason?: "gateway_not_supported";
  buzz: BuzzPrincipalControlPlaneStatus | null;
  whoami: Record<string, unknown>;
}

export interface BuzzPrincipalControlPlaneStatus {
  skill_installation: { status: "client_managed" };
  capabilities?: {
    human_adoption_offers?: boolean;
    browser_fragment_v1?: boolean;
  };
  human_adoption_offers?: Array<{
    buzz_human_adoption_offer_id: string;
    org_id: string;
    status: BuzzHumanAdoptionOfferStatus;
    handoff_url: string | null;
  }>;
  human_adoptions: Array<{
    buzz_human_adoption_id: string;
    org_id: string;
    status: BuzzHumanAdoptionStatus;
  }>;
  community_installations: Array<{
    buzz_community_installation_id: string;
    org_id: string;
    status: BuzzCommunityInstallationStatus;
    default_for_enrollment: boolean;
  }>;
  agent_enrollments: Array<{
    buzz_agent_enrollment_id: string;
    buzz_community_installation_id: string;
    status: BuzzAgentEnrollmentStatus;
  }>;
  eligibility: {
    can_start_identity_link_without_organization: boolean;
    can_select_community_installation: boolean;
    has_nonterminal_enrollment: boolean;
    cold_start_fallback_available: boolean;
  };
  drift: Record<string, unknown>[];
  next_actions: BuzzNextAction[];
}
