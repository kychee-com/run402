import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import { waitFor } from "../wait.js";
import type {
  BuzzEventRoute,
  BuzzEventRouteDetail,
  BuzzRouteDelivery,
  BuzzRouteDeliveryList,
  BuzzRouteDeliveryStatus,
  BuzzRouteRotation,
  BuzzRouteTestDelivery,
  CreateBuzzEventRouteInput,
  CreatedBuzzEventRoute,
  ListBuzzRouteDeliveriesOptions,
  RevokedBuzzEventRoute,
  TestAndWaitBuzzRouteOptions,
  UpdateBuzzEventRoutePatch,
} from "./buzz-notifications.types.js";
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

/** A delivery that will never change again. Everything else is still in flight. */
const TERMINAL_DELIVERY_STATUSES: ReadonlySet<BuzzRouteDeliveryStatus> = new Set([
  "delivered",
  "dead_letter",
  "cancelled",
  "suppressed",
]);

function routePath(routeId: string, context: string): string {
  return `/buzz-project-event-routes/v1/${encodeURIComponent(required(routeId, "routeId", context))}`;
}

/**
 * `buzz.notifications` — project-event routing into a Buzz community channel
 * (gateway `add-buzz-project-event-routing`).
 *
 * A route is an owner-declared destination: one active community
 * installation, an explicit 1–50 project scope, reviewed event filters, one
 * NIP-29 channel. Run402's project-event feed stays authoritative — Buzz
 * relay state never creates, acknowledges, or advances a Run402 event, and
 * Buzz is NEVER a deadman channel: mandatory notification classes keep their
 * human paths regardless of route state.
 *
 * The workflow is **configure → authorize → test → live**:
 *
 * ```ts
 * const created = await r.buzz.notifications.createRoute(orgId, {
 *   installationId: "buzzci_…",
 *   routeName: "deploys",
 *   buzzChannelId: "<nip-29 channel id>",
 *   projectIds: ["prj_…"],
 * });
 * if (created.authorization.status === "pending_buzz_authorization") {
 *   // The ONE non-secret handoff: a Buzz community owner adds
 *   // created.authorization.notification_pubkey as a relay member
 *   // (created.authorization.instructions says exactly how), then:
 *   const delivery = await r.buzz.notifications.testAndWait(
 *     created.buzz_project_event_route_id,
 *   );
 *   // delivered ⇒ live. Still queued ⇒ the tick publishes ~every 60s —
 *   // silence here is cadence, not failure; keep polling deliveries.
 * }
 * ```
 *
 * Load-bearing semantics:
 * - Only three reviewed event types are routable (`deploy_activated`,
 *   `error_fingerprints_observed`, `platform_incident`); the classes
 *   `security` / `billing_critical` / `destructive_lifecycle` /
 *   `verification` / `recovery` may never be routed.
 * - Filters: omitted/`null` = everything registered; an explicit `[]` is a
 *   422, never a wildcard and never a silent match-nothing.
 * - Every mutation carries an `Idempotency-Key` (auto-generated when not
 *   given) and requires fresh `buzz.event_route` step-up server-side (a SIWX
 *   wallet is inherently fresh).
 * - No response ever contains the signing secret — `notification_pubkey` +
 *   `signing_generation` are the only credential material on the wire.
 * - Routes deliver NEW events only (`start_after_event_id` floor); delivery
 *   is at-least-once with byte-identical republish, backing off to
 *   `dead_letter` after 8 attempts / 48h — visible in `deliveries()`.
 */
export class BuzzNotifications {
  constructor(private readonly client: Client) {}

  /**
   * Create a route (`POST /buzz-project-event-routes/v1`, 201). The response
   * carries an `authorization` block: the installation's first route is
   * `pending_buzz_authorization` with the exact non-secret connect handoff a
   * Buzz community owner completes; later routes on an already-authorized
   * installation come back `authorized` and active.
   */
  async createRoute(organizationId: string, input: CreateBuzzEventRouteInput): Promise<CreatedBuzzEventRoute> {
    const context = "creating Buzz event route";
    rejectSecrets(input);
    if (!Array.isArray(input?.projectIds) || input.projectIds.length === 0) {
      throw new LocalError("projectIds must name at least one project — a route's scope is always explicit", context, {
        details: { field: "projectIds" },
      });
    }
    return this.client.request<CreatedBuzzEventRoute>("/buzz-project-event-routes/v1", {
      method: "POST",
      headers: headers(input.idempotencyKey),
      body: {
        org_id: required(organizationId, "organizationId", context),
        buzz_community_installation_id: required(input.installationId, "installationId", context),
        route_name: required(input.routeName, "routeName", context),
        buzz_channel_id: required(input.buzzChannelId, "buzzChannelId", context),
        project_ids: input.projectIds,
        ...(input.eventTypes !== undefined ? { event_types: input.eventTypes } : {}),
        ...(input.eventClasses !== undefined ? { event_classes: input.eventClasses } : {}),
      },
      context,
    });
  }

  /** List the organization's routes, including retained revoked ones. */
  async list(organizationId: string): Promise<BuzzEventRoute[]> {
    const response = await this.client.request<{ buzz_project_event_routes: BuzzEventRoute[] }>(
      `/buzz-project-event-routes/v1?org_id=${encodeURIComponent(required(organizationId, "organizationId", "listing Buzz event routes"))}`,
      { context: "listing Buzz event routes" },
    );
    return response.buzz_project_event_routes ?? [];
  }

  /**
   * Route detail: the route plus honest `health` (derived from route +
   * credential state, never queue emptiness), `delivery_counts`, the oldest
   * pending time, and the shared `consumer_cursor`.
   */
  async get(routeId: string): Promise<BuzzEventRouteDetail> {
    const context = "reading Buzz event route";
    return this.client.request<BuzzEventRouteDetail>(routePath(routeId, context), { context });
  }

  /**
   * Update name / channel / project scope / filters
   * (`PATCH /:id` with `expected_revision`). A stale revision fails
   * `409 BUZZ_ROUTE_REVISION_STALE` without mutating — re-read, re-decide,
   * re-send with the current `revision`.
   */
  async update(routeId: string, patch: UpdateBuzzEventRoutePatch, expectedRevision: number): Promise<BuzzEventRoute> {
    const context = "updating Buzz event route";
    rejectSecrets(patch);
    if (!Number.isInteger(expectedRevision)) {
      throw new LocalError("expectedRevision must be the route's current integer revision", context, {
        details: { field: "expectedRevision" },
      });
    }
    return this.client.request<BuzzEventRoute>(routePath(routeId, context), {
      method: "PATCH",
      headers: headers(patch.idempotencyKey),
      body: {
        expected_revision: expectedRevision,
        ...(patch.routeName !== undefined ? { route_name: patch.routeName } : {}),
        ...(patch.buzzChannelId !== undefined ? { buzz_channel_id: patch.buzzChannelId } : {}),
        ...(patch.projectIds !== undefined ? { project_ids: patch.projectIds } : {}),
        ...(patch.eventTypes !== undefined ? { event_types: patch.eventTypes } : {}),
        ...(patch.eventClasses !== undefined ? { event_classes: patch.eventClasses } : {}),
      },
      context,
    });
  }

  /**
   * Stop matching new events (`POST /:id/pause`). Non-terminal deliveries
   * freeze; events occurring while paused are never retroactively delivered.
   */
  async pause(routeId: string, idempotencyKey?: string): Promise<BuzzEventRoute> {
    const context = "pausing Buzz event route";
    return this.client.request<BuzzEventRoute>(`${routePath(routeId, context)}/pause`, {
      method: "POST",
      headers: headers(idempotencyKey),
      body: {},
      context,
    });
  }

  /**
   * Re-arm delivery and reset the hard-failure counter (`POST /:id/resume`).
   * Requires a live signing credential NOW — resuming into
   * signing-unavailable fails `503 BUZZ_NOTIFICATION_SIGNING_UNAVAILABLE`
   * rather than fabricating an "active" route whose every attempt fails.
   */
  async resume(routeId: string, idempotencyKey?: string): Promise<BuzzEventRoute> {
    const context = "resuming Buzz event route";
    return this.client.request<BuzzEventRoute>(`${routePath(routeId, context)}/resume`, {
      method: "POST",
      headers: headers(idempotencyKey),
      body: {},
      context,
    });
  }

  /**
   * Revoke (`DELETE /:id`): queued deliveries are cancelled, sanitized history
   * stays readable, and `notification_credential_destroyed` reports whether
   * this was the installation's last live route (only then does its
   * notification credential die — never out from under a sibling).
   */
  async revoke(routeId: string, idempotencyKey?: string): Promise<RevokedBuzzEventRoute> {
    const context = "revoking Buzz event route";
    return this.client.request<RevokedBuzzEventRoute>(routePath(routeId, context), {
      method: "DELETE",
      headers: headers(idempotencyKey),
      context,
    });
  }

  /**
   * Stage the NEXT signing generation (`POST /:id/rotate`, 202). The current
   * key keeps signing; the swap activates only after the next pubkey's own
   * Buzz-side NIP-43 membership verifies — the `rotation` block carries the
   * next pubkey, the authorize hint, and the `verify_path` to poke.
   */
  async rotate(routeId: string, idempotencyKey?: string): Promise<BuzzRouteRotation> {
    const context = "rotating Buzz notification credential";
    return this.client.request<BuzzRouteRotation>(`${routePath(routeId, context)}/rotate`, {
      method: "POST",
      headers: headers(idempotencyKey),
      body: {},
      context,
    });
  }

  /**
   * Queue one signed test delivery (`POST /:id/test`, 202 + Retry-After).
   * On a `pending_authorization` route this FIRST re-checks the Buzz-side
   * NIP-43 membership and activates the route when it landed — the test
   * endpoint doubles as the authorization poll. The 202 is queued-not-
   * delivered (Faithful): poll `poll.path` (or use {@link testAndWait}).
   */
  async test(routeId: string, idempotencyKey?: string): Promise<BuzzRouteTestDelivery> {
    const context = "creating Buzz route test delivery";
    return this.client.request<BuzzRouteTestDelivery>(`${routePath(routeId, context)}/test`, {
      method: "POST",
      headers: headers(idempotencyKey),
      body: {},
      context,
    });
  }

  /** Keyset newest-first delivery history — dead letters included, the signed envelope never. */
  async deliveries(routeId: string, opts: ListBuzzRouteDeliveriesOptions = {}): Promise<BuzzRouteDeliveryList> {
    const context = "listing Buzz route deliveries";
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.deliveryId) params.set("delivery_id", opts.deliveryId);
    const query = params.size ? `?${params.toString()}` : "";
    return this.client.request<BuzzRouteDeliveryList>(`${routePath(routeId, context)}/deliveries${query}`, {
      context,
    });
  }

  /**
   * Queue a test delivery, then poll it until it settles — the whole
   * verify-the-route flow in one call.
   *
   * Returns as soon as the delivery reaches a terminal status
   * (`delivered` | `dead_letter` | `cancelled` | `suppressed`). On timeout
   * the still-queued delivery is RETURNED, never thrown (the shared `waitFor`
   * contract) — and unlike an unanswered escalation, a not-yet-delivered test
   * here is usually just cadence: the single-consumer tick publishes ~every
   * 60s, so keep polling `deliveries()` before concluding anything is wrong.
   */
  async testAndWait(routeId: string, opts: TestAndWaitBuzzRouteOptions = {}): Promise<BuzzRouteTestDelivery | BuzzRouteDelivery> {
    const queued = await this.test(routeId);
    // The 202 is the FIRST observed state — it is the only one carrying the
    // poll block, so an observer that narrates (the CLI) must see it even
    // when the wait settles instantly.
    opts.onPoll?.(queued);
    if (TERMINAL_DELIVERY_STATUSES.has(queued.status)) return queued;
    const deliveryId = queued.buzz_project_event_delivery_id;
    const { state } = await waitFor<BuzzRouteDelivery>(
      async () => {
        const page = await this.deliveries(routeId, { deliveryId, limit: 1 });
        return page.buzz_project_event_deliveries?.[0] ?? queued;
      },
      (d) => TERMINAL_DELIVERY_STATUSES.has(d.status),
      {
        pollMs: Math.max(opts.pollMs ?? 5_000, 2_000),
        timeoutMs: opts.timeoutMs ?? 3 * 60 * 1000,
        onPoll: opts.onPoll ? (s) => opts.onPoll!(s as BuzzRouteDelivery) : undefined,
      },
    );
    return state;
  }
}

export class Buzz {
  readonly humanAdoptions: BuzzHumanAdoptions;
  readonly humanAdoptionOffers: BuzzHumanAdoptionOffers;
  readonly communityInstallations: BuzzCommunityInstallations;
  readonly enrollments: BuzzAgentEnrollments;
  readonly notifications: BuzzNotifications;

  constructor(private readonly client: Client) {
    this.humanAdoptions = new BuzzHumanAdoptions(client);
    this.humanAdoptionOffers = new BuzzHumanAdoptionOffers(client);
    this.communityInstallations = new BuzzCommunityInstallations(client);
    this.enrollments = new BuzzAgentEnrollments(client);
    this.notifications = new BuzzNotifications(client);
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
