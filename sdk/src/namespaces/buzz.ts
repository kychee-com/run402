import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  BuzzAgentEnrollment,
  BuzzAgentEnrollmentApprovalInput,
  BuzzAgentEnrollmentCreateInput,
  BuzzAgentEnrollmentStatus,
  BuzzCapabilityStatus,
  BuzzCommunityAuthorityProof,
  BuzzCommunityInstallation,
  BuzzCommunityInstallationCreateInput,
  BuzzCommunityInstallationUpdateInput,
  BuzzHumanAdoption,
  BuzzHumanAdoptionAttemptCreateInput,
  BuzzHumanAdoptionCreateInput,
  BuzzHumanAdoptionOffer,
  BuzzHumanAdoptionOfferCreateInput,
  BuzzPublicCommunityDescriptor,
  BuzzPrincipalControlPlaneStatus,
} from "./buzz.types.js";

const SECRET_FIELD = /(?:private.?key|secret|mnemonic|seed|derivation|nsec|nostr.?key|service.?key|delegate.?token|recovery.?code)/i;

function rejectSecrets(value: unknown, path = "$", seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecrets(entry, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key)) {
      throw new LocalError("Buzz private keys, credentials, and recovery material are never accepted", "preparing Buzz control-plane request", {
        code: "BUZZ_SECRET_INPUT_FORBIDDEN",
        details: { field: `${path}.${key}` },
      });
    }
    rejectSecrets(entry, `${path}.${key}`, seen);
  }
}

function required(value: string, field: string, context: string): string {
  if (!value || typeof value !== "string") throw new LocalError(`${field} is required`, context, { details: { field } });
  return value;
}

function headers(idempotencyKey?: string): Record<string, string> {
  return { "Idempotency-Key": idempotencyKey ?? globalThis.crypto.randomUUID() };
}

export class BuzzHumanAdoptions {
  constructor(private readonly client: Client) {}

  async create(input: BuzzHumanAdoptionCreateInput): Promise<BuzzHumanAdoption> {
    rejectSecrets(input);
    return this.client.request<BuzzHumanAdoption>("/buzz-human-adoptions/v1", {
      method: "POST",
      headers: headers(input.idempotencyKey),
      body: {
        org_id: required(input.organizationId, "organizationId", "starting Buzz human adoption"),
        identity_link_id: required(input.identityLinkId, "identityLinkId", "starting Buzz human adoption"),
      },
      context: "starting Buzz human adoption",
    });
  }

  async list(organizationId: string): Promise<BuzzHumanAdoption[]> {
    const response = await this.client.request<{ buzz_human_adoptions: BuzzHumanAdoption[] }>(
      `/buzz-human-adoptions/v1?org_id=${encodeURIComponent(required(organizationId, "organizationId", "listing Buzz human adoptions"))}`,
      { context: "listing Buzz human adoptions" },
    );
    return response.buzz_human_adoptions ?? [];
  }

  async get(id: string): Promise<BuzzHumanAdoption> {
    return this.client.request<BuzzHumanAdoption>(`/buzz-human-adoptions/v1/${encodeURIComponent(required(id, "buzzHumanAdoptionId", "reading Buzz human adoption"))}`, { context: "reading Buzz human adoption" });
  }

  async complete(id: string, ownerProofEvent: unknown, idempotencyKey?: string): Promise<BuzzHumanAdoption> {
    rejectSecrets(ownerProofEvent);
    return this.client.request<BuzzHumanAdoption>(`/buzz-human-adoptions/v1/${encodeURIComponent(required(id, "buzzHumanAdoptionId", "completing Buzz human adoption"))}/complete`, {
      method: "POST",
      headers: headers(idempotencyKey),
      body: { owner_proof_event: ownerProofEvent },
      context: "completing Buzz human adoption",
    });
  }

  async cancel(id: string, idempotencyKey?: string): Promise<BuzzHumanAdoption> {
    return this.client.request<BuzzHumanAdoption>(`/buzz-human-adoptions/v1/${encodeURIComponent(required(id, "buzzHumanAdoptionId", "cancelling Buzz human adoption"))}`, {
      method: "DELETE",
      headers: headers(idempotencyKey),
      context: "cancelling Buzz human adoption",
    });
  }
}

/** Durable agent-created HTTPS handoffs. Creating an offer is inert; the human
 * receives authority only after a separately authenticated, passkey-stepped-up
 * browser attempt completes with the exact Buzz proof. */
export class BuzzHumanAdoptionOffers {
  constructor(private readonly client: Client) {}

  async create(input: BuzzHumanAdoptionOfferCreateInput): Promise<BuzzHumanAdoptionOffer> {
    rejectSecrets(input);
    return this.client.request<BuzzHumanAdoptionOffer>("/buzz-human-adoption-offers/v1", {
      method: "POST",
      headers: headers(input.idempotencyKey),
      body: {
        org_id: required(input.organizationId, "organizationId", "creating Buzz human-adoption offer"),
        identity_link_id: required(input.identityLinkId, "identityLinkId", "creating Buzz human-adoption offer"),
        ...(input.deploymentContext ? { deployment_context: input.deploymentContext } : {}),
      },
      context: "creating Buzz human-adoption offer",
    });
  }

  async get(id: string): Promise<BuzzHumanAdoptionOffer> {
    return this.client.request<BuzzHumanAdoptionOffer>(`/buzz-human-adoption-offers/v1/${encodeURIComponent(required(id, "buzzHumanAdoptionOfferId", "reading Buzz human-adoption offer"))}`, {
      context: "reading Buzz human-adoption offer",
    });
  }

  async cancel(id: string, idempotencyKey?: string): Promise<BuzzHumanAdoptionOffer> {
    return this.client.request<BuzzHumanAdoptionOffer>(`/buzz-human-adoption-offers/v1/${encodeURIComponent(required(id, "buzzHumanAdoptionOfferId", "cancelling Buzz human-adoption offer"))}`, {
      method: "DELETE",
      headers: headers(idempotencyKey),
      context: "cancelling Buzz human-adoption offer",
    });
  }

  async createAttempt(id: string, input: BuzzHumanAdoptionAttemptCreateInput): Promise<BuzzHumanAdoption> {
    rejectSecrets(input);
    return this.client.request<BuzzHumanAdoption>(`/buzz-human-adoption-offers/v1/${encodeURIComponent(required(id, "buzzHumanAdoptionOfferId", "creating Buzz human-adoption attempt"))}/attempts`, {
      method: "POST",
      headers: headers(input.idempotencyKey),
      body: { callback_url: required(input.callbackUrl, "callbackUrl", "creating Buzz human-adoption attempt") },
      context: "creating Buzz human-adoption attempt",
    });
  }
}

export class BuzzCommunityInstallations {
  constructor(private readonly client: Client) {}

  async create(input: BuzzCommunityInstallationCreateInput): Promise<BuzzCommunityInstallation> {
    rejectSecrets(input);
    return this.client.request<BuzzCommunityInstallation>("/buzz-community-installations/v1", {
      method: "POST",
      headers: headers(input.idempotencyKey),
      body: {
        org_id: required(input.organizationId, "organizationId", "starting Buzz community installation"),
        buzz_community_subject: required(input.buzzCommunitySubject, "buzzCommunitySubject", "starting Buzz community installation"),
        buzz_community_authority_subject: required(input.buzzCommunityAuthoritySubject, "buzzCommunityAuthoritySubject", "starting Buzz community installation"),
        ...(input.enrollmentPolicy ? { enrollment_policy: input.enrollmentPolicy } : {}),
      },
      context: "starting Buzz community installation",
    });
  }

  async list(organizationId: string): Promise<BuzzCommunityInstallation[]> {
    const response = await this.client.request<{ buzz_community_installations: BuzzCommunityInstallation[] }>(
      `/buzz-community-installations/v1?org_id=${encodeURIComponent(required(organizationId, "organizationId", "listing Buzz community installations"))}`,
      { context: "listing Buzz community installations" },
    );
    return response.buzz_community_installations ?? [];
  }

  async get(id: string): Promise<BuzzCommunityInstallation> {
    return this.client.request<BuzzCommunityInstallation>(`/buzz-community-installations/v1/${encodeURIComponent(required(id, "buzzCommunityInstallationId", "reading Buzz community installation"))}`, { context: "reading Buzz community installation" });
  }

  async activate(id: string, authorityProof: BuzzCommunityAuthorityProof, idempotencyKey?: string): Promise<BuzzCommunityInstallation> {
    rejectSecrets(authorityProof);
    return this.client.request<BuzzCommunityInstallation>(`/buzz-community-installations/v1/${encodeURIComponent(required(id, "buzzCommunityInstallationId", "activating Buzz community installation"))}/activate`, {
      method: "POST",
      headers: headers(idempotencyKey),
      body: { authority_proof: authorityProof },
      context: "activating Buzz community installation",
    });
  }

  async update(id: string, input: BuzzCommunityInstallationUpdateInput): Promise<BuzzCommunityInstallation> {
    rejectSecrets(input);
    return this.client.request<BuzzCommunityInstallation>(`/buzz-community-installations/v1/${encodeURIComponent(required(id, "buzzCommunityInstallationId", "updating Buzz community installation"))}`, {
      method: "PATCH",
      headers: headers(input.idempotencyKey),
      body: {
        default_for_enrollment: input.defaultForEnrollment,
        enrollment_policy: input.enrollmentPolicy,
        policy_revision: input.policyRevision,
      },
      context: "updating Buzz community installation",
    });
  }

  async revoke(id: string, idempotencyKey?: string): Promise<BuzzCommunityInstallation> {
    return this.client.request<BuzzCommunityInstallation>(`/buzz-community-installations/v1/${encodeURIComponent(required(id, "buzzCommunityInstallationId", "revoking Buzz community installation"))}`, {
      method: "DELETE",
      headers: headers(idempotencyKey),
      context: "revoking Buzz community installation",
    });
  }

  async discoverPublicDescriptors(buzzCommunitySubject: string): Promise<BuzzPublicCommunityDescriptor[]> {
    const response = await this.client.request<{ buzz_community_installation_descriptors: BuzzPublicCommunityDescriptor[] }>(
      `/buzz-community-installation-descriptors/v1?buzz_community_subject=${encodeURIComponent(required(buzzCommunitySubject, "buzzCommunitySubject", "discovering public Buzz community descriptors"))}`,
      { withAuth: false, context: "discovering public Buzz community descriptors" },
    );
    return response.buzz_community_installation_descriptors ?? [];
  }

  async getPublicDescriptor(id: string): Promise<BuzzPublicCommunityDescriptor> {
    return this.client.request<BuzzPublicCommunityDescriptor>(`/buzz-community-installation-descriptors/v1/${encodeURIComponent(required(id, "buzzCommunityInstallationId", "reading public Buzz community descriptor"))}`, {
      withAuth: false,
      context: "reading public Buzz community descriptor",
    });
  }
}

export class BuzzAgentEnrollments {
  constructor(private readonly client: Client) {}

  async request(input: BuzzAgentEnrollmentCreateInput): Promise<BuzzAgentEnrollment> {
    rejectSecrets(input);
    return this.client.request<BuzzAgentEnrollment>("/buzz-agent-enrollments/v1", {
      method: "POST",
      headers: headers(input.idempotencyKey),
      body: {
        buzz_community_installation_id: required(input.buzzCommunityInstallationId, "buzzCommunityInstallationId", "requesting Buzz agent enrollment"),
        identity_link_id: required(input.identityLinkId, "identityLinkId", "requesting Buzz agent enrollment"),
        requested_grants: input.requestedGrants,
        expires_at: required(input.expiresAt, "expiresAt", "requesting Buzz agent enrollment"),
      },
      context: "requesting Buzz agent enrollment",
    });
  }

  async list(options: { organizationId?: string; status?: BuzzAgentEnrollmentStatus } = {}): Promise<BuzzAgentEnrollment[]> {
    const query = new URLSearchParams();
    if (options.organizationId) query.set("org_id", options.organizationId);
    if (options.status) query.set("status", options.status);
    const suffix = query.size ? `?${query.toString()}` : "";
    const response = await this.client.request<{ buzz_agent_enrollments: BuzzAgentEnrollment[] }>(`/buzz-agent-enrollments/v1${suffix}`, { context: "listing Buzz agent enrollments" });
    return response.buzz_agent_enrollments ?? [];
  }

  async get(id: string): Promise<BuzzAgentEnrollment> {
    return this.client.request<BuzzAgentEnrollment>(`/buzz-agent-enrollments/v1/${encodeURIComponent(required(id, "buzzAgentEnrollmentId", "reading Buzz agent enrollment"))}`, { context: "reading Buzz agent enrollment" });
  }

  async approve(id: string, input: BuzzAgentEnrollmentApprovalInput): Promise<BuzzAgentEnrollment> {
    rejectSecrets(input);
    return this.client.request<BuzzAgentEnrollment>(`/buzz-agent-enrollments/v1/${encodeURIComponent(required(id, "buzzAgentEnrollmentId", "approving Buzz agent enrollment"))}/approve`, {
      method: "POST",
      headers: headers(input.idempotencyKey),
      body: {
        approved_grants: input.approvedGrants,
        installation_descriptor_revision: input.installationDescriptorRevision,
        installation_policy_revision: input.installationPolicyRevision,
      },
      context: "approving Buzz agent enrollment",
    });
  }

  async deny(id: string, reason?: string, idempotencyKey?: string): Promise<BuzzAgentEnrollment> {
    return this.client.request<BuzzAgentEnrollment>(`/buzz-agent-enrollments/v1/${encodeURIComponent(required(id, "buzzAgentEnrollmentId", "denying Buzz agent enrollment"))}/deny`, {
      method: "POST",
      headers: headers(idempotencyKey),
      body: reason === undefined ? {} : { reason },
      context: "denying Buzz agent enrollment",
    });
  }

  async revoke(id: string, idempotencyKey?: string): Promise<BuzzAgentEnrollment> {
    return this.client.request<BuzzAgentEnrollment>(`/buzz-agent-enrollments/v1/${encodeURIComponent(required(id, "buzzAgentEnrollmentId", "revoking or cancelling Buzz agent enrollment"))}`, {
      method: "DELETE",
      headers: headers(idempotencyKey),
      context: "revoking or cancelling Buzz agent enrollment",
    });
  }
}

export class Buzz {
  readonly humanAdoptions: BuzzHumanAdoptions;
  readonly humanAdoptionOffers: BuzzHumanAdoptionOffers;
  readonly communityInstallations: BuzzCommunityInstallations;
  readonly enrollments: BuzzAgentEnrollments;

  constructor(private readonly client: Client) {
    this.humanAdoptions = new BuzzHumanAdoptions(client);
    this.humanAdoptionOffers = new BuzzHumanAdoptionOffers(client);
    this.communityInstallations = new BuzzCommunityInstallations(client);
    this.enrollments = new BuzzAgentEnrollments(client);
  }

  /** Capability-detecting status. Older gateways return a safe supported:false result. */
  async status(): Promise<BuzzCapabilityStatus> {
    const whoami = await this.client.request<Record<string, unknown>>("/agent/v1/whoami", { context: "reading Buzz control-plane status" });
    const buzz = whoami.buzz;
    if (!buzz || typeof buzz !== "object" || Array.isArray(buzz)) {
      return { supported: false, protocol: "run402.buzz-control-plane.v1", reason: "gateway_not_supported", buzz: null, whoami };
    }
    return { supported: true, protocol: "run402.buzz-control-plane.v1", buzz: buzz as unknown as BuzzPrincipalControlPlaneStatus, whoami };
  }

  /** Goal-shaped alias for the canonical adoption initiation. */
  adopt(input: BuzzHumanAdoptionCreateInput): Promise<BuzzHumanAdoption> {
    return this.humanAdoptions.create(input);
  }

  /** Create the canonical conversational HTTPS handoff without starting consent. */
  offerAdoption(input: BuzzHumanAdoptionOfferCreateInput): Promise<BuzzHumanAdoptionOffer> {
    return this.humanAdoptionOffers.create(input);
  }

  /** Goal-shaped alias for the canonical community installation initiation. */
  install(input: BuzzCommunityInstallationCreateInput): Promise<BuzzCommunityInstallation> {
    return this.communityInstallations.create(input);
  }

  /** Goal-shaped alias for the canonical agent enrollment request. */
  enroll(input: BuzzAgentEnrollmentCreateInput): Promise<BuzzAgentEnrollment> {
    return this.enrollments.request(input);
  }
}
