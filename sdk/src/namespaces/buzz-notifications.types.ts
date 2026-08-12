/**
 * Wire types for `buzz.notifications` — project-event routing into a Buzz
 * community channel (gateway `add-buzz-project-event-routing`,
 * `/buzz-project-event-routes/v1`).
 *
 * Every field is the gateway's `snake_case` wire shape, passed through
 * unchanged. Timestamps are ISO 8601. `org_id` is the bare dashed UUID
 * (never `org_`-prefixed). Route ids are `buzzper_…`, delivery ids `buzzped_…`.
 *
 * No type here ever carries credential material: the `notification_pubkey`
 * and `signing_generation` are the ONLY credential-adjacent fields any
 * response exposes — the signing secret lives KMS-encrypted on the gateway
 * and no read path selects it.
 */

export type BuzzEventRouteStatus = "pending_authorization" | "active" | "paused" | "revoked";

/**
 * `owner` = an explicit pause; `delivery_failures` = the gateway auto-paused
 * after ten consecutive hard publish failures (a mandatory
 * `buzz_route_auto_paused` operator notification fired alongside).
 */
export type BuzzEventRoutePauseReason = "owner" | "delivery_failures";

/**
 * Derived from ROUTE + CREDENTIAL state, never from queue emptiness — a
 * paused/pending/signing-unavailable route is never "healthy because its
 * queue is empty".
 */
export type BuzzEventRouteHealth =
  | "active"
  | "paused"
  | "pending_authorization"
  | "signing_unavailable"
  | "revoked";

export type BuzzNotificationPrincipalStatus = "pending_authorization" | "active" | "revoked";

export type BuzzRouteDeliveryStatus =
  | "queued"
  | "retryable"
  | "delivered"
  | "suppressed"
  | "dead_letter"
  | "cancelled";

export interface BuzzEventRoute {
  buzz_project_event_route_id: string;
  /** Bare dashed UUID — NOT `org_`-prefixed. */
  org_id: string;
  buzz_community_installation_id: string;
  route_name: string;
  /** The NIP-29 channel id deliveries post into. */
  buzz_channel_id: string;
  /** Explicit 1–50 project scope; future/transferred projects never join automatically. */
  project_ids: string[];
  /** null = every registered routable type (never an implicit `[]`). */
  event_types: string[] | null;
  /** null = every non-forbidden class. */
  event_classes: string[] | null;
  status: BuzzEventRouteStatus;
  pause_reason: BuzzEventRoutePauseReason | null;
  paused_at: string | null;
  /** Optimistic-concurrency revision; echo it as `expectedRevision` on update. */
  revision: number;
  /** The outbox floor captured at creation — routes deliver NEW events only. */
  start_after_event_id: number;
  consecutive_hard_failures: number;
  notification_principal_id: string;
  /** The installation's Nostr notification pubkey (hex) — public by design. */
  notification_pubkey: string;
  signing_generation: number;
  created_at: string;
  updated_at: string;
  /** Revoked routes stay READABLE (sanitized history); only mutations reject them. */
  revoked_at: string | null;
}

/**
 * The one exact non-secret handoff. When `pending_buzz_authorization`, a Buzz
 * community owner or admin must add `notification_pubkey` as a relay member
 * using already-released Buzz surfaces; POST the `verify_path` afterwards to
 * verify the membership landed (which activates the route).
 */
export type BuzzRouteAuthorization =
  | { status: "authorized"; notification_pubkey: string }
  | {
      status: "pending_buzz_authorization";
      notification_pubkey: string;
      /** e.g. `buzz-admin add-member --pubkey <hex>`. */
      connect_command: string;
      /** Verbatim human instructions for the community owner. */
      instructions: string;
      /** The test route — POSTing it verifies the authorization landed. */
      verify_path: string;
    };

/** `201` from create: the route plus its authorization handoff. */
export interface CreatedBuzzEventRoute extends BuzzEventRoute {
  authorization: BuzzRouteAuthorization;
}

/** Route detail (`GET /:id`) — the route plus honest operational state. */
export interface BuzzEventRouteDetail extends BuzzEventRoute {
  health: BuzzEventRouteHealth;
  notification_principal_status: BuzzNotificationPrincipalStatus;
  /** Counts by delivery state; every state present, zero-filled. */
  delivery_counts: Record<BuzzRouteDeliveryStatus, number>;
  oldest_pending_created_at: string | null;
  newest_project_event_id: number | null;
  /**
   * The shared outbox consumer's cursor. `null` is the honest pre-wiring
   * state (the consumer row appears once the tick registers itself) — a
   * position is never fabricated.
   */
  consumer_cursor: number | null;
}

/** `DELETE /:id` result — revoke keeps sanitized history readable. */
export interface RevokedBuzzEventRoute extends BuzzEventRoute {
  /**
   * True when this was the installation's LAST live route, so the
   * installation-scoped notification credential was destroyed with it —
   * never out from under a live sibling route.
   */
  notification_credential_destroyed: boolean;
}

/**
 * `202` from rotate: the NEXT signing generation is STAGED, not active. The
 * swap activates only after the next pubkey's own Buzz-side NIP-43 membership
 * verifies (the tick reconcile, or POSTing `verify_path`).
 */
export interface BuzzRouteRotation {
  buzz_project_event_route_id: string;
  rotation: {
    status: "pending_buzz_authorization";
    next_signing_generation: number;
    next_notification_pubkey: string;
    authorize_hint: string;
    verify_path: string;
  };
}

export interface BuzzRouteDelivery {
  buzz_project_event_delivery_id: string;
  kind: "event" | "test";
  status: BuzzRouteDeliveryStatus;
  event_type: string;
  project_id: string;
  /** null for synthetic test deliveries. */
  project_event_id: number | null;
  occurred_at: string;
  /** Stable across retries — the stored envelope republishes byte-identically. */
  nostr_event_id: string | null;
  projection_hash: string | null;
  signing_generation: number | null;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  suppressed_reason: string | null;
  created_at: string;
  delivered_at: string | null;
  terminal_at: string | null;
}

/**
 * `202` from test: queued, NOT delivered (Faithful — the single-consumer tick
 * publishes it, typically within ~60s). `poll.path` is the deliveries read
 * scoped to this delivery id.
 */
export interface BuzzRouteTestDelivery extends BuzzRouteDelivery {
  poll: { path: string };
}

/** Keyset newest-first delivery history — dead letters included, the signed envelope never. */
export interface BuzzRouteDeliveryList {
  buzz_project_event_deliveries: BuzzRouteDelivery[];
  has_more: boolean;
  /** Opaque keyset continuation; absent on the last page. Store and echo; never parse. */
  next_cursor?: string;
}

export interface CreateBuzzEventRouteInput {
  /** An ACTIVE community installation (`buzzci_…`) owned by the org. */
  installationId: string;
  /** Unique per installation among non-revoked routes (1–100 chars). */
  routeName: string;
  /** The NIP-29 channel id to post into. */
  buzzChannelId: string;
  /** 1–50 named projects owned by the org. */
  projectIds: string[];
  /**
   * Omitted/null routes every registered routable type
   * (`deploy_activated`, `error_fingerprints_observed`, `platform_incident`).
   * An explicit `[]` is rejected (422) — it matches nothing, never everything.
   */
  eventTypes?: string[] | null;
  /**
   * Omitted/null routes every non-forbidden class. `security`,
   * `billing_critical`, `destructive_lifecycle`, `verification`, and
   * `recovery` may never be routed. `[]` is rejected like `eventTypes`.
   */
  eventClasses?: string[] | null;
  /** Auto-generated when omitted — every route mutation is idempotent. */
  idempotencyKey?: string;
}

export interface UpdateBuzzEventRoutePatch {
  routeName?: string;
  buzzChannelId?: string;
  projectIds?: string[];
  /** `null` clears the filter back to "every registered type"; `[]` is rejected. */
  eventTypes?: string[] | null;
  eventClasses?: string[] | null;
  idempotencyKey?: string;
}

export interface ListBuzzRouteDeliveriesOptions {
  /** 1–200; the gateway defaults to 50. */
  limit?: number;
  /** Opaque `next_cursor` from a previous page. */
  cursor?: string;
  /** Scope the read to one `buzzped_…` id — the test-delivery poll shape. */
  deliveryId?: string;
}

export interface TestAndWaitBuzzRouteOptions {
  /** Delay between polls (default 5s; the gateway's Retry-After is 2s). */
  pollMs?: number;
  /**
   * Total budget (default 3 minutes — the publisher tick runs ~every 60s, so
   * a healthy test usually lands within one tick). On expiry the LAST
   * OBSERVED delivery is RETURNED, still queued — never thrown.
   */
  timeoutMs?: number;
  /**
   * Called with the `202` test response FIRST (the only state carrying
   * `poll`), then with each polled delivery state.
   */
  onPoll?: (state: BuzzRouteTestDelivery | BuzzRouteDelivery) => void;
}
