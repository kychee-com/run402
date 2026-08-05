export interface LinkedIdentityRepresentation {
  identity_link_id: string;
  proof_protocol:
    | "run402.identity-link.nostr.v1"
    | "run402.identity-link.nostr.human.v1"
    | (string & {});
  kind: "nostr_nip01" | (string & {});
  public_subject: string;
  display_subject: string;
  verified_at: string;
  status: "active" | "revoked";
  effective_status: "active" | "revoked" | "principal_inactive";
  revoked_at: string | null;
}

export interface PrincipalRepresentation {
  principal_id: string;
  principal_type: "human" | "agent" | "ci" | "system" | (string & {});
  display_name: string | null;
  linked_identities: LinkedIdentityRepresentation[];
}

export interface ActiveAuthenticatorRepresentation {
  authenticator_id: string;
  kind: string;
  public_subject: string;
}

export interface AuthenticatorSnapshot {
  authenticator_id: string;
  kind: string;
  public_subject: string;
}

export interface LinkedIdentitySnapshot {
  identity_link_id: string;
  kind: "nostr" | (string & {});
  public_subject: string;
  display_subject: string;
  verified_at: string;
  status_at_capture: "active";
}

export interface PrincipalSnapshot {
  principal_id: string;
  principal_type: "human" | "agent" | "ci" | "system" | (string & {});
  display_name_at_capture: string | null;
  linked_identities_at_capture: LinkedIdentitySnapshot[];
}

export type AuthoritySnapshot =
  | { kind: "organization_membership"; organization_id: string; membership_id: string; role: string }
  | { kind: "project_grant"; organization_id: string; project_id: string; grant_id: string; scope: string[] }
  | { kind: "delegate"; organization_id: string; project_id: string; grant_id: string; delegate_id: string; scope: string[] }
  | { kind: "ci"; organization_id: string; project_id: string; credential_id: string }
  | { kind: "system"; reason_code: string }
  | { kind: "legacy" }
  | { kind: string; [key: string]: unknown };

export interface OperationActorSnapshot {
  schema_version: 1;
  principal: PrincipalSnapshot | null;
  authenticator: AuthenticatorSnapshot | null;
  authority: AuthoritySnapshot;
  captured_at: string;
}

export interface NostrEventV1 {
  id: string;
  pubkey: string;
  created_at: number; // Signed NIP-01 Unix seconds; converting it changes the event id and signature.
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface IdentityLinkChallenge {
  identity_link_challenge_id: string;
  proof_protocol: "run402.identity-link.nostr.v1";
  visibility: "public";
  nostr_pubkey: string;
  npub: string;
  public_payload: string;
  issued_at: string;
  challenge_expires_at: string;
  disclosure: {
    permanence: "public_and_durable";
    published_fields: string[];
    warning: string;
  };
  next_actions: Array<Record<string, unknown>>;
}

export interface PreparedIdentityLinkChallenge extends IdentityLinkChallenge {
  wallet_address: string;
  wallet_signature: string;
  proof_content: string;
}

export interface IdentityLinkProofCommon {
  identity_link_id: string;
  status: "active" | "revoked";
  effective_status: "active" | "revoked" | "principal_inactive";
  verified_at: string;
  revoked_at: string | null;
  public_subject: string;
  display_subject: string;
  proved_principal: {
    principal_id: string;
    principal_type: "human" | "agent" | "ci" | "system" | (string & {});
  };
  effective_principal: {
    principal_id: string;
    principal_type: "human" | "agent" | "ci" | "system" | (string & {});
  };
  nostr_event: NostrEventV1;
}

export interface AgentIdentityLinkProof extends IdentityLinkProofCommon {
  proof_protocol: "run402.identity-link.nostr.v1";
  public_payload: string;
  wallet_signature: string;
  verification_statement: null;
}

export interface HumanIdentityLinkVerificationStatement {
  schema_version: 1;
  acceptance_context: "standalone_human_link" | "buzz_human_adoption";
  adopting_principal: "run402_verified";
  target_session: "run402_verified" | "legacy_run402_verified";
  fresh_passkey: "run402_verified";
  verified_at: string;
}

export interface HumanIdentityLinkProof extends IdentityLinkProofCommon {
  proof_protocol: "run402.identity-link.nostr.human.v1";
  public_payload: null;
  wallet_signature: null;
  verification_statement: HumanIdentityLinkVerificationStatement;
}

/** Public attribution only. Neither variant is an authenticator or authority edge. */
export type IdentityLinkProof = AgentIdentityLinkProof | HumanIdentityLinkProof;

export interface IdentityLinkListResult {
  identity_links: LinkedIdentityRepresentation[];
  next_cursor: string | null;
}
